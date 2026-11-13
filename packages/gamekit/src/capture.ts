/**
 * Frame capture for visual review.
 *
 * The playtest gate proves a game *responds*; it cannot see that the player is
 * an eight-pixel stick figure on a black background, that the HUD collides with
 * the app's top bar, or that the description promises a muscle car and the game
 * shows a running person. Those are visible in one screenshot and invisible in
 * every assertion we currently make.
 *
 * This module drives the same sandboxed harness as the playtest and returns
 * three frames — the opening screen, a mid-run frame, and the end state — as PNG
 * data URLs ready to hand to a multimodal model.
 */
import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright';
import { injectShim } from './inject';
import { injectRuntime, readRuntimeFile, sendBytes } from './runtime-inject';
import { SHIM_SOURCE } from '@playloop/sdk';

const VIEWPORT = { width: 390, height: 844 } as const;

/** Hard ceiling per shot: a data URL this large inside a model payload is not worth it. */
const MAX_SHOT_BYTES = 400 * 1024;

export type CapturedFrames = {
  /** Opening screen, before any input. */
  start: string | null;
  /** Mid-run: after a handful of taps. */
  play: string | null;
  /** End state, when the game reaches one. */
  over: string | null;
  width: number;
  height: number;
  notes: string[];
};

const HARNESS = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#000;height:100%}iframe{width:100vw;height:100vh;border:0;display:block}</style>
<iframe id="f" sandbox="allow-scripts" src="/game"></iframe>
<script>
  window.__pl = { ready: false, ended: false };
  addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.v !== 1 || d.src !== 'playloop') return;
    if (d.type === 'ready') { window.__pl.ready = true; window.__init(); }
    if (d.type === 'gameOver') window.__pl.ended = true;
  });

  // Same insets the feed sends: top profile row, right engagement rail, bottom nav.
  var INIT = { v: 1, src: 'playloop', type: 'init',
    payload: { safeArea: { top: 80, right: 72, bottom: 70 }, muted: true, seed: 12345 } };
  window.__init = function () { document.getElementById('f').contentWindow.postMessage(INIT, '*'); };

  window.__tap = function (x, y) {
    document.getElementById('f').contentWindow.postMessage(
      { v: 1, src: 'playloop', type: 'input', payload: { kind: 'tap', x: x, y: y, pointerId: 1 } }, '*');
  };
</script>`;

function serve(html: string, playOrigin: string): Promise<{ server: Server; port: number }> {
  // The worker injects the pinned engine on /v/; the gate must reproduce it or a
  // Phaser/Babylon game is tested with a 404 where its engine should be.
  const { html: withEngine } = injectRuntime(html);
  const source = injectShim(withEngine, SHIM_SOURCE);
  const server = createServer((req, res) => {
    // Engine from disk first: a gate run should not need the play worker up.
    if (req.url && req.url.startsWith('/r/')) {
      const local = readRuntimeFile(req.url.slice(3));
      if (local) {
        sendBytes(res, 'text/javascript; charset=utf-8', local);
        return;
      }
    }
    if (req.url && (req.url.startsWith('/r/') || req.url.startsWith('/a/'))) {
      fetch(playOrigin + req.url)
        .then(async (upstream) => {
          res.statusCode = upstream.status;
          res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream');
          // Bytes, not text: a WebP read as UTF-8 is corrupted and the frame
          // reports "image failed" with no hint that the proxy was the problem.
          // Node writes Uint8Array chunks verbatim; the cast only satisfies a
          // declaration that lists the string overload first.
          res.end(Buffer.from(await upstream.arrayBuffer()) as unknown as string);
        })
        .catch(() => {
          res.statusCode = 502;
          res.end('');
        });
      return;
    }
    if (req.url === '/harness') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(HARNESS);
      return;
    }
    if (req.url === '/game') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(source);
      return;
    }
    if (req.url === '/favicon.ico') {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end('');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

export async function captureFrames(
  html: string,
  options: { taps?: number; viewport?: { width: number; height: number } } = {},
): Promise<CapturedFrames> {
  const taps = options.taps ?? 10;
  const viewport = options.viewport ?? VIEWPORT;
  const playOrigin = (process.env.PLAY_ORIGIN ?? 'http://localhost:3001').replace(/\/$/, '');
  const { server, port } = await serve(html, playOrigin);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport });
  const notes: string[] = [];

  const shot = async (): Promise<string | null> => {
    try {
      const png = await page.locator('#f').screenshot({ type: 'png' });
      if (png.byteLength > MAX_SHOT_BYTES) {
        notes.push(`shot dropped: ${Math.round(png.byteLength / 1024)} KB`);
        return null;
      }
      return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    } catch (err) {
      const detail = err instanceof Error ? String(err.message).split(/\s+/)[0] : String(err);
      notes.push(("shot failed: " + detail).slice(0, 120));
      return null;
    }
  };

  const result: CapturedFrames = { start: null, play: null, over: null, ...viewport, notes };

  try {
    await page.goto(`http://127.0.0.1:${port}/harness`, { waitUntil: 'domcontentloaded' });

    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      ready = (await page.evaluate('window.__pl.ready')) as boolean;
      if (!ready) await page.waitForTimeout(100);
    }
    if (!ready) notes.push('never reported ready');

    await page.waitForTimeout(450);
    result.start = await shot();

    for (let i = 0; i < taps; i += 1) {
      const x = Math.round(viewport.width * (0.25 + 0.5 * ((i % 4) / 3)));
      const y = Math.round(viewport.height * (0.35 + 0.4 * (((i + 1) % 3) / 2)));
      await page.evaluate(`window.__tap(${x}, ${y})`);
      await page.waitForTimeout(240);
      if (i === Math.floor(taps / 2)) result.play = await shot();
      if (await page.evaluate('!!window.__pl.ended')) break;
    }

    if (result.play === null) result.play = await shot();

    // The end state is only meaningful if the game has one: a tap after game
    // over often restarts, so capture before touching it again.
    const ended = (await page.evaluate('!!window.__pl.ended')) as boolean;
    if (ended) {
      await page.waitForTimeout(300);
      result.over = await shot();
    }
  } catch (err) {
    notes.push(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
    await browser.close();
    server.close();
  }

  return result;
}
