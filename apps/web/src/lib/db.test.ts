import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import * as schema from '@playloop/db';
import { getDb, setTestDb, resetTestDb } from './db';

const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url));

beforeAll(async () => {
  const client = new PGlite({ extensions: { vector } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  setTestDb(db);
}, 60_000);

afterAll(() => {
  resetTestDb();
});

describe('getDb with injected PGlite database', () => {
  it('round-trips a users insert and read', async () => {
    const [inserted] = await getDb()
      .insert(schema.users)
      .values({ handle: 'jane-doe', email: 'jane.doe@example.com' })
      .returning();
    expect(inserted?.id).toBeTruthy();

    const rows = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, inserted!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.handle).toBe('jane-doe');
    expect(rows[0]!.email).toBe('jane.doe@example.com');
  });

  it('returns the injected instance from repeated getDb() calls', () => {
    expect(getDb()).toBe(getDb());
  });
});
