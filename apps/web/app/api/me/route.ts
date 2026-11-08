import { and, count, eq, isNull } from 'drizzle-orm';
import { notifications, users } from '@playloop/db';
import { auth } from '../../../auth';
import { getDb } from '@/lib/db';
import { jsonOk, wrap } from '@/lib/api-helpers';

/**
 * GET /api/me — the signed-in viewer (or null) plus lightweight badges the
 * app chrome needs (unread notifications). Never 401s: the shell renders a
 * "Sign in" affordance instead.
 */
export const GET = wrap(async () => {
  const session = (await auth()) as { user?: { id?: string; handle?: string; name?: string | null } } | null;
  const userId = session?.user?.id;
  if (!userId) return jsonOk({ viewer: null, unread: 0 });

  const db = getDb();
  const [row] = await db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));

  if (!row) return jsonOk({ viewer: null, unread: 0 });

  const [unreadRow] = await db
    .select({ unread: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

  return jsonOk({
    viewer: { id: row.id, handle: row.handle, displayName: row.displayName, avatarUrl: row.avatarUrl },
    unread: Number(unreadRow?.unread ?? 0),
  });
});
