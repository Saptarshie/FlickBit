import { createServer } from 'node:http';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
// @playloop/sdk is not linked into this package (see smoke.ts), so the shim is
// imported by relative path exactly like the runtime gate does.
import { SHIM_SOURCE } from '../../sdk/src/shim-source';
import { injectShim } from './inject';
import { injectRuntime, readAssetFile, readRuntimeFile, sendBytes, assetContentType } from './runtime-inject';

/**
 * Does an artifact react to the input envelope the host actually sends?
 *
 * The runtime gate presses real mouse buttons in the page. That is *not* the
 * production path: players never touch the game directly (the frame has
 * `pointer-events: none`), the host captures the gesture and replays it as a
 * `{ type: 'input' }` postMessage. A shim regression therefore passed the gate
 * while every game on a phone looked frozen.
 *
 * This probe replays that exact envelope and reports whether the canvas changed.
 */
export type InputProbeResult = {
  reacted: boolean;
  taps: number;
  changes: number;
  hasCanvas: boolean;
  /** Shim-side counters, when the guest exposes them (window.__plDebug). */
  debug: Record<string, unknown> | null;
  errors: string[];
};

const VIEWPORT = { width: 390, height: 844 };

async function serve(html: string) {
  const source = injectShim(injectRuntime(html).html, SHIM_SOURCE);
  const server = createServer((req, res) => {
    // Catalogue bytes from disk, same reason as engines: the gate is the only
    // server in the room, and a 404 here means "the game is broken" to every
    // assertion downstream.
    if (req.url && req.url.startsWith('/a/')) {
      const file = req.url.slice(3);
      const bytes = readAssetFile(file);
      if (bytes) {
        sendBytes(res, assetContentType(file), bytes);
        return;
      }
    }
    // Engine bytes from disk: the artifact references /r/<file> and the harness
    // is the only server in the room.
    if (req.url && req.url.startsWith('/r/')) {
      const bytes = readRuntimeFile(req.url.slice(3));
      if (bytes) {
        sendBytes(res, 'text/javascript; charset=utf-8', bytes);
        return;
      }
    }
    if (req.url === '/harness') {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">' +
          '<iframe id="f" sandbox="allow-scripts" style="width:390px;height:844px;border:0" src="/game"></iframe>',
      );
    } else if (req.url === '/game') {
      res.setHeader('content-type', 'text/html');
      res.end(source);
    } else {
      res.statusCode = 404;
      res.end('');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, port: (server.address() as { port: number }).port };
}

/** Wait until the guest has painted at least one frame (or give up). */
async function waitForGame(page: Page, frame: Frame, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // String form: esbuild's keepNames adds a `__name` helper that does not
    // exist in the page, which makes any function-form evaluate throw.
    const painted = await frame
      .evaluate(
        '(() => { var d = window.__plDebug; if (!d) return true; return !!(d.hasPainted || d.rafs > 0); })()',
      )
      .catch(() => false);
    if (painted) return;
    await page.waitForTimeout(120);
  }
  // A WebGL game (Babylon, Phaser's WebGL renderer) never touches the 2D canvas
  // API, so the shim's paint counter stays at zero while the game renders fine.
  // If a canvas exists at all, let the caller decide with real pixels.
  const hasCanvas = await frame
    .evaluate('(() => !!document.querySelector("canvas"))()')
    .catch(() => false);
  if (!hasCanvas) throw new Error('game frame has no canvas');
}

