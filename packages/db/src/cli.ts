import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { seed } from './seed';
import { rollupGameStats } from './rollup';

const cmd = process.argv[2];
const url = process.env.DATABASE_URL ?? 'postgres://playloop:playloop@localhost:5432/playloop';
const client = postgres(url, { max: 1, prepare: false });
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
  } else if (cmd === 'stats') {
    const sql = await readFile(fileURLToPath(new URL('../stats.sql', import.meta.url)), 'utf8');
    await client.unsafe(sql);
    console.log('game_stats_hourly table ready');
  } else if (cmd === 'rollup') {
    const written = await rollupGameStats(db);
    console.log(`rolled up ${written} game-hour buckets`);
  } else {
    console.error('usage: cli.ts migrate|seed|events|stats|rollup'); process.exitCode = 2;
  }
} finally {
  await client.end();
}
