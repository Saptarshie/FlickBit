/**
 * Audit published games against the artifact validator and unlist the broken
 * ones (truncated files, missing artifacts, hash mismatches).
 *
 *   pnpm exec tsx scripts/audit-artifacts.ts [--fix]
 *
 * Without --fix it only reports. With --fix it sets status='unlisted' on games
 * whose artifact cannot be played, so the feed never serves a black frame.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { validateGame } from '../packages/gamekit/src/validate';
import { runSmokeTest } from '../packages/gamekit/src/smoke';

const root = fileURLToPath(new URL('..', import.meta.url));

const envPath = path.join(root, '.env');
if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const fix = process.argv.includes('--fix');
// --runtime plays every artifact in a headless browser (Playwright): it catches
// the class of bug static validation cannot see, e.g. a game that throws
// "createRadialGradient: non-finite" the first time you hold the screen.
const runtime = process.argv.includes('--runtime');
const artifactsDir = path.resolve(root, process.env.ARTIFACTS_DIR ?? 'apps/play-worker/artifacts');
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres', {
  max: 1,
  prepare: false,
});

type Row = { id: string; title: string; sha: string };

async function main(): Promise<void> {
  const rows = await sql<Row[]>`
    SELECT g.id, g.title, gv.artifact_sha256 AS sha
    FROM games g
    JOIN game_versions gv ON gv.id = g.published_version_id
    WHERE g.status = 'published' AND g.deleted_at IS NULL
  `;

  let ok = 0;
  const bad: { row: Row; reason: string }[] = [];

  for (const row of rows) {
    const file = path.join(artifactsDir, `${row.sha}.html`);
    if (!existsSync(file)) {
      bad.push({ row, reason: 'artifact file missing' });
      continue;
    }
    const bytes = readFileSync(file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== row.sha) {
      bad.push({ row, reason: 'sha256 mismatch' });
      continue;
    }
    const report = validateGame(bytes.toString('utf8'));
    if (report.errors.length > 0) {
      bad.push({ row, reason: report.errors.slice(0, 2).join('; ') });
      continue;
    }
    if (runtime) {
      try {
        // One retry: a Chromium hiccup must not unlist a good game.
        let smoke = await runSmokeTest(bytes.toString('utf8'), { timeoutMs: 30_000 });
        if (!smoke.pass) smoke = await runSmokeTest(bytes.toString('utf8'), { timeoutMs: 30_000 });
        if (!smoke.pass) {
          const reason = [
            smoke.uncaught[0] ?? smoke.consoleErrors[0] ?? (smoke.blankScreen ? 'blank screen' : null),
            smoke.fps < 30 ? `fps ${smoke.fps}` : null,
          ]
            .filter(Boolean)
            .join('; ');
          bad.push({ row, reason: `runtime: ${reason || 'smoke test failed'}` });
          continue;
        }
      } catch (err) {
        bad.push({ row, reason: `runtime: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
    }
    ok += 1;
  }

  for (const { row, reason } of bad) {
    console.log(`[bad] ${row.title} (${row.id}): ${reason}`);
  }

  if (fix && bad.length > 0) {
    for (const { row } of bad) {
      await sql`UPDATE games SET status = 'unlisted', updated_at = now() WHERE id = ${row.id}`;
    }
    console.log(`[fix] unlisted ${bad.length} broken game(s)`);
  }

  console.log(`[audit] ${ok} playable, ${bad.length} broken`);
  await sql.end();
}

main().catch(async (err) => {
  console.error('[audit] failed:', err);
  await sql.end();
  process.exit(1);
});
