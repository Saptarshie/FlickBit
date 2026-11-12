import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '@playloop/db';
import { insertEvents, rollupGameStats } from '@playloop/db';
import { trending, fresh, social, explore } from './candidates';

/**
 * Every generator used to scan and sort EVERY published game and slice the
 * result in JS (557 ms on 20k games). The bound now lives in SQL; this guards it
 * so a future edit cannot silently drop it again.
 */
describe('candidate query bounds', () => {
  const capture = () => {
    const seen: string[] = [];
    const fakeDb = {
      execute: async (q: { queryChunks?: unknown[] }) => {
        const text = (q.queryChunks ?? [])
          .map((chunk) => {
            const c = chunk as { value?: unknown; constructor?: { name?: string } };
            if (Array.isArray(c.value)) return String(c.value[0] ?? '');
            return typeof c.value === 'string' ? c.value : '?';
          })
          .join('');
        seen.push(text);
        return [];
      },
    };
    return { fakeDb, seen };
  };

  it.each(['trending', 'fresh', 'social', 'explore'] as const)('%s bounds the rows it fetches', async (name) => {
    const { fakeDb, seen } = capture();
    const fn = { trending, fresh, social, explore }[name];
    await fn(fakeDb as never, 10, { seenGameIds: ['x'] });
    expect(seen.join(' ')).toMatch(/LIMIT/i);
  });
});

