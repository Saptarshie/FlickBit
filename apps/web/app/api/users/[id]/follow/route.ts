import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { follows, users } from '@playloop/db';
import { getDb } from '../../../../../src/lib/db';
import {
  jsonError,
  jsonOk,
  parseValue,
  requireUser,
  wrap,
} from '../../../../../src/lib/api-helpers';

const paramsSchema = z.object({ id: z.uuid() });

export const POST = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id: followeeId } = parseValue(await ctx.params, paramsSchema);

  if (followeeId === userId) return jsonError('bad_request', 'You cannot follow yourself', 400);

  const db = getDb();
  const targetRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, followeeId))
    .limit(1);
  if (targetRows.length === 0) return jsonError('not_found', 'User not found', 404);

  await db.insert(follows).values({ followerId: userId, followeeId }).onConflictDoNothing();
  return jsonOk({ following: true }, 201);
});

export const DELETE = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id: followeeId } = parseValue(await ctx.params, paramsSchema);

  await getDb()
    .delete(follows)
    .where(and(eq(follows.followerId, userId), eq(follows.followeeId, followeeId)));
  return jsonOk({ following: false });
});
