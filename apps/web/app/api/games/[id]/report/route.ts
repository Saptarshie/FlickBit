import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { games, reports } from '@playloop/db';
import { getDb } from '../../../../../src/lib/db';
import {
  jsonError,
  jsonOk,
  parseBody,
  parseValue,
  requireUser,
  wrap,
} from '../../../../../src/lib/api-helpers';

const paramsSchema = z.object({ id: z.uuid() });

const reportSchema = z.object({
  reason: z.string().min(1).max(200),
  details: z.string().max(2000).nullish(),
});

export const POST = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);
  const input = await parseBody(req, reportSchema);

  const db = getDb();
  const gameRows = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);
  if (gameRows.length === 0) return jsonError('not_found', 'Game not found', 404);

  const [row] = await db
    .insert(reports)
    .values({
      reporterId: userId,
      targetType: 'game',
      targetId: gameId,
      reason: input.reason,
      details: input.details ?? null,
    })
    .returning();
  if (!row) return jsonError('internal', 'Failed to create report', 500);

  return jsonOk(
    {
      report: {
        id: row.id,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        status: row.status,
        createdAt: row.createdAt,
      },
    },
    201,
  );
});
