import { eq } from 'drizzle-orm';
import * as schema from '@playloop/db';
import { auth } from '../../auth';
import { getDb } from '@/lib/db';

/**
 * Resolve the signed-in viewer *and prove the account still exists*.
 *
 * A cookie outlives the database it was issued from: after a reset (or a
 * restore) the JWT stays valid, every screen still renders, and then the first
 * write fails on a foreign key — after a ten minute generation. One indexed
 * lookup turns that into an immediate, honest answer.
 */
export type Viewer =
  | { kind: 'ok'; userId: string }
  | { kind: 'anonymous' }
  /** Signed in, but the account is gone (a reset or a restore happened). */
  | { kind: 'stale'; userId: string };

export async function resolveViewer(): Promise<Viewer> {
  const session = (await auth()) as { user?: { id?: string } | null } | null;
  const userId = session?.user?.id;
  if (!userId) return { kind: 'anonymous' };
  try {
    const rows = await getDb()
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return rows.length > 0 ? { kind: 'ok', userId } : { kind: 'stale', userId };
  } catch {
    // A broken lookup must not read as "signed out" — let the route fail later.
    return { kind: 'ok', userId };
  }
}

export const SESSION_STALE = {
  code: 'session_stale',
  message: 'Your session is from before a data reset. Sign in again — nothing you made was lost.',
} as const;
