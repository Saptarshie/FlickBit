/**
 * Backfill game-version manifests from the artifacts themselves.
 *
 * Versions published before the feed learned to read the runtime were stored with
 * `{ ...metadata, spec }` as their manifest — no `runtime`, so their cards could
 * not prefetch the right engine and the feed showed them as micro games.
 *
 * The artifact on disk is the source of truth. This reads each one, extracts its
 * pl-manifest and merges it in, without touching a single artifact byte.
 *
 *   npx tsx scripts/backfill-manifests.ts           # dry run
 *   npx tsx scripts/backfill-manifests.ts --write
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { gameVersions } from '@playloop/db';
import { extractManifest } from '@playloop/gamekit';

const write = process.argv.includes('--write');
const artifactsDir = path.resolve(process.cwd(), process.env.ARTIFACTS_DIR ?? 'apps/play-worker/artifacts');

async function main(): Promise<void> {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const db = drizzle(client);

  const rows = await db.select().from(gameVersions);
  let updated = 0;
  let missing = 0;
  let unchanged = 0;

  for (const row of rows) {
    const file = path.join(artifactsDir, `${row.artifactSha256}.html`);
    if (!existsSync(file)) {
      missing += 1;
      continue;
    }
    const manifest = extractManifest(readFileSync(file, 'utf8'));
    if (!manifest) {
      missing += 1;
      continue;
    }
    const current = (row.manifest ?? {}) as Record<string, unknown>;
    const merged = { ...manifest, ...current, ...(manifest.runtime ? { runtime: manifest.runtime } : {}) };
    const changed = JSON.stringify(merged) !== JSON.stringify(current);
    if (!changed) {
      unchanged += 1;
      continue;
    }
    updated += 1;
    if (write) {
      await db.update(gameVersions).set({ manifest: merged }).where(eq(gameVersions.id, row.id));
    }
  }

  console.log(`${write ? 'UPDATED' : 'WOULD UPDATE'} ${updated} · unchanged ${unchanged} · missing artifact ${missing} (of ${rows.length})`);
  await client.end();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
