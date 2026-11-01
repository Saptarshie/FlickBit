import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '@playloop/db';
import { insertEvents } from '@playloop/db';
import { trending, fresh, social, explore } from './candidates';

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
});
