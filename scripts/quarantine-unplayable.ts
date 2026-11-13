/**
 * Quarantine games that cannot be played.
 *
 * Two phases, because the embedded database accepts exactly one client and the
 * running app already holds it:
 *
 *   npx tsx scripts/quarantine-unplayable.ts --scan    # app UP: play every published game
 *   npx tsx scripts/quarantine-unplayable.ts --apply   # app DOWN: hide the dead ones
 *
 * The playtest gate stops NEW unplayable games, but anything published before
 * the gate existed can still sit in the feed as a dead card — the worst first
 * impression the product can make. `--apply` moves those to `unlisted`: still
 * reachable by direct link and by their creator, gone from everyone else's
 * feed. Nothing is deleted.
 *
 * Restore: update games set status = 'published' where id = '<id>' and run --apply
 * with an empty report.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import { games } from '@playloop/db';
import { playtest } from '@playloop/gamekit/playtest';

const WEB = process.env.APP_ORIGIN ?? 'http://localhost:3000';
const reportPath = path.join(process.cwd(), '.artifacts', 'unplayable.json');

type Finding = { id: string; title: string; changes: number; defect: string };

async function scan(): Promise<void> {
  const res = await fetch(`${WEB}/api/feed?limit=100`);
  const body = (await res.json()) as {
    data?: { items?: Array<{ id: string; title: string; artifactUrl: string }> };
  };
  const items = body.data?.items ?? [];
  if (items.length === 0) throw new Error('feed is empty — is the stack up?');

  const findings: Finding[] = [];
  console.log(`playing ${items.length} published games\n`);
  for (const item of items) {
    const html = await (await fetch(item.artifactUrl)).text();
    const report = await playtest(html, { taps: 8 });
    const dead = report.changes === 0;
    console.log(`${item.title.slice(0, 30).padEnd(31)}${dead ? 'DEAD ' : 'ok   '}${report.defects[0] ?? `${report.changes} changes`}`);
    if (dead) findings.push({ id: item.id, title: item.title, changes: report.changes, defect: report.defects[0] ?? '' });
  }

  writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), findings }, null, 2));
  console.log(`\n${findings.length} unplayable → ${reportPath}`);
  console.log('now stop the app (`pnpm stop`) and run: pnpm tsx scripts/quarantine-unplayable.ts --apply');
}

async function apply(): Promise<void> {
  if (!existsSync(reportPath)) throw new Error('no scan report — run --scan first (with the app up)');
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { findings: Finding[] };
  if (report.findings.length === 0) {
    console.log('nothing to quarantine');
    return;
  }

  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const db = drizzle(client);
  const ids = report.findings.map((f) => f.id);
  await db.update(games).set({ status: 'unlisted' }).where(inArray(games.id, ids));
  console.log(`hidden ${ids.length} game(s): ${report.findings.map((f) => f.title).join(', ')}`);
  await client.end();
}

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--scan') ? 'scan' : null;
if (!mode) {
  console.error('usage: --scan (app up) | --apply (app down)');
  process.exitCode = 2;
} else {
  void (mode === 'scan' ? scan() : apply()).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
