import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jsonError, jsonOk, requireUser, wrap } from '@/lib/api-helpers';

/**
 * GET /api/me/saved — the games the viewer saved, newest save first.
 * Shaped like the feed/search card list so one component can render both.
 */
export const GET = wrap(async (req) => {
  let userId: string;
  try {
    userId = await requireUser(req);
  } catch (err) {
    if (err instanceof Response) {
      return jsonError('unauthorized', 'Sign in to see your saved games', 401);
    }
    throw err;
  }

  const db = getDb();
  const raw = await db.execute(sql`
    SELECT g.id, g.title, g.description, g.tags, g.like_count, g.play_count,
           gv.artifact_sha256 AS sha, u.handle AS creator_handle
    FROM saves s
    JOIN games g ON g.id = s.game_id
    JOIN game_versions gv ON gv.id = g.published_version_id
    JOIN users u ON u.id = g.creator_id
    WHERE s.user_id = ${userId} AND g.deleted_at IS NULL
    ORDER BY s.created_at DESC
    LIMIT 100
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Array<
    Record<string, unknown>
  >;

  return jsonOk({
    games: rows.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      description: String(r.description ?? ''),
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      counts: { likes: Number(r.like_count ?? 0), plays: Number(r.play_count ?? 0) },
      creatorHandle: String(r.creator_handle ?? ''),
      artifactSha: String(r.sha ?? ''),
    })),
  });
});
