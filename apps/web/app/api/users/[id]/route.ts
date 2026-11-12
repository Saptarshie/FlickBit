import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@playloop/db';
import { getDb } from '../../../../src/lib/db';
import { auth } from '../../../../auth';
import { jsonError, jsonOk, wrap } from '../../../../src/lib/api-helpers';

const paramsSchema = z.object({ id: z.string().min(1) });

/**
 * Handles are matched exactly (case-insensitively), never with LIKE: `/api/users/%`
 * used to return an arbitrary profile because `%` is an ILIKE wildcard. Anything
 * that is not a plain handle is treated as "not found".
 */
function asHandle(value: string): string | null {
  const handle = value.replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9_.-]{3,24}$/.test(handle) ? handle : null;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creator profile: accepts a user uuid or a handle (case-insensitive).
 * Returns the profile, aggregate counts, the viewer's relationship, and the
 * creator's published games (newest first) with remix provenance.
 */
export const GET = wrap<{ id: string }>(async (req, ctx) => {
  const { id } = parseParams(await ctx.params);

  const db = getDb();
  const isUuid = uuidRe.test(id);
  const userRows = await db
    .select()
    .from(schema.users)
    .where(
      isUuid ? eq(schema.users.id, id) : sql`lower(${schema.users.handle}) = ${asHandle(id) ?? ''}`,
    )
    .limit(1);
  const user = userRows[0];
  if (!user || user.deletedAt) {
    return jsonError('not_found', 'User not found', 404);
  }

  const session = (await auth()) as { user?: { id?: string | null } | null } | null;
  const viewerId = session?.user?.id ?? null;

  const [followerCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.follows)
    .where(eq(schema.follows.followeeId, user.id));
  const [followingCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.follows)
    .where(eq(schema.follows.followerId, user.id));

  let viewerFollowing = false;
  if (viewerId && viewerId !== user.id) {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.follows)
      .where(and(eq(schema.follows.followerId, viewerId), eq(schema.follows.followeeId, user.id)));
    viewerFollowing = (rows[0]?.n ?? 0) > 0;
  }

  // Published + feed-eligible games, newest first, with remix provenance.
  const gameRows = await db
    .select({
      id: schema.games.id,
      title: schema.games.title,
      description: schema.games.description,
      tags: schema.games.tags,
      publishedAt: schema.games.publishedAt,
      likeCount: schema.games.likeCount,
      saveCount: schema.games.saveCount,
      commentCount: schema.games.commentCount,
      playCount: schema.games.playCount,
      remixCount: schema.games.remixCount,
      forkedFromId: schema.games.forkedFromGameId,
      artifactSha256: schema.gameVersions.artifactSha256,
      posterKey: schema.gameVersions.posterKey,
    })
    .from(schema.games)
    .leftJoin(schema.gameVersions, eq(schema.gameVersions.id, schema.games.publishedVersionId))
    .where(and(eq(schema.games.creatorId, user.id), eq(schema.games.status, 'published')))
    .orderBy(sql`${schema.games.publishedAt} desc nulls last`)
    // A prolific creator should not ship their whole catalogue in one response.
    .limit(60);

  const playOrigin = process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://play.localhost:3001';

  // Resolve remix parents in one query.
  const parentIds = [...new Set(gameRows.map((g) => g.forkedFromId).filter((v): v is string => Boolean(v)))];
  const parentMap = new Map<string, string>();
  if (parentIds.length > 0) {
    const parents = await db
      .select({ id: schema.games.id, title: schema.games.title })
      .from(schema.games)
      .where(sql`${schema.games.id} in ${parentIds}`);
    for (const p of parents) parentMap.set(p.id, p.title);
  }

  const games = gameRows.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    tags: g.tags ?? [],
    publishedAt: g.publishedAt,
    counts: {
      likes: g.likeCount,
      saves: g.saveCount,
      comments: g.commentCount,
      plays: g.playCount,
      remixes: g.remixCount,
    },
    artifactUrl: g.artifactSha256 ? `${playOrigin}/v/${g.artifactSha256}.html` : null,
    posterUrl: g.posterKey ?? null,
    forkedFrom: g.forkedFromId
      ? { id: g.forkedFromId, title: parentMap.get(g.forkedFromId) ?? 'a game' }
      : null,
  }));

  return jsonOk({
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
    },
    counts: {
      followers: followerCount?.n ?? 0,
      following: followingCount?.n ?? 0,
      games: games.length,
    },
    viewer: { following: viewerFollowing, isSelf: viewerId === user.id },
    games,
  });
});

function parseParams(raw: unknown): { id: string } {
  const result = paramsSchema.safeParse(raw);
  if (!result.success) throw jsonError('validation_error', 'Invalid user id', 400);
  return result.data;
}
