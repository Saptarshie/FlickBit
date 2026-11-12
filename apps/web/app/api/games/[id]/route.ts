import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@playloop/db';
import { getDb } from '../../../../src/lib/db';
import { auth } from '../../../../auth';
import {
  jsonError,
  jsonOk,
  parseValue,
  requireUser,
  wrap,
} from '../../../../src/lib/api-helpers';

const paramsSchema = z.object({ id: z.uuid() });

const patchSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(10).optional(),
  status: z.enum(['published', 'unlisted', 'draft']).optional(),
});

/**
 * Game detail for the share page /g/[id]: game + creator + counts + viewer
 * state + remix provenance. Soft-deleted games 404.
 */
export const GET = wrap<{ id: string }>(async (req, ctx) => {
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);

  const db = getDb();
  const rows = await db
    .select({
      game: schema.games,
      creatorHandle: schema.users.handle,
      creatorDisplayName: schema.users.displayName,
      creatorAvatarUrl: schema.users.avatarUrl,
      artifactSha256: schema.gameVersions.artifactSha256,
      posterKey: schema.gameVersions.posterKey,
    })
    .from(schema.games)
    .leftJoin(schema.users, eq(schema.users.id, schema.games.creatorId))
    .leftJoin(schema.gameVersions, eq(schema.gameVersions.id, schema.games.publishedVersionId))
    .where(eq(schema.games.id, gameId))
    .limit(1);

  const row = rows[0];
  if (!row || row.game.deletedAt) return jsonError('not_found', 'Game not found', 404);

  const session = (await auth()) as { user?: { id?: string | null } | null } | null;
  const viewerId = session?.user?.id ?? null;

  // A draft is not public: only its creator may read it. (Unlisted is readable
  // by anyone holding the link, removed games are not.)
  const isOwner = viewerId !== null && viewerId === row.game.creatorId;
  const visible = row.game.status === 'published' || row.game.status === 'unlisted';
  if (!isOwner && (!visible || row.game.moderation === 'rejected')) {
    return jsonError('not_found', 'Game not found', 404);
  }

  let viewer = { liked: false, saved: false, followsCreator: false };
  if (viewerId) {
    const [likes, saves, followsRows] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(schema.likes)
        .where(and(eq(schema.likes.userId, viewerId), eq(schema.likes.gameId, gameId))),
      db.select({ n: sql<number>`count(*)::int` }).from(schema.saves)
        .where(and(eq(schema.saves.userId, viewerId), eq(schema.saves.gameId, gameId))),
      db.select({ n: sql<number>`count(*)::int` }).from(schema.follows)
        .where(and(eq(schema.follows.followerId, viewerId), eq(schema.follows.followeeId, row.game.creatorId))),
    ]);
    viewer = {
      liked: (likes[0]?.n ?? 0) > 0,
      saved: (saves[0]?.n ?? 0) > 0,
      followsCreator: viewerId !== row.game.creatorId && (followsRows[0]?.n ?? 0) > 0,
    };
  }

  let forkedFrom: { id: string; title: string } | null = null;
  if (row.game.forkedFromGameId) {
    const parents = await db
      .select({ id: schema.games.id, title: schema.games.title })
      .from(schema.games)
      .where(eq(schema.games.id, row.game.forkedFromGameId))
      .limit(1);
    const parent = parents[0];
    forkedFrom = parent ? { id: parent.id, title: parent.title } : { id: row.game.forkedFromGameId, title: 'a game' };
  }

  const playOrigin = process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://play.localhost:3001';

  return jsonOk({
    game: {
      id: row.game.id,
      title: row.game.title,
      description: row.game.description,
      tags: row.game.tags ?? [],
      status: row.game.status,
      orientation: row.game.orientation,
      publishedAt: row.game.publishedAt,
      createdAt: row.game.createdAt,
      counts: {
        likes: row.game.likeCount,
        saves: row.game.saveCount,
        comments: row.game.commentCount,
        plays: row.game.playCount,
        remixes: row.game.remixCount,
      },
      creator: {
        id: row.game.creatorId,
        handle: row.creatorHandle ?? 'unknown',
        displayName: row.creatorDisplayName,
        avatar: row.creatorAvatarUrl,
      },
      artifactUrl: row.artifactSha256 ? `${playOrigin}/v/${row.artifactSha256}.html` : null,
      posterUrl: row.posterKey ?? null,
      forkedFrom,
      viewer,
    },
  });
});

/**
 * Creator self-service edit: metadata (title/description/tags) and lifecycle
 * (publish/unpublish). Publish requires an attached artifact version; unpublish
 * keeps publishedAt so re-publishing does not reset provenance.
 */
export const PATCH = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);
  const input = parseValue(await req.json().catch(() => null), patchSchema);

  const db = getDb();
  const rows = await db.select().from(schema.games).where(eq(schema.games.id, gameId)).limit(1);
  const game = rows[0];
  if (!game || game.deletedAt) return jsonError('not_found', 'Game not found', 404);
  if (game.creatorId !== userId) return jsonError('forbidden', 'Not your game', 403);

  const updates: Partial<typeof schema.games.$inferInsert> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.tags !== undefined) updates.tags = input.tags;
  if (input.status !== undefined) {
    if (input.status === 'published') {
      if (!game.publishedVersionId) {
        return jsonError('no_version', 'Game has no artifact version to publish', 400);
      }
      updates.status = 'published';
      if (!game.publishedAt) updates.publishedAt = new Date();
    } else {
      updates.status = input.status;
    }
  }
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(schema.games)
    .set(updates)
    .where(eq(schema.games.id, gameId))
    .returning();

  return jsonOk({
    id: updated!.id,
    title: updated!.title,
    description: updated!.description,
    tags: updated!.tags ?? [],
    status: updated!.status,
    publishedAt: updated!.publishedAt,
  });
});