export async function probeReplayedInput(html: string, options: { browser?: Browser } = {}): Promise<InputProbeResult> {
  const { server, port } = await serve(html);
  const browser = options.browser ?? (await chromium.launch());
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/harness`, { waitUntil: 'domcontentloaded' });
    // The iframe mounts after the harness document loads, so poll for the frame
    // instead of assuming it is already there.
    let frame = page.frames().find((f) => f.url().endsWith('/game'));
    for (let i = 0; i < 50 && !frame; i += 1) {
      await page.waitForTimeout(120);
      frame = page.frames().find((f) => f.url().endsWith('/game'));
    }
    if (!frame) throw new Error('game frame never loaded');

    await waitForGame(page, frame);
    await page.waitForTimeout(600);

    // WebGL canvases return a blank toDataURL unless the game asked for
    // preserveDrawingBuffer, which no game should have to do for our benefit.
    // Screenshot those through the compositor instead.
    const isWebgl = await frame
      .evaluate('(() => { var c = document.querySelector("canvas"); return c ? !c.getContext("2d") : false; })()')
      .catch(() => false);

    const snapshot = async (): Promise<string> => {
      if (isWebgl) {
        // Canvas-level screenshot first; some sandboxed frames refuse it, so fall
        // back to the iframe element and finally the whole page.
        for (const target of [() => frame.locator('canvas').screenshot({ type: 'png' }), () => page.locator('#f').screenshot({ type: 'png' })]) {
          try {
            const png = await target();
            return png.toString('base64');
          } catch {
            // try the next one
          }
        }
        return 'no-canvas';
      }
      return frame.evaluate('(() => { var c = document.querySelector("canvas"); return c ? c.toDataURL() : "no-canvas"; })()');
    };

    /**
     * Wait for the canvas to differ from `previous`, up to `timeoutMs`.
     *
     * A single immediate comparison is flaky: when the machine is loaded (the
     * suite runs several Chromium instances) a frame may not have rendered by
     * the time we sample, and a responsive game is reported as dead. Polling
     * costs nothing when the game reacts immediately.
     */
    const changedWithin = async (previous: string, timeoutMs = 2000): Promise<string | null> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = await snapshot();
        if (current !== previous) return current;
        await page.waitForTimeout(100);
      }
      return null;
    };

    const seen = (await frame.evaluate(
      '(() => { window.__probeDowns = 0; window.addEventListener("pointerdown", function () { window.__probeDowns += 1; }); return !!document.querySelector("canvas"); })()',
    )) as boolean;

    // Tap across the middle of the frame, exactly like the host does.
    const points: Array<[number, number]> = [
      [195, 300],
      [195, 420],
      [195, 520],
      [110, 420],
      [280, 420],
      [195, 650],
    ];
    let previous = await snapshot();
    let changes = 0;

    for (const [x, y] of points) {
      await page.evaluate(
        `new Promise(function (resolve) {
           var f = document.getElementById('f');
           f.contentWindow.postMessage({ v: 1, src: 'playloop', type: 'input', payload: { kind: 'tap', x: ${x}, y: ${y}, pointerId: 1 } }, '*');
           setTimeout(resolve, 260);
         })`,
      );
      const next = await changedWithin(previous);
      if (next !== null) {
        changes += 1;
        previous = next;
      }
    }

    // A hold, for charge/jump games whose interesting state is while the
    // pointer is down (Magma Hop and friends).
    await page.evaluate(
      `new Promise(function (resolve) {
         var f = document.getElementById('f');
         function send(kind, x, y) {
           f.contentWindow.postMessage({ v: 1, src: 'playloop', type: 'input', payload: { kind: kind, x: x, y: y, pointerId: 1 } }, '*');
         }
         send('down', 195, 500);
         setTimeout(function () { send('up', 195, 500); setTimeout(resolve, 500); }, 1200);
       })`,
    );
    const afterHold = await changedWithin(previous, 2500);
    if (afterHold !== null) changes += 1;

    const debug = (await frame
      .evaluate('(window.__plDebug ? JSON.parse(JSON.stringify(window.__plDebug)) : null)')
      .catch(() => null)) as Record<string, unknown> | null;

    return {
      reacted: changes > 0,
      taps: points.length + 1,
      changes,
      hasCanvas: seen,
      debug,
      errors: errors.slice(0, 3),
    };
  } finally {
    await page.close();
    if (!options.browser) await browser.close();
    server.close();
  }
}
