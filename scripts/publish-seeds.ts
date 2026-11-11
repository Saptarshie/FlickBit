import 'dotenv/config';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { publishPendingSeeds } from './seeds';

/**
 * Publish generated seed games from a terminal.
 *
 *   npx tsx scripts/publish-seeds.ts
 *
 * `pnpm dev` normally does this on boot (scripts/dev-db.ts calls the same
 * helper), so this script is only needed offline. The dev database accepts one
 * connection: stop `pnpm dev` before running it.
 */
const root = process.cwd();
const seedsDir = path.join(root, '.artifacts', 'seeds');
const artifactsDir = path.resolve(root, process.env.ARTIFACTS_DIR ?? 'apps/play-worker/artifacts');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 5 });
const db = drizzle(sql);

async function main(): Promise<void> {
  const result = await publishPendingSeeds(db, { seedsDir, artifactsDir, log: console.log });
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from games where status = 'published' and deleted_at is null`;
  console.log(`published=${result.published} skipped=${result.skipped} live=${count}`);
}

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (/CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|terminat/i.test(message)) {
      console.error(
        'Cannot reach the dev database. It accepts a single connection and `pnpm dev` holds it —\n' +
          'stop the dev server, run this script, then start `pnpm dev` again. (Restarting `pnpm dev`\n' +
          'is usually enough: the dev-db boot publishes new seeds automatically.)',
      );
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  })
  .finally(() => {
    void sql.end({ timeout: 5 });
  });
