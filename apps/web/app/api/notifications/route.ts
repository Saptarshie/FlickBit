import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { notifications } from '@playloop/db';
import { getDb } from '../../../src/lib/db';
import { jsonError, jsonOk, requireUser, wrap } from '../../../src/lib/api-helpers';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const GET = wrap(async (req) => {
  const userId = await requireUser(req);

  const limitRaw = new URL(req.url).searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return jsonError('bad_request', `limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
    }
    limit = parsed;
  }

  const db = getDb();
  const items = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      actorId: notifications.actorId,
      gameId: notifications.gameId,
      data: notifications.data,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);

  const unreadRows = await db
    .select({ unread: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

  return jsonOk({ items, unread: Number(unreadRows[0]?.unread ?? 0) });
});
