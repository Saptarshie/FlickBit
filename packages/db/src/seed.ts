import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export const SYSTEM_HANDLE = 'playloop';

/** Idempotent: ensures the official @playloop account exists. Template games are seeded in P1-T3. */
export async function seed(db: PgDatabase<PgQueryResultHKT, typeof schema>): Promise<{ systemUserId: string }> {
  const existing = await db.select().from(schema.users).where(eq(schema.users.handle, SYSTEM_HANDLE));
  if (existing[0]) return { systemUserId: existing[0].id };
  const [u] = await db.insert(schema.users).values({
    handle: SYSTEM_HANDLE, displayName: 'PlayLoop', email: 'system@playloop.local', role: 'admin',
  }).returning();
  return { systemUserId: u!.id };
}
