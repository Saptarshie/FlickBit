import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { seed } from './seed';

it('seed is idempotent', async () => {
  const db = drizzle(new PGlite({ extensions: { vector } }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  const a = await seed(db);
  const b = await seed(db);
  expect(a.systemUserId).toBe(b.systemUserId);
  expect(await db.select().from(schema.users)).toHaveLength(1);
}, 60_000);

it('seed writes content-addressed artifacts and is idempotent on re-run', async () => {
  const db = drizzle(new PGlite({ extensions: { vector } }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  const dir = fileURLToPath(new URL('../../../.tmp-seed-artifacts', import.meta.url));

  const first = await seed(db, { artifactsDir: dir });
  expect(first.templateGames).toBe(8);

  const games = await db.select().from(schema.games);
  expect(games).toHaveLength(8);
  for (const g of games) {
    expect(g.status).toBe('published');
    expect(g.publishedVersionId).not.toBeNull();
  }

  // Every artifact file must be named by the sha256 of its own bytes.
  const versions = await db.select().from(schema.gameVersions);
  expect(versions).toHaveLength(8);
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  for (const v of versions) {
    const bytes = await readFile(`${dir}/${v.artifactSha256}.html`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(v.artifactSha256);
    expect(v.artifactBytes).toBe(bytes.byteLength);
  }

  // Re-running must not duplicate anything.
  const second = await seed(db, { artifactsDir: dir });
  expect(second.templateGames).toBe(0);
  expect(await db.select().from(schema.games)).toHaveLength(8);
}, 60_000);
