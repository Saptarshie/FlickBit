/**
 * Runtime audit of every artifact on disk.
 *
 *   node scripts/audit-runtime.mjs [--dir apps/play-worker/artifacts] [--seeds]
 *
 * Posts each HTML artifact to the play-worker's smoke service, which plays it in
 * a real Chromium at 390x844 with taps, holds, drags, keys and a resize. Writes
 * docs/reviews/runtime-audit.json (per-artifact verdict) and prints a summary.
 *
 * Sequential on purpose: each check launches a browser, and running them in
 * parallel starves the machine (and the dev server) of memory.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const dirs = [];
if (dirFlag >= 0) dirs.push(args[dirFlag + 1]);
else dirs.push('apps/play-worker/artifacts', '.artifacts/seeds');
if (args.includes('--seeds')) dirs.push('.artifacts/seeds');

const SMOKE = process.env.SMOKE_URL ?? 'http://localhost:3001/internal/smoke';
const OUT = 'docs/reviews/runtime-audit.json';

async function collect() {
  const files = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.html')) continue;
      files.push(path.join(dir, name));
    }
  }
  return [...new Set(files)];
}

async function check(file) {
  const html = await readFile(file, 'utf8');
  const started = Date.now();
  const res = await fetch(SMOKE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    return { file, pass: false, error: `smoke service ${res.status}`, ms: Date.now() - started };
  }
  const report = await res.json();
  return {
    file,
    bytes: html.length,
    pass: Boolean(report.pass),
    fps: report.fps,
    interactive: report.interactive,
    blankScreen: report.blankScreen,
    uncaught: report.uncaught ?? [],
    consoleErrors: report.consoleErrors ?? [],
    ms: Date.now() - started,
  };
}

async function main() {
  const files = await collect();
  console.log(`[audit] ${files.length} artifacts`);
  const results = [];
  for (const file of files) {
    process.stdout.write(`[audit] ${path.basename(file)} … `);
    try {
      const result = await check(file);
      results.push(result);
      const flags = [
        result.pass ? 'PASS' : 'FAIL',
        `fps=${result.fps ?? '?'}`,
        result.uncaught?.length ? `uncaught=${result.uncaught.length}` : '',
        result.blankScreen ? 'blank' : '',
        !result.interactive ? 'not-interactive' : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.log(flags);
      for (const err of [...(result.uncaught ?? []), ...(result.consoleErrors ?? [])].slice(0, 2)) {
        console.log(`[audit]     ! ${String(err).slice(0, 140)}`);
      }
    } catch (err) {
      const failure = { file, pass: false, error: err instanceof Error ? err.message : String(err) };
      results.push(failure);
      console.log(`FAIL ${failure.error}`);
    }
  }

  const failed = results.filter((r) => !r.pass);
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify({ run: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 2),
  );
  console.log(`[audit] ${results.length - failed.length}/${results.length} pass — report: ${OUT}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[audit] error:', err);
  process.exitCode = 1;
});
