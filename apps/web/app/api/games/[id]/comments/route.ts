import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { comments, games, users } from '@playloop/db';
import { getDb } from '../../../../../src/lib/db';
import { notify } from '../../../../../src/lib/notify';
import { enforceRateLimit } from '@/lib/api-helpers';
import {
  jsonError,
  jsonOk,
  parseBody,
  parseValue,
  requireUser,
  wrap,
} from '../../../../../src/lib/api-helpers';;

const paramsSchema = z.object({ id: z.uuid() });

const createSchema = z.object({
  body: z.string().min(1).max(500),
  parentId: z.uuid().nullish(),
});

type CommentJson = {
  id: string;
  gameId: string;
  parentId: string | null;
  body: string;
  likeCount: number;
  createdAt: string | Date;
  user: { id: string; handle: string | null; avatarUrl: string | null };
  replies: CommentJson[];
};

export const GET = wrap<{ id: string }>(async (req, ctx) => {
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);
  const db = getDb();

  const gameRows = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);
  if (gameRows.length === 0) return jsonError('not_found', 'Game not found', 404);

  const rows = await db
    .select({
      id: comments.id,
      gameId: comments.gameId,
      parentId: comments.parentId,
      body: comments.body,
      likeCount: comments.likeCount,
      createdAt: comments.createdAt,
      userId: users.id,
      handle: users.handle,
      avatarUrl: users.avatarUrl,
    })
    .from(comments)
    .leftJoin(users, eq(comments.userId, users.id))
    .where(and(eq(comments.gameId, gameId), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt), asc(comments.id));

  // One level of nesting: replies attach to their top-level parent.
  const byId = new Map<string, CommentJson>();
  const topLevel: CommentJson[] = [];
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      gameId: row.gameId,
      parentId: row.parentId,
      body: row.body,
      likeCount: row.likeCount,
      createdAt: row.createdAt,
      user: { id: row.userId ?? '', handle: row.handle ?? null, avatarUrl: row.avatarUrl ?? null },
      replies: [],
    });
  }
  for (const row of rows) {
    const comment = byId.get(row.id);
    if (!comment) continue;
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (parent) parent.replies.push(comment);
    else topLevel.push(comment);
  }
  return jsonOk({ comments: topLevel });
});

export const POST = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  enforceRateLimit(userId, 'comment', 10, 60_000, 'comments');
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);
  const input = await parseBody(req, createSchema);

  const db = getDb();
  const gameRows = await db
    .select({ id: games.id, creatorId: games.creatorId })
    .from(games)
    .where(eq(games.id, gameId))
    .limit(1);
  const game = gameRows[0];
  if (!game) return jsonError('not_found', 'Game not found', 404);

  let parentAuthorId: string | null = null;
  if (input.parentId) {
    const parentRows = await db
      .select({
        id: comments.id,
        parentId: comments.parentId,
        deletedAt: comments.deletedAt,
        userId: comments.userId,
      })
      .from(comments)
      .where(and(eq(comments.id, input.parentId), eq(comments.gameId, gameId)))
      .limit(1);
    const parent = parentRows[0];
    if (!parent) return jsonError('bad_request', 'Parent comment not found on this game', 400);
    if (parent.parentId) return jsonError('bad_request', 'Replies can only be one level deep', 400);
    if (parent.deletedAt) return jsonError('bad_request', 'Parent comment was deleted', 400);
    parentAuthorId = parent.userId ?? null;
  }

  const [row] = await db
    .insert(comments)
    .values({ gameId, userId, parentId: input.parentId ?? null, body: input.body })
    .returning();
  if (!row) return jsonError('internal', 'Failed to create comment', 500);

  await db
    .update(games)
    .set({ commentCount: sql`${games.commentCount} + 1` })
    .where(eq(games.id, gameId));

  // Activity: the creator hears about comments on their game; a reply also
  // notifies the person being replied to.
  await notify(db, { userId: game.creatorId, type: 'comment', actorId: userId, gameId });
  if (parentAuthorId) {
    await notify(db, { userId: parentAuthorId, type: 'reply', actorId: userId, gameId });
  }

  const userRows = await db
    .select({ id: users.id, handle: users.handle, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return jsonOk(
    {
      comment: {
        id: row.id,
        gameId: row.gameId,
        parentId: row.parentId,
        body: row.body,
        likeCount: row.likeCount,
        createdAt: row.createdAt,
        user: userRows[0] ?? { id: userId, handle: null, avatarUrl: null },
        replies: [],
      } satisfies CommentJson,
    },
    201,
  );
});
