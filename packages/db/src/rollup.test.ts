import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';
import { insertEvents } from './schema/events';
import { rollupGameStats, getGameStats } from './rollup';

describe('game_stats_hourly rollup', () => {
  let client: PGlite;
  let db: any;
  let gameA: string;
  let gameB: string;

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await client.exec(await readFile(fileURLToPath(new URL('../events.sql', import.meta.url)), 'utf8'));
    await client.exec(await readFile(fileURLToPath(new URL('../stats.sql', import.meta.url)), 'utf8'));

    const [creator] = await db
      .insert(schema.users)
      .values({ handle: 'stats_dev', email: 'stats@playloop.local', role: 'user' })
      .returning();
    const [a] = await db
      .insert(schema.games)
      .values({ creatorId: creator.id, title: 'Stats A', status: 'published' })
      .returning();
    const [b] = await db
      .insert(schema.games)
      .values({ creatorId: creator.id, title: 'Stats B', status: 'published' })
      .returning();
    gameA = a.id;
    gameB = b.id;
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
  });

  it('aggregates events per game per UTC hour into the right columns', async () => {
    // Hour 10 UTC: 2 impressions, 1 play_start, 1 play_15s, 1 like, 1 skip_fast for game A.
    await insertEvents(db, [
      { ts: new Date('2026-11-02T10:15:00Z'), type: 'impression', gameId: gameA },
      { ts: new Date('2026-11-02T10:20:00Z'), type: 'impression', gameId: gameA },
      { ts: new Date('2026-11-02T10:25:00Z'), type: 'play_start', gameId: gameA },
      { ts: new Date('2026-11-02T10:30:00Z'), type: 'play_15s', gameId: gameA },
      { ts: new Date('2026-11-02T10:35:00Z'), type: 'like', gameId: gameA },
      { ts: new Date('2026-11-02T10:40:00Z'), type: 'skip_fast', gameId: gameA },
      // Hour 11 UTC for game A: 1 save + 1 remix + 1 comment.
      { ts: new Date('2026-11-02T11:05:00Z'), type: 'save', gameId: gameA },
      { ts: new Date('2026-11-02T11:15:00Z'), type: 'remix', gameId: gameA },
      { ts: new Date('2026-11-02T11:25:00Z'), type: 'comment', gameId: gameA },
      // Same hour 10, game B: 1 impression.
      { ts: new Date('2026-11-02T10:10:00Z'), type: 'impression', gameId: gameB },
      // No game_id -> ignored.
      { ts: new Date('2026-11-02T10:12:00Z'), type: 'impression', gameId: null },
    ]);

    const written = await rollupGameStats(db, {
      from: new Date('2026-11-02T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z'),
    });
    expect(written).toBe(3); // (A, h10), (A, h11), (B, h10)

    const aStats = await getGameStats(db, gameA);
    expect(aStats).toHaveLength(2);
    const h10 = aStats.find((s) => s.hour.toISOString() === '2026-11-02T10:00:00.000Z');
    const h11 = aStats.find((s) => s.hour.toISOString() === '2026-11-02T11:00:00.000Z');
    expect(h10).toMatchObject({
      impressions: 2,
      plays: 1,
      plays15: 1,
      likes: 1,
      saves: 0,
      remixes: 0,
      comments: 0,
      skipsFast: 1,
    });
    expect(h11).toMatchObject({
      impressions: 0,
      plays: 0,
      plays15: 0,
      likes: 0,
      saves: 1,
      remixes: 1,
      comments: 1,
      skipsFast: 0,
    });

    const bStats = await getGameStats(db, gameB);
    expect(bStats).toHaveLength(1);
    expect(bStats[0]).toMatchObject({ impressions: 1, plays: 0 });
  });

  it('is idempotent: re-rolling the same window replaces counts instead of adding', async () => {
    await rollupGameStats(db, {
      from: new Date('2026-11-02T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z'),
    });
    await rollupGameStats(db, {
      from: new Date('2026-11-02T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z'),
    });

    const aStats = await getGameStats(db, gameA);
    const h10 = aStats.find((s) => s.hour.toISOString() === '2026-11-02T10:00:00.000Z');
    expect(h10).toMatchObject({ impressions: 2, plays: 1, plays15: 1, likes: 1, skipsFast: 1 });
  });

  it('picks up newly arrived events when the window is re-rolled', async () => {
    await insertEvents(db, [
      { ts: new Date('2026-11-02T10:50:00Z'), type: 'impression', gameId: gameA },
    ]);
    await rollupGameStats(db, {
      from: new Date('2026-11-02T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z'),
    });

    const aStats = await getGameStats(db, gameA);
    const h10 = aStats.find((s) => s.hour.toISOString() === '2026-11-02T10:00:00.000Z');
    expect(h10).toMatchObject({ impressions: 3 });
  });

  it('leaves hours outside the rollup window untouched', async () => {
    // Roll only hour 11; the hour-10 row (impressions: 3) must stay as-is even
    // though a full roll would recompute it identically — assert no extra rows
    // and the hour-10 count is preserved.
    await rollupGameStats(db, {
      from: new Date('2026-11-02T11:00:00Z'),
      to: new Date('2026-11-02T12:00:00Z'),
    });

    const aStats = await getGameStats(db, gameA);
    expect(aStats).toHaveLength(2);
    const h10 = aStats.find((s) => s.hour.toISOString() === '2026-11-02T10:00:00.000Z');
    expect(h10).toMatchObject({ impressions: 3 });
  });
});
