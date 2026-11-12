import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import * as schema from '@playloop/db';
import { getDb } from '@/lib/db';
import { jsonOk, wrap } from '@/lib/api-helpers';

const LIMIT = 30;

/**
 * GET /api/search?q=<text>&tag=<tag>
 *
 * Discovery: matches published games by title/description/tag and creators by
 * handle. Returns both lists so /explore can render one screen.
 */
export const GET = wrap(async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
  const tag = (url.searchParams.get('tag') ?? '').trim().toLowerCase().slice(0, 40);
  const db = getDb();

  const base = and(eq(schema.games.status, 'published'), isNull(schema.games.deletedAt));

  let gamesQuery;
  if (tag) {
    gamesQuery = sql`
      SELECT g.id, g.title, g.description, g.tags, g.like_count, g.play_count,
             gv.artifact_sha256 AS sha, u.handle AS creator_handle
      FROM games g
      JOIN game_versions gv ON gv.id = g.published_version_id
      JOIN users u ON u.id = g.creator_id
      WHERE g.status = 'published' AND g.deleted_at IS NULL AND g.tags @> ARRAY[${tag}]::text[]
      ORDER BY g.play_count DESC, g.published_at DESC
      LIMIT ${LIMIT}
    `;
  } else if (q) {
    const like = `%${q}%`;
    gamesQuery = sql`
      SELECT g.id, g.title, g.description, g.tags, g.like_count, g.play_count,
             gv.artifact_sha256 AS sha, u.handle AS creator_handle
      FROM games g
      JOIN game_versions gv ON gv.id = g.published_version_id
      JOIN users u ON u.id = g.creator_id
      WHERE g.status = 'published' AND g.deleted_at IS NULL
        AND (g.title ILIKE ${like} OR g.description ILIKE ${like} OR g.tags @> ARRAY[${q.toLowerCase()}]::text[])
      ORDER BY g.play_count DESC, g.published_at DESC
      LIMIT ${LIMIT}
    `;
  } else {
    gamesQuery = sql`
      SELECT g.id, g.title, g.description, g.tags, g.like_count, g.play_count,
             gv.artifact_sha256 AS sha, u.handle AS creator_handle
      FROM games g
      JOIN game_versions gv ON gv.id = g.published_version_id
      JOIN users u ON u.id = g.creator_id
      WHERE g.status = 'published' AND g.deleted_at IS NULL
      ORDER BY g.published_at DESC
      LIMIT ${LIMIT}
    `;
  }

  const columns = {
    id: schema.games.id,
    title: schema.games.title,
    description: schema.games.description,
    tags: schema.games.tags,
    likeCount: schema.games.likeCount,
    playCount: schema.games.playCount,
  };

  let creators;
  if (q) {
    creators = await db
      .select({ id: schema.users.id, handle: schema.users.handle, displayName: schema.users.displayName })
      .from(schema.users)
      .where(and(ilike(schema.users.handle, `%${q}%`), isNull(schema.users.deletedAt)))
      .limit(8);
  } else {
    creators = await db
      .select({ id: schema.users.id, handle: schema.users.handle, displayName: schema.users.displayName })
      .from(schema.users)
      .where(isNull(schema.users.deletedAt))
      .orderBy(desc(schema.users.createdAt))
      .limit(8);
  }

  const raw = await db.execute(gamesQuery);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Array<
    Record<string, unknown>
  >;

  const games = rows.map((r) => ({
    id: String(r.id),
    title: String(r.title ?? ''),
    description: String(r.description ?? ''),
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    counts: { likes: Number(r.like_count ?? 0), plays: Number(r.play_count ?? 0) },
    creatorHandle: String(r.creator_handle ?? ''),
    artifactSha: String(r.sha ?? ''),
  }));

  void columns; // keeps the drizzle table refs used above for type inference

  // Trending tags for the empty state: most common tag across published games.
  const tagRows = await db.execute(sql`
    SELECT t AS tag, count(*)::int AS n
    FROM games g, unnest(g.tags) AS t
    WHERE g.status = 'published' AND g.deleted_at IS NULL
    GROUP BY t
    ORDER BY n DESC
    LIMIT 12
  `);
  const tagList = ((Array.isArray(tagRows) ? tagRows : (tagRows as { rows?: unknown[] }).rows ?? []) as Array<{
    tag: string;
    n: number;
  }>).map((r) => ({ tag: String(r.tag), count: Number(r.n) }));

  return jsonOk({ games, creators, tags: tagList, q, tag });
});
