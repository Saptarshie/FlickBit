import { and, eq, isNull } from 'drizzle-orm';
import { games, notifications, users } from '@playloop/db';
import type { getDb } from './db';

type Db = ReturnType<typeof getDb>;
type NotificationType = 'like' | 'comment' | 'reply' | 'follow' | 'remix' | 'system';

/**
 * Record an activity notification.
 *
 * Nothing in the app used to write to `notifications`, so the Activity tab was
 * permanently empty and its badge could never clear. Rules:
 *   - never notify yourself;
 *   - collapse duplicate unread rows for the same (recipient, type, actor, game)
 *     so liking ten times does not spam;
 *   - stash the actor handle and game title inside `data`, which is what the
 *     notifications screen renders (it must not need a second round-trip).
 */
export async function notify(
  db: Db,
  input: { userId: string | null | undefined; type: NotificationType; actorId: string; gameId?: string | null },
): Promise<void> {
  const { userId, type, actorId } = input;
  const gameId = input.gameId ?? null;
  if (!userId || userId === actorId) return;

  try {
    const [actor] = await db.select({ handle: users.handle }).from(users).where(eq(users.id, actorId)).limit(1);
    let gameTitle: string | null = null;
    if (gameId) {
      const [game] = await db.select({ title: games.title }).from(games).where(eq(games.id, gameId)).limit(1);
      gameTitle = game?.title ?? null;
    }

    const existing = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, type),
          eq(notifications.actorId, actorId),
          gameId ? eq(notifications.gameId, gameId) : isNull(notifications.gameId),
          isNull(notifications.readAt),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    // `notifications_unread_uq` (migration 0003) makes this atomic: two
    // concurrent likes can no longer create two unread rows.
    await db
      .insert(notifications)
      .values({
        userId,
        type,
        actorId,
        gameId,
        data: { actorHandle: actor?.handle ?? null, gameTitle },
      })
      .onConflictDoNothing();
  } catch (err) {
    // Never fail the user action because a notification could not be written.
    console.error('[notify] failed:', err instanceof Error ? err.message : err);
  }
}
