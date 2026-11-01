import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { games, scores, users } from '@playloop/db';
import { getDb } from '../../../../../src/lib/db';
import {
  jsonError,
  jsonOk,
  parseValue,
  requireUser,
  wrap,
} from '../../../../../src/lib/api-helpers';

const paramsSchema = z.object({ id: z.uuid() });

const LEADERBOARD_SIZE = 50;

export const GET = wrap<{ id: string }>(async (req, ctx) => {
  await requireUser(req);
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);

  const db = getDb();
  const gameRows = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);
  if (gameRows.length === 0) return jsonError('not_found', 'Game not found', 404);

  const rows = await db
    .select({
      id: scores.id,
      score: scores.score,
      userId: scores.userId,
      createdAt: scores.createdAt,
      handle: users.handle,
      avatarUrl: users.avatarUrl,
    })
    .from(scores)
    .leftJoin(users, eq(scores.userId, users.id))
    .where(eq(scores.gameId, gameId))
    .orderBy(desc(scores.score), asc(scores.createdAt))
    .limit(LEADERBOARD_SIZE);

  const entries = rows.map((row, index) => ({
    rank: index + 1,
    id: row.id,
    score: Number(row.score),
    userId: row.userId,
    user: row.userId
      ? { id: row.userId, handle: row.handle ?? null, avatarUrl: row.avatarUrl ?? null }
      : null,
    createdAt: row.createdAt,
  }));

  return jsonOk({ entries });
});