describe('candidate generators', () => {
  let client: PGlite;
  let db: any;
  let creatorA: string;
  let creatorB: string;
  let viewer: string;
  let game1Id: string;
  let game2Id: string;
  let game3Id: string;

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema });
    const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url));
    await migrate(db, { migrationsFolder });

    const eventsDdl = await readFile(fileURLToPath(new URL('../../db/events.sql', import.meta.url)), 'utf8');
    await client.exec(eventsDdl);
    const statsDdl = await readFile(fileURLToPath(new URL('../../db/stats.sql', import.meta.url)), 'utf8');
    await client.exec(statsDdl);

    // Insert users
    const [uA] = await db.insert(schema.users).values({
      handle: 'creator_a', displayName: 'Creator A', email: 'a@playloop.local', role: 'user',
    }).returning();
    const [uB] = await db.insert(schema.users).values({
      handle: 'creator_b', displayName: 'Creator B', email: 'b@playloop.local', role: 'user',
    }).returning();
    const [uV] = await db.insert(schema.users).values({
      handle: 'viewer', displayName: 'Viewer', email: 'v@playloop.local', role: 'user',
    }).returning();
    creatorA = uA.id;
    creatorB = uB.id;
    viewer = uV.id;

    // Viewer follows creatorA
    await db.insert(schema.follows).values({
      followerId: viewer,
      followeeId: creatorA,
    });

    // Insert games
    const [g1] = await db.insert(schema.games).values({
      creatorId: creatorA,
      title: 'Trending Game',
      status: 'published',
      moderation: 'approved',
      publishedAt: new Date(Date.now() - 1000 * 3600 * 10),
    }).returning();
    const [g2] = await db.insert(schema.games).values({
      creatorId: creatorB,
      title: 'Fresh Game',
      status: 'published',
      moderation: 'approved',
      publishedAt: new Date(Date.now() - 1000 * 60),
    }).returning();
    const [g3] = await db.insert(schema.games).values({
      creatorId: creatorB,
      title: 'Unseen Explore Game',
      status: 'published',
      moderation: 'approved',
      publishedAt: new Date(Date.now() - 1000 * 3600 * 20),
    }).returning();

    game1Id = g1.id;
    game2Id = g2.id;
    game3Id = g3.id;

    // Add versions
    const [v1] = await db.insert(schema.gameVersions).values({
      gameId: game1Id, versionNo: 1, artifactSha256: 'sha1', artifactBytes: 100, artifactKey: 'art/1',
    }).returning();
    const [v2] = await db.insert(schema.gameVersions).values({
      gameId: game2Id, versionNo: 1, artifactSha256: 'sha2', artifactBytes: 100, artifactKey: 'art/2',
    }).returning();
    const [v3] = await db.insert(schema.gameVersions).values({
      gameId: game3Id, versionNo: 1, artifactSha256: 'sha3', artifactBytes: 100, artifactKey: 'art/3',
    }).returning();

    await db.update(schema.games).set({ publishedVersionId: v1.id }).where(eq(schema.games.id, game1Id));
    await db.update(schema.games).set({ publishedVersionId: v2.id }).where(eq(schema.games.id, game2Id));
    await db.update(schema.games).set({ publishedVersionId: v3.id }).where(eq(schema.games.id, game3Id));

    // Add events: Game 1 has many plays and impressions
    await insertEvents(db, [
      { type: 'play_15s', gameId: game1Id },
      { type: 'play_15s', gameId: game1Id },
      { type: 'play_15s', gameId: game1Id },
      { type: 'like', gameId: game1Id },
      { type: 'impression', gameId: game1Id },
      { type: 'impression', gameId: game2Id },
      { type: 'impression', gameId: game2Id },
      { type: 'impression', gameId: game2Id },
      // game3 has 0 impressions
    ]);
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
  });

  it('trending ranks a game with more plays15 and engagement above one with fewer', async () => {
    const cands = await trending(db, 10);
    expect(cands.length).toBeGreaterThanOrEqual(2);
    expect(cands[0]?.gameId).toBe(game1Id);
  });

  it('fresh returns newest published game first', async () => {
    const cands = await fresh(db, 10);
    expect(cands[0]?.gameId).toBe(game2Id);
  });

  it('explore returns the least-impressed game first', async () => {
    const cands = await explore(db, 10);
    expect(cands[0]?.gameId).toBe(game3Id);
  });

  it('social returns games from a followed creator', async () => {
    const cands = await social(db, viewer, 10);
    expect(cands).toHaveLength(1);
    expect(cands[0]?.gameId).toBe(game1Id);
  });

  it('filters out seen game IDs', async () => {
    const cands = await trending(db, 10, { seenGameIds: [game1Id] });
    expect(cands.some((c) => c.gameId === game1Id)).toBe(false);
  });

  it('past-hour events reach trending only through the game_stats_hourly rollup', async () => {
    const [g] = await db.insert(schema.games).values({
      creatorId: creatorB,
      title: 'Rollup Game',
      status: 'published',
      moderation: 'approved',
      publishedAt: new Date(Date.now() - 1000 * 3600 * 48),
    }).returning();

    const twoHoursAgo = new Date(Date.now() - 1000 * 3600 * 2);
    await insertEvents(db, [
      { ts: twoHoursAgo, type: 'play_15s', gameId: g!.id },
      { ts: twoHoursAgo, type: 'play_15s', gameId: g!.id },
      { ts: twoHoursAgo, type: 'like', gameId: g!.id },
      { ts: twoHoursAgo, type: 'impression', gameId: g!.id },
    ]);

    // Pre-rollup: past-hour events are invisible to trending (raw side only
    // covers the current hour) — score stays at the 0-impression prior.
    const before = await trending(db, 50);
    const beforeCand = before.find((c) => c.gameId === g!.id);
    expect(beforeCand?.score ?? 0).toBe(0);

    await rollupGameStats(db);

    const after = await trending(db, 50);
    const afterCand = after.find((c) => c.gameId === g!.id);
    // (2 * play_15s + 3 * 1 like) / (1 impression + 20) = 5 / 21 > 0
    expect(afterCand?.score ?? 0).toBeGreaterThan(0);
  });

  it('explore counts past-hour impressions through the rollup too', async () => {
    await rollupGameStats(db);
    const cands = await explore(db, 10);
    // game3 has zero impressions anywhere -> least explored, ranked first.
    expect(cands[0]?.gameId).toBe(game3Id);
  });
});
