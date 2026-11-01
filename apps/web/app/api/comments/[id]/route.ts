import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { comments, games } from '@playloop/db';
import { getDb } from '../../../../src/lib/db';
import {
  jsonError,
  jsonOk,
  parseValue,
  requireUser,
  wrap,
} from '../../../../src/lib/api-helpers';

const paramsSchema = z.object({ id: z.uuid() });

export const DELETE = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id } = parseValue(await ctx.params, paramsSchema);

  const db = getDb();
  const rows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
    .limit(1);
  const comment = rows[0];
  if (!comment) return jsonError('not_found', 'Comment not found', 404);
  if (comment.userId !== userId) {
    return jsonError('forbidden', 'You can only delete your own comments', 403);
  }

  await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, id));
  await db
    .update(games)
    .set({ commentCount: sql`greatest(${games.commentCount} - 1, 0)` })
    .where(eq(games.id, comment.gameId));

  return jsonOk({ deleted: true });
});
