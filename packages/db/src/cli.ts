import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { seed } from './seed';

const cmd = process.argv[2];
const url = process.env.DATABASE_URL ?? 'postgres://playloop:playloop@localhost:5432/playloop';
const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

try {
  if (cmd === 'migrate') {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
    console.log('migrated');
  } else if (cmd === 'seed') {
    console.log('seeded', await seed(db));
  } else if (cmd === 'events') {
    const sql = await readFile(fileURLToPath(new URL('../events.sql', import.meta.url)), 'utf8');
    await client.unsafe(sql);
    console.log('events table ready');
  } else {
    console.error('usage: cli.ts migrate|seed|events'); process.exitCode = 2;
  }
} finally {
  await client.end();
}
