import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { insertEvents } from './schema/events';

it('events DDL applies and insertEvents writes through the partitioned table', async () => {
  const client = new PGlite({ extensions: { vector } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });

  const ddl = await readFile(fileURLToPath(new URL('../events.sql', import.meta.url)), 'utf8');
  await client.exec(ddl);

  // 6 monthly partitions should exist.
  const parts = await db.execute(sql`select inhrelid::regclass::text as name from pg_inherits where inhparent = 'events'::regclass`);
  expect(parts.rows.length).toBeGreaterThanOrEqual(6);

  await insertEvents(db, [
    { type: 'impression', position: 0, source: 'trending', propensity: 0.5 },
    { type: 'play_start', props: { via: 'feed' } },
  ]);
  const rows = await db.execute(sql`select type, position, source, props from events order by id`);
  expect(rows.rows).toHaveLength(2);
  expect(rows.rows[0]).toMatchObject({ type: 'impression', position: 0, source: 'trending' });
  expect(rows.rows[1]).toMatchObject({ type: 'play_start', props: { via: 'feed' } });

  await client.close();
}, 60_000);
