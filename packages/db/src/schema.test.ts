import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  const client = new PGlite({ extensions: { vector } });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
}, 60_000);

describe('schema migration', () => {
  it('creates a user, a game, a version, and links published version', async () => {
    const [u] = await db.insert(schema.users).values({ handle: 'Alice', email: 'a@x.com' }).returning();
    const [g] = await db.insert(schema.games).values({ creatorId: u!.id, title: 'T' }).returning();
    const [v] = await db.insert(schema.gameVersions).values({
      gameId: g!.id, versionNo: 1, artifactSha256: 'abc', artifactBytes: 10, artifactKey: 'artifacts/abc.html',
    }).returning();
    await db.update(schema.games).set({ publishedVersionId: v!.id, status: 'published' }).where(eq(schema.games.id, g!.id));
    const row = await db.query.games.findFirst({ where: eq(schema.games.id, g!.id) });
    expect(row?.publishedVersionId).toBe(v!.id);
    expect(row?.tags).toEqual([]);
  });

  it('enforces case-insensitive unique handle and email', async () => {
    await db.insert(schema.users).values({ handle: 'Bob', email: 'b@x.com' });
    await expect(db.insert(schema.users).values({ handle: 'bob', email: 'other@x.com' })).rejects.toThrow();
    await expect(db.insert(schema.users).values({ handle: 'bob2', email: 'B@X.COM' })).rejects.toThrow();
  });

  it('enforces unique (game, version_no)', async () => {
    const [u] = await db.insert(schema.users).values({ handle: 'carol', email: 'c@x.com' }).returning();
    const [g] = await db.insert(schema.games).values({ creatorId: u!.id }).returning();
    const base = { gameId: g!.id, versionNo: 1, artifactSha256: 'h', artifactBytes: 1, artifactKey: 'k' };
    await db.insert(schema.gameVersions).values(base);
    await expect(db.insert(schema.gameVersions).values(base)).rejects.toThrow();
  });

  it('stores vectors and runs cosine ANN query', async () => {
    const [u] = await db.insert(schema.users).values({ handle: 'dave', email: 'd@x.com' }).returning();
    const [g] = await db.insert(schema.games).values({ creatorId: u!.id }).returning();
    const ids: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const [v] = await db.insert(schema.gameVersions).values({ gameId: g!.id, versionNo: i, artifactSha256: `s${i}`, artifactBytes: 1, artifactKey: `k${i}` }).returning();
      const vec = new Array(1024).fill(0); vec[i - 1] = 1;
      await db.insert(schema.gameFeatures).values({ gameVersionId: v!.id, contentVec: vec, feedEligible: true });
      ids.push(v!.id);
    }
    const q = new Array(1024).fill(0); q[1] = 1;
    const res = await db.execute(sql`select game_version_id from game_features order by content_vec <=> ${JSON.stringify(q)}::vector limit 1`);
    expect((res.rows[0] as { game_version_id: string }).game_version_id).toBe(ids[1]);
  });

  it('cascades likes on game delete', async () => {
    const [u] = await db.insert(schema.users).values({ handle: 'erin', email: 'e@x.com' }).returning();
    const [g] = await db.insert(schema.games).values({ creatorId: u!.id }).returning();
    await db.insert(schema.likes).values({ userId: u!.id, gameId: g!.id });
    await expect(db.insert(schema.likes).values({ userId: u!.id, gameId: g!.id })).rejects.toThrow();
    await db.delete(schema.games).where(eq(schema.games.id, g!.id));
    const left = await db.select().from(schema.likes).where(eq(schema.likes.gameId, g!.id));
    expect(left).toHaveLength(0);
  });
});
