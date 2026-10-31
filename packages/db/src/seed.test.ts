import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { seed } from './seed';

it('seed is idempotent', async () => {
  const db = drizzle(new PGlite({ extensions: { vector } }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  const a = await seed(db);
  const b = await seed(db);
  expect(a.systemUserId).toBe(b.systemUserId);
  expect(await db.select().from(schema.users)).toHaveLength(1);
}, 60_000);
