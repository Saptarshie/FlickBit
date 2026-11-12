/**
 * Runtime benchmark — the numbers that decide which engine a card gets.
 *
 *   pnpm bench:runtimes                 # every template, warm, no throttle
 *   pnpm bench:runtimes -- --cpu 4      # 4x CPU throttle (a real mid-range phone)
 *   pnpm bench:runtimes -- --cpu 4 --files templates/flappy.html,templates/snake.html
 *
 * What it measures, per artifact, through the REAL serving path (worker routes,
 * shim injection, sandboxed iframe — not file://):
 *
 *   bytes    artifact size on the wire
 *   ttfb     response start
 *   paint    navigation → first non-blank canvas frame
 *   fps      frames/s over a 2 s window after the game reports ready
 *
 * Run it before and after adding an engine. If a Phaser card is not within
 * ~150 ms and ~5 fps of the micro runtime on a 4x throttle, it is not ready for
 * a feed where people swipe every three seconds.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import { createApp } from '../apps/play-worker/src/app';
import { templatesDir } from '@playloop/gamekit';

type Row = {
  name: string;
  bytes: number;
  ttfbMs: number;
  paintMs: number;
  fps: number;
  error: string | null;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cpuThrottle = Number.parseInt(arg('cpu') ?? '1', 10) || 1;
const only = arg('files')?.split(',').map((s) => s.trim());

async function listTemplates(): Promise<string[]> {
  const dir = templatesDir();
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(dir, f));
  if (!only) return files;
  return files.filter((f) => only.some((want) => f.endsWith(want) || f.includes(want)));
}

async function main(): Promise<void> {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'pl-bench-'));
  // The worker app is mounted, not duplicated: every measurement goes through
  // the real CSP, shim injection and caching headers. `/bench/:sha` only adds
  // the parent page a game always runs inside (the feed's iframe).
  const port = Number.parseInt(arg('port') ?? '41999', 10) || 41999;
  const base = `http://127.0.0.1:${port}`;
  // The harness is the embedder; frame-ancestors must name it or every game
  // frame is blocked (the same failure production had with PLAY_ORIGIN).
  const worker = createApp({ artifactsDir, embedders: base });
  const app = express();
  app.get('/bench/:sha', (req, res) => {
    const sha = String(req.params.sha ?? '').replace(/[^0-9a-f]/g, '');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">' +
        `<iframe id="f" sandbox="allow-scripts" style="width:390px;height:844px;border:0" src="/v/${sha}.html"></iframe>` +
        '<script>window.__readyAt=0;addEventListener("message",function(e){' +
        'var d=e.data;if(d&&d.v===1&&d.src==="playloop"&&d.type==="ready"&&!window.__readyAt)window.__readyAt=performance.now();});</script>',
    );
  });
  app.use(worker);
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const rows: Row[] = [];

  try {
    for (const file of await listTemplates()) {
      const html = readFileSync(file);
      const sha = createHash('sha256').update(html).digest('hex');
      writeFileSync(path.join(artifactsDir, `${sha}.html`), html);

      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      if (cpuThrottle > 1) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
      }

      try {
        const t0 = Date.now();
        await page.goto(`${base}/bench/${sha}`, { waitUntil: 'commit', timeout: 30_000 });

        const timing = (await page.evaluate(
          "(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { ttfb: n.responseStart, paint: n.domContentLoadedEventEnd } : { ttfb: 0, paint: 0 }; })()",
        )) as { ttfb: number; paint: number };

        // Time to ready: the game telling the host it is playable. This is the
        // number a player feels, and it is engine-agnostic.
        await page
          .waitForFunction('window.__readyAt > 0', undefined, { timeout: 25_000, polling: 50 })
          .catch(() => {});
        const paintMs = await page.evaluate('window.__readyAt ? Math.round(window.__readyAt) : 25000');

        const gameFrame = page.frames().find((f) => f.url().includes('/v/'));
        const fps = (await (gameFrame ?? page).evaluate(
          'new Promise((resolve) => { let f = 0; const t0 = performance.now();' +
            ' const tick = () => { f += 1; const dt = performance.now() - t0;' +
            ' if (dt >= 2000) resolve(Math.round((f / dt) * 1000)); else requestAnimationFrame(tick); };' +
            ' requestAnimationFrame(tick); setTimeout(() => resolve(Math.round((f / 2200) * 1000)), 2400); })',
        )) as number;

        rows.push({
          name: path.basename(file),
          bytes: html.byteLength,
          ttfbMs: Math.round(timing.ttfb),
          paintMs,
          fps,
          error: errors[0] ?? null,
        });
      } catch (err) {
        rows.push({
          name: path.basename(file),
          bytes: html.byteLength,
          ttfbMs: 0,
          paintMs: 0,
          fps: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  }

  const w = (s: string, n: number) => s.padEnd(n);
  console.log(`\ncpu throttle: ${cpuThrottle}x   viewport: 390x844 @2x\n`);
  console.log(`${w('artifact', 26)}${w('bytes', 9)}${w('ttfb', 8)}${w('paint', 8)}${w('fps', 6)}error`);
  console.log('-'.repeat(78));
  for (const r of rows) {
    console.log(
      `${w(r.name, 26)}${w(String(r.bytes), 9)}${w(`${r.ttfbMs}ms`, 8)}${w(`${r.paintMs}ms`, 8)}${w(String(r.fps), 6)}${
        r.error ?? ''
      }`,
    );
  }

  const out = path.join(process.cwd(), '.artifacts', 'bench');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(out, { recursive: true });
  const file = path.join(out, `runtimes-cpu${cpuThrottle}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ cpuThrottle, rows, at: new Date().toISOString() }, null, 2));
  console.log(`\nwrote ${file}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
