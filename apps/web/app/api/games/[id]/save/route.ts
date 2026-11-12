import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { games, saves } from '@playloop/db';
import { getDb } from '../../../../../src/lib/db';
import { enforceRateLimit } from '@/lib/api-helpers';
import {
  jsonError,
  jsonOk,
  parseValue,
  requireUser,
  wrap,
} from '../../../../../src/lib/api-helpers';;

const paramsSchema = z.object({ id: z.uuid() });

async function readSaveCount(gameId: string): Promise<number> {
  const rows = await getDb()
    .select({ saveCount: games.saveCount })
    .from(games)
    .where(eq(games.id, gameId));
  return rows[0]?.saveCount ?? 0;
}

export const POST = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  enforceRateLimit(userId, 'save', 60, 60_000);
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);

  const db = getDb();
  const gameRows = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);
  if (gameRows.length === 0) return jsonError('not_found', 'Game not found', 404);

  const inserted = await db
    .insert(saves)
    .values({ userId, gameId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    await db
      .update(games)
      .set({ saveCount: sql`${games.saveCount} + 1` })
      .where(eq(games.id, gameId));
  }
  return jsonOk({ saved: true, saveCount: await readSaveCount(gameId) });
});

export const DELETE = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);

  const db = getDb();
  const gameRows = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);
  if (gameRows.length === 0) return jsonError('not_found', 'Game not found', 404);

  const removed = await db
    .delete(saves)
    .where(and(eq(saves.userId, userId), eq(saves.gameId, gameId)))
    .returning();
  if (removed.length > 0) {
    await db
      .update(games)
      .set({ saveCount: sql`greatest(${games.saveCount} - 1, 0)` })
      .where(eq(games.id, gameId));
  }
  return jsonOk({ saved: false, saveCount: await readSaveCount(gameId) });
});
