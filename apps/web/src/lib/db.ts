import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@playloop/db';

/** Any Drizzle Postgres-compatible database bound to the @playloop/db schema. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let db: Db | null = null;

/**
 * Lazily create (and memoise) the production Drizzle client over postgres-js,
 * bound to the schema exported by @playloop/db. Tests inject a PGlite-backed
 * instance via setTestDb() instead of pointing at a real server.
 */
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    db = drizzle(postgres(url), { schema });
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
