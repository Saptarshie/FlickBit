import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@playloop/db';
import { embedText, toVectorLiteral } from '@playloop/ai';
import type { getDb } from '@/lib/db';

type Db = ReturnType<typeof getDb>;

export type PublishInput = {
  creatorId: string;
  sha256: string;
  bytes: number;
  /** The artifact's own pl-manifest — carries the runtime the platform stamped. */
  manifest?: Record<string, unknown>;
  metadata: { title: string; description: string; tags: string[] };
  spec?: unknown;
  /** Existing game for a follow-up turn; omitted for a new game. */
  gameId?: string | null;
  /** Explicit version number; computed from the game when omitted. */
  versionNo?: number;
  forkedFromId?: string | null;
};

export type PublishResult = { gameId: string; versionId: string; versionNo: number; reused: boolean };

/**
 * Store a finished build: game row, version row, embedding.
 *
 * Split out of the generation route so a database failure no longer throws away
 * a ten-minute build: the artifact is already on disk, and the caller can retry
 * this step alone (`POST /api/studio/publish`) with the same bytes.
 *
 * Idempotent by `(game, sha256)`: publishing the same artifact twice returns the
 * existing version instead of tripping the `(game_id, version_no)` unique key.
 */
export async function publishArtifact(db: Db, input: PublishInput): Promise<PublishResult> {
  const { creatorId, sha256, bytes, metadata, spec, manifest = {} } = input;
  let gameId = input.gameId ?? null;
  let versionNo = input.versionNo ?? 1;

  if (gameId) {
    const existing = await db
      .select({ id: schema.gameVersions.id, versionNo: schema.gameVersions.versionNo })
      .from(schema.gameVersions)
      .where(and(eq(schema.gameVersions.gameId, gameId), eq(schema.gameVersions.artifactSha256, sha256)))
      .limit(1);
    if (existing[0]) {
      return { gameId, versionId: existing[0].id, versionNo: existing[0].versionNo, reused: true };
    }
    const [latest] = await db
      .select({ versionNo: schema.gameVersions.versionNo })
      .from(schema.gameVersions)
      .where(eq(schema.gameVersions.gameId, gameId))
      .orderBy(sql`${schema.gameVersions.versionNo} desc`)
      .limit(1);
    if (input.versionNo === undefined) versionNo = (latest?.versionNo ?? 0) + 1;
  }

  // One transaction: a game row must never exist without its version, or it
  // passes every candidate query and is then dropped by the hydration join
  // (the feed silently loses the card).
  const written = await db.transaction(async (tx: Db) => {
    let targetGameId = gameId;

    if (!targetGameId) {
      const [created] = await tx
        .insert(schema.games)
        .values({
          creatorId,
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          status: 'published',
          moderation: 'approved',
          forkedFromGameId: input.forkedFromId ?? null,
          publishedAt: new Date(),
        })
        .returning({ id: schema.games.id });
      targetGameId = created!.id;
    } else {
      await tx
        .update(schema.games)
        .set({ title: metadata.title, description: metadata.description, tags: metadata.tags, updatedAt: new Date() })
        .where(eq(schema.games.id, targetGameId));
    }

    const [version] = await tx
      .insert(schema.gameVersions)
      .values({
        gameId: targetGameId,
        versionNo,
        artifactSha256: sha256,
        artifactBytes: bytes,
        artifactKey: `artifacts/${sha256}.html`,
        // The artifact's own manifest is the source of truth: it carries the
        // runtime the platform stamped, which the feed needs to prefetch the
        // right engine. `metadata` is only the human-facing title/description.
        manifest: { ...manifest, ...metadata, spec },
        createdBy: 'ai',
      })
      .returning({ id: schema.gameVersions.id });

    await tx.update(schema.games).set({ publishedVersionId: version!.id }).where(eq(schema.games.id, targetGameId));

    return { gameId: targetGameId!, versionId: version!.id, versionNo };
  });

  // Embeddings are best-effort: the game is already playable without them.
  try {
    const text = `${metadata.title}. ${metadata.description} ${metadata.tags.join(' ')}`;
    const vec = await embedText(text);
    if (vec) {
      await db.execute(
        sql`INSERT INTO game_features (game_version_id, description_text, text_vec, content_vec, feed_eligible, embedded_at, model_versions)
            VALUES (${written.versionId}, ${text}, ${toVectorLiteral(vec)}::vector, ${toVectorLiteral(vec)}::vector, true, now(), ${JSON.stringify({ embed: process.env.EMBED_MODEL ?? 'embeddinggemma' })}::jsonb)
            ON CONFLICT (game_version_id) DO UPDATE SET text_vec = EXCLUDED.text_vec, content_vec = EXCLUDED.content_vec, feed_eligible = true, embedded_at = now()`,
      );
    }
  } catch (err) {
    console.warn('[publish] embedding skipped:', err instanceof Error ? err.message : err);
  }

  return { ...written, reused: false };
}
