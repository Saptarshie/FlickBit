import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { TEMPLATES } from '@playloop/gamekit';
import * as schema from './schema';

export const SYSTEM_HANDLE = 'playloop';

type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type SeedOptions = {
  /** Directory the play-worker serves artifacts from. When set, template artifacts are written here. */
  artifactsDir?: string;
};

export type SeedResult = { systemUserId: string; templateGames: number };

/**
 * Idempotent: ensures the official @playloop account exists, and (when artifactsDir is
 * given) writes each template game as a content-addressed artifact plus its game row, so
 * the feed and the play-worker have real data to serve. Re-running is safe: a template
 * whose id is already present is skipped.
 */
export async function seed(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  const users = await db.select().from(schema.users).where(eq(schema.users.handle, SYSTEM_HANDLE));
  let systemUserId = users[0]?.id;
  if (!systemUserId) {
    const [u] = await db.insert(schema.users).values({
      handle: SYSTEM_HANDLE, displayName: 'PlayLoop', email: 'system@playloop.local', role: 'admin',
    }).returning();
    systemUserId = u!.id;
  }

  let templateGames = 0;
  if (opts.artifactsDir) {
    await mkdir(opts.artifactsDir, { recursive: true });
    for (const t of TEMPLATES) {
      // The game id derives from the template id, so re-seeding never duplicates a template.
      const gameId = templateGameId(t.id);
      const existing = await db.select().from(schema.games).where(eq(schema.games.id, gameId));
      if (existing[0]) continue;

      const bytes = Buffer.from(t.code, 'utf8');
      const sha = createHash('sha256').update(bytes).digest('hex');
      await writeFile(`${opts.artifactsDir}/${sha}.html`, bytes);

      // games.publishedVersionId -> game_versions.id and game_versions.gameId -> games.id
      // reference each other, so the game row goes in first (publishedVersionId null),
      // then the version, then the game is updated to point at it.
      await db.insert(schema.games).values({
        id: gameId, creatorId: systemUserId, title: t.id, description: `Template game: ${t.id}`,
        tags: ['template'], status: 'processing', moderation: 'approved', publishedAt: new Date(),
      });

      const [v] = await db.insert(schema.gameVersions).values({
        gameId, versionNo: 1, artifactSha256: sha, artifactBytes: bytes.byteLength,
        artifactKey: `artifacts/${sha}.html`, manifest: {}, createdBy: 'ai',
      }).returning();

      await db.update(schema.games)
        .set({ publishedVersionId: v!.id, status: 'published' })
        .where(eq(schema.games.id, gameId));
      templateGames++;
    }
  }

  return { systemUserId, templateGames };
}

/** Deterministic uuid-shaped id for a template game so re-seeding is idempotent. */
function templateGameId(templateId: string): string {
  const h = createHash('sha256').update(`playloop-template:${templateId}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}
