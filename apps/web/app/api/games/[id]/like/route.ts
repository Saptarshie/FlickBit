import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { games, likes } from '@playloop/db';
import { notify } from '../../../../../src/lib/notify';
import { getDb } from '../../../../../src/lib/db';
import {
  jsonError,
  jsonOk,
  parseValue,
  requireUser,
  wrap,
} from '../../../../../src/lib/api-helpers';

const paramsSchema = z.object({ id: z.uuid() });

async function readLikeCount(gameId: string): Promise<number> {
  const rows = await getDb()
    .select({ likeCount: games.likeCount })
    .from(games)
    .where(eq(games.id, gameId));
  return rows[0]?.likeCount ?? 0;
}

export const POST = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);

  const db = getDb();
  const gameRows = await db
    .select({ id: games.id, creatorId: games.creatorId })
    .from(games)
    .where(eq(games.id, gameId))
    .limit(1);
  const game = gameRows[0];
  if (!game) return jsonError('not_found', 'Game not found', 404);

  const inserted = await db
    .insert(likes)
    .values({ userId, gameId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    await db
      .update(games)
      .set({ likeCount: sql`${games.likeCount} + 1` })
      .where(eq(games.id, gameId));
    await notify(db, { userId: game.creatorId, type: 'like', actorId: userId, gameId });
  }
  return jsonOk({ liked: true, likeCount: await readLikeCount(gameId) });
});

export const DELETE = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);

  const db = getDb();
  const gameRows = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);
  if (gameRows.length === 0) return jsonError('not_found', 'Game not found', 404);

  const removed = await db
    .delete(likes)
    .where(and(eq(likes.userId, userId), eq(likes.gameId, gameId)))
    .returning();
  if (removed.length > 0) {
    await db
      .update(games)
      .set({ likeCount: sql`greatest(${games.likeCount} - 1, 0)` })
      .where(eq(games.id, gameId));
  }
  return jsonOk({ liked: false, likeCount: await readLikeCount(gameId) });
});
