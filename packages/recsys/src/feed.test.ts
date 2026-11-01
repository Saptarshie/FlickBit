import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema } from '@playloop/db';
import { fetchFeedPage } from './feed';

describe('fetchFeedPage', () => {
  let client: PGlite;
  let db: any;
  let userId: string;
  const gameIds: string[] = [];

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema });
    const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url));
    await migrate(db, { migrationsFolder });

    const eventsDdl = await readFile(fileURLToPath(new URL('../../db/events.sql', import.meta.url)), 'utf8');
    await client.exec(eventsDdl);

    const [creator] = await db.insert(schema.users).values({
      handle: 'game_dev', displayName: 'Game Dev', email: 'dev@playloop.local', role: 'user',
    }).returning();

    const [viewer] = await db.insert(schema.users).values({
      handle: 'player1', displayName: 'Player One', email: 'p1@playloop.local', role: 'user',
    }).returning();
    userId = viewer.id;

    // Create 5 published games
    for (let i = 1; i <= 5; i++) {
      const [g] = await db.insert(schema.games).values({
        creatorId: creator.id,
        title: `Game ${i}`,
        description: `Description ${i}`,
        tags: [i % 2 === 0 ? 'arcade' : 'puzzle'],
        status: 'published',
        moderation: 'approved',
        publishedAt: new Date(Date.now() - (10 - i) * 3600 * 1000),
      }).returning();
      gameIds.push(g.id);

      const sha = `sha256_${i}_${'a'.repeat(50)}`;
      const [v] = await db.insert(schema.gameVersions).values({
        gameId: g.id,
        versionNo: 1,
        artifactSha256: sha,
        artifactBytes: 1024 * i,
        artifactKey: `artifacts/${sha}.html`,
      }).returning();

      await db.update(schema.games)
        .set({ publishedVersionId: v.id })
        .where(schema.eq(schema.games.id, g.id));
    }

    // User liked game 1
    await db.insert(schema.likes).values({
      userId,
      gameId: gameIds[0],
    });
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
  });

  it('returns items with well-formed artifactUrl and viewer interaction flags', async () => {
    const page = await fetchFeedPage(db, {
      userId,
      limit: 3,
      playOrigin: 'https://play.playloop.test',
    });

    expect(page.items.length).toBe(3);
    for (const item of page.items) {
      expect(item.artifactUrl).toMatch(/^https:\/\/play\.playloop\.test\/v\/sha256_/);
      expect(item.creator.handle).toBe('game_dev');
    }

    const game1 = page.items.find((i) => i.id === gameIds[0]);
    if (game1) {
      expect(game1.viewer.liked).toBe(true);
      expect(game1.viewer.saved).toBe(false);
    }
    expect(page.cursor).not.toBeNull();
  });

  it('paginates without repeating game IDs across pages', async () => {
    const page1 = await fetchFeedPage(db, {
      userId,
      limit: 2,
      playOrigin: 'http://play.localhost:3001',
    });
    expect(page1.items.length).toBe(2);
    expect(page1.cursor).toBeTruthy();

    const page2 = await fetchFeedPage(db, {
      userId,
      limit: 2,
      cursor: page1.cursor!,
      playOrigin: 'http://play.localhost:3001',
    });

    expect(page2.items.length).toBeGreaterThan(0);
    const page1Ids = new Set(page1.items.map((i) => i.id));
    for (const item of page2.items) {
      expect(page1Ids.has(item.id)).toBe(false);
    }
  });
});
