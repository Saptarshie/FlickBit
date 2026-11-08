import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@playloop/db';

/** Any Drizzle Postgres-compatible database bound to the @playloop/db schema. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let db: Db | null = null;

/**
 * The client is kept on globalThis so Next.js hot reloads (which re-evaluate
 * modules) do not leak a new postgres pool on every edit — the dev PGlite
 * server has a small connection budget and drops the oldest sockets when a
 * reload opens more.
 */
const globalForDb = globalThis as unknown as {
  __playloopSql?: ReturnType<typeof postgres>;
};

/**
 * Lazily create (and memoise) the production Drizzle client over postgres-js,
 * bound to the schema exported by @playloop/db. Tests inject a PGlite-backed
 * instance via setTestDb() instead of pointing at a real server.
 */
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const sql =
      globalForDb.__playloopSql ??
      postgres(url, { max: 4, idle_timeout: 20, max_lifetime: 60 * 10, onnotice: () => {} });
    globalForDb.__playloopSql = sql;
    db = drizzle(sql, { schema });
  }
  return db;
}

/** Inject a test database (e.g. PGlite-backed Drizzle) so getDb() returns it. */
export function setTestDb(testDb: Db): void {
  db = testDb;
}

/** Drop any injected/lazy instance so the next getDb() builds a fresh one. */
export function resetTestDb(): void {
  db = null;
}
