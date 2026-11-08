import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@playloop/db';
import { seed } from '@playloop/db/seed';
import { fetchFeedGames } from './feed';
import { setTestDb } from './db';

/**
 * `feed.ts` is a 'use server' module: it calls auth() and getDb(). Both are
 * mocked here so the test exercises the real recsys pipeline against an
 * in-memory PGlite database seeded with the template games.
 */

let client: PGlite;
let db: ReturnType<typeof drizzle>;

vi.mock('../../auth', () => ({
  auth: async () => null,
}));

describe('fetchFeedGames (DB-backed)', () => {
  beforeAll(async () => {
    client = await PGlite.create({ extensions: { vector } });
    db = drizzle(client, { schema });
    setTestDb(db as never);

    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url)),
    });
    await client.exec(
      readFileSync(fileURLToPath(new URL('../../../../packages/db/events.sql', import.meta.url)), 'utf8')
    );
    await client.exec(
      readFileSync(fileURLToPath(new URL('../../../../packages/db/stats.sql', import.meta.url)), 'utf8')
    );
    await seed(db as never, { artifactsDir: mkdtempSync(path.join(tmpdir(), 'pl-feed-')) });
  }, 90_000);

  afterAll(async () => {
    await client?.close();
  });

  it('returns published games with content-addressed artifact URLs', async () => {
    const page = await fetchFeedGames();

    expect(page.items.length).toBeGreaterThan(0);
    for (const card of page.items) {
      expect(card.artifactUrl).toMatch(/^https?:\/\/.+\/v\/[0-9a-f]{64}\.html$/);
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.tags.length).toBeGreaterThan(0);
      expect(card.creator.handle.length).toBeGreaterThan(0);
    }
  });

  it('never returns duplicate games in one page', async () => {
    const { items } = await fetchFeedGames();
    expect(new Set(items.map((c) => c.id)).size).toBe(items.length);
  });

  it('returns an empty page instead of throwing when the DB is unavailable', async () => {
    const broken = { execute: () => Promise.reject(new Error('connection refused')) } as never;
    setTestDb(broken);
    try {
      const page = await fetchFeedGames();
      expect(page.items).toEqual([]);
      expect(page.cursor).toBeNull();
    } finally {
      setTestDb(db as never);
    }
  });
});
