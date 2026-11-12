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
 * The single postgres-js client for the process, shared by Drizzle and by the
 * Auth.js adapter. Sharing matters: the dev database (PGlite) accepts one
 * socket at a time, so a second pool starves the first and both start failing
 * with prepared-statement / ECONNRESET errors.
 */
export function getSql(): ReturnType<typeof postgres> {
  if (!globalForDb.__playloopSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    // `prepare: false` is mandatory here: the dev database is PGlite served
    // over one shared engine, so postgres-js's unnamed prepared statements
    // collide between sockets ("bind message supplies 11 parameters, but
    // prepared statement requires 10") and requests fail at random under
    // concurrency. Simple-protocol queries are safe over a shared session.
    // The dev database is PGlite behind a single-socket server, so exactly one
    // connection. A real Postgres must not inherit that: one socket serialises
    // every request behind the slowest query (a feed page could block the whole
    // app) and drops the server-side plan cache.
    const singleSocket = process.env.PLAYLOOP_SINGLE_SOCKET === '1';
    globalForDb.__playloopSql = postgres(url, {
      max: singleSocket ? 1 : Number(process.env.DATABASE_POOL_MAX ?? 20),
      prepare: !singleSocket,
      connect_timeout: 10,
      idle_timeout: singleSocket ? 2 : 30,
      max_lifetime: 60 * (singleSocket ? 10 : 30),
      onnotice: () => {},
    });
  }
  return globalForDb.__playloopSql;
}

/**
 * Lazily create (and memoise) the production Drizzle client over postgres-js,
 * bound to the schema exported by @playloop/db. Tests inject a PGlite-backed
 * instance via setTestDb() instead of pointing at a real server.
 */
export function getDb(): Db {
  if (!db) {
    db = drizzle(getSql(), { schema });
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
