/**
 * Input matrix: does every published artifact react to the host's replayed tap
 * and hold? Run against the artifact store (what the feed actually serves).
 *
 *   npx tsx scripts/probe-input-matrix.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { probeReplayedInput } from '../packages/gamekit/src/input-probe';

const DIRS = ['apps/play-worker/artifacts', '.artifacts/seeds'];

async function main() {
  const browser = await chromium.launch();
  const files: string[] = [];
  for (const dir of DIRS) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.endsWith('.html')) files.push(path.join(dir, name));
    }
  }

  let dead = 0;
  for (const file of files.sort()) {
    const html = await readFile(file, 'utf8');
    const r = await probeReplayedInput(html, { browser });
    if (!r.reacted) dead += 1;
    console.log(
      `${r.reacted ? 'REACTS' : 'DEAD  '} ${path.basename(file).slice(0, 14)} changes=${r.changes}/${r.taps} inputs=${(r.debug as any)?.inputs ?? '?'}`,
    );
  }
  await browser.close();
  console.log(`\n${files.length - dead}/${files.length} artifacts react to replayed input`);
  if (dead > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
