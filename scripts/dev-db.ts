/**
 * Dev database server: a real PostgreSQL wire-protocol endpoint backed by
 * PGlite (Postgres compiled to WASM) with pgvector, so the whole app runs
 * locally with `pnpm dev` and no Docker/Postgres install.
 *
 * Responsibilities:
 *  1. open/create the on-disk PGlite data directory (persistent across runs)
 *  2. apply drizzle migrations + the raw DDL files (events, stats)
 *  3. seed the 8 template games and write their artifacts to disk
 *  4. listen on DATABASE_URL's port for the app's postgres-js client
 *
 * Not for production: production points DATABASE_URL at a real Postgres.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@playloop/db';
import { seed } from '@playloop/db/seed';

const root = fileURLToPath(new URL('..', import.meta.url));

// Load the repo-root .env so DB_PORT etc. behave the same as in the app.
const envPath = path.join(root, '.env');
if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
async function main(): Promise<void> {
  const dataDir = path.join(root, '.data', 'pglite');
  const artifactsDir = path.join(root, 'apps', 'play-worker', 'artifacts');
  const port = Number.parseInt(process.env.DB_PORT ?? '5432', 10);

  await mkdir(dataDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  const pg = await PGlite.create({ dataDir, extensions: { vector } });
  const db = drizzle(pg, { schema });

  // Migrations are idempotent (drizzle tracks applied hashes).
  await migrate(db, { migrationsFolder: path.join(root, 'packages', 'db', 'migrations') });

  const eventsSql = await readFile(path.join(root, 'packages', 'db', 'events.sql'), 'utf8');
  const statsSql = await readFile(path.join(root, 'packages', 'db', 'stats.sql'), 'utf8');
  await pg.exec(eventsSql);
  await pg.exec(statsSql);

  const result = await seed(db as never, { artifactsDir });
  console.log(`[db] seeded: systemUser=${result.systemUserId} newTemplateGames=${result.templateGames}`);

  // EXACTLY ONE connection. PGlite runs every statement on a single engine and
  // keeps one unnamed prepared statement per session; with two sockets the
  // Parse/Bind frames interleave and the server answers with
  //   'bind message supplies 11 parameters, but prepared statement requires 10'
  // or 'unnamed prepared statement does not exist'. Both were random 500s on
  // the feed under concurrency. Serialising at the socket is the only correct
  // option without a real Postgres.
  const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1', maxConnections: 1 });
  await server.start();
  console.log(`[db] postgres wire protocol on postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
  console.log(`[db] artifacts served from ${artifactsDir}`);

  const shutdown = async () => {
    try {
      await server.stop();
    } catch {
      /* ignore */
    }
    await pg.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[db] failed to start:', err);
  process.exit(1);
});
