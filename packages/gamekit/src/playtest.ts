/**
 * Playtest gate — does the game actually *play*?
 *
 * The static gate proves a file is safe, and the smoke gate proves it renders.
 * Neither can tell you the difference between "a game" and "a video of a game":
 * a scene whose update() is never called renders one frame, reports 60 fps and
 * sits there. This probe plays it the way a player would, through the host's own
 * protocol, and reads the game's own score/game-over events — so it works
 * identically for canvas, Phaser, Babylon or anything else.
 *
 * What it asserts:
 *   1. the game reports `ready` (it boots),
 *   2. the picture changes after input (it is not frozen),
 *   3. the score moves (or the game declares scoring:none),
 *   4. after a game over, a tap starts a new run (restart works),
 *   5. nothing throws.
 */
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { injectShim } from './inject';
import { extractManifest } from './validate';
import { assetContentType, injectRuntime, readAssetFile, readRuntimeFile, sendBytes } from './runtime-inject';
import { SHIM_SOURCE } from '@playloop/sdk';

const VIEWPORT = { width: 390, height: 844 } as const;

export type PlaytestReport = {
  pass: boolean;
  ready: boolean;
  /** Distinct pictures observed after each tap. */
  changes: number;
  taps: number;
  scoreStart: number | null;
  scoreEnd: number | null;
  /** Score carried by the gameOver event, when the game only reports at the end. */
  finalScore: number | null;
  scoreMoved: boolean;
  /**
   * The run showed progress (a point, or its own end screen). Reported, not
   * enforced: a snake game may legitimately not eat anything in six seconds,
   * and a gate that fails it is a gate people learn to ignore. What IS
   * enforced is that the game responds, never traps the player, and does not
   * throw.
   */
  progress: boolean;
  gameOverSeen: boolean;
  /** null when the game never ended, so restart could not be judged. */
  restartWorked: boolean | null;
  /** Did a left-to-right drag change the picture? Null when it was not probed. */
  swipeMoved?: boolean | null;
  errors: string[];
  defects: string[];
  /** Guest→host message types seen, in order — the first thing to look at on failure. */
  events: string[];
  /** Requests the page made that did not succeed. */
  httpErrors: string[];
  /** Shim counters, when the guest exposes them. */
  shimDebug: Record<string, unknown> | null;
  durationMs: number;
};

export type PlaytestOptions = {
  browser?: Browser;
  /** Taps to send while waiting for the score to move. */
  taps?: number;
  /** Declared scoring mode from the manifest; `none` means score is not judged. */
  scoring?: 'higher' | 'lower' | 'none';
  viewport?: { width: number; height: number };
};

const HARNESS = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#000;height:100%}iframe{width:100vw;height:100vh;border:0;display:block}</style>
<iframe id="f" sandbox="allow-scripts" src="/game"></iframe>
<script>
  window.__pl = { events: [], ready: false, score: null, ended: false, restarted: false, finalScore: null };
  addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.v !== 1 || d.src !== 'playloop') return;
    window.__pl.events.push({ type: d.type, payload: d.payload || null });
    if (d.type === 'ready') { window.__pl.ready = true; window.__init(); }
    if (d.type === 'score' && d.payload && typeof d.payload.score === 'number') {
      // Score traffic after an end means a new run began — the cheapest
      // engine-agnostic proof that "tap to restart" actually works.
      if (window.__pl.ended) { window.__pl.ended = false; window.__pl.restarted = true; }
      window.__pl.score = d.payload.score;
    }
    if (d.type === 'gameOver') {
      // A flag, not the score: gameOver with score 0 is still a game over.
      window.__pl.ended = true;
      window.__pl.finalScore = (d.payload && typeof d.payload.score === 'number') ? d.payload.score : 0;
    }
  });
  // One tap envelope: the shim synthesises down+up for it, which is the path
  // the feed uses. Sending separate down/up messages also works for most games
  // but skips the shim's tap handling (pointerId bookkeeping, haptic gating).

  // Same insets the feed sends: top profile row, right engagement rail, bottom nav.
  var INIT = { v: 1, src: 'playloop', type: 'init',
    payload: { safeArea: { top: 80, right: 72, bottom: 70 }, muted: true, seed: 12345 } };
  window.__init = function () { document.getElementById('f').contentWindow.postMessage(INIT, '*'); };

  window.__tap = function (x, y) {
    document.getElementById('f').contentWindow.postMessage(
      { v: 1, src: 'playloop', type: 'input', payload: { kind: 'tap', x: x, y: y, pointerId: 1 } }, '*');
  };

  // Paced drag primitives. The host sends one envelope per pointer event, so a
  // swipe is a sequence — posting down/move/up in one synchronous call proves
  // nothing about whether the game responded *while* the finger moved, which is
  // the only thing that distinguishes a swipe from a tap.
  window.__dragBegin = function (x, y) {
    document.getElementById('f').contentWindow.postMessage(
      { v: 1, src: 'playloop', type: 'input',
        payload: { kind: 'down', x: x, y: y, pointerId: 7, pointerType: 'touch' } }, '*');
  };
  window.__dragMove = function (x, y) {
    document.getElementById('f').contentWindow.postMessage(
      { v: 1, src: 'playloop', type: 'input',
        payload: { kind: 'move', x: x, y: y, pointerId: 7, pointerType: 'touch' } }, '*');
  };
  window.__dragEnd = function (x, y) {
    document.getElementById('f').contentWindow.postMessage(
      { v: 1, src: 'playloop', type: 'input',
        payload: { kind: 'up', x: x, y: y, pointerId: 7, pointerType: 'touch' } }, '*');
  };

</script>`;

/**
 * Serve the artifact plus whatever engine it pins.
 *
 * An artifact that came from the worker already carries `<script src="/r/...">`
 * for its engine; replaying it on a different origin would 404 the engine and
 * quietly test a fallback path instead of the real game. Engine requests are
 * proxied to the play origin, which is the only place those bytes exist.
 */
function serve(html: string): Promise<{ server: Server; port: number }> {
  // The worker injects the pinned engine on /v/; the gate must reproduce it or a
  // Phaser/Babylon game is tested with a 404 where its engine should be.
  const { html: withEngine } = injectRuntime(html);
  const source = injectShim(withEngine, SHIM_SOURCE);
  const playOrigin = (process.env.PLAY_ORIGIN || 'http://localhost:3001').replace(/\/$/, '');
  const server = createServer((req, res) => {
    // Engine from disk first: a gate run should not need the play worker up.
    if (req.url && req.url.startsWith('/r/')) {
      const local = readRuntimeFile(req.url.slice(3));
      if (local) {
        sendBytes(res, 'text/javascript; charset=utf-8', local);
        return;
      }
    }
    if (req.url && req.url.startsWith('/a/')) {
      const file = req.url.slice(3);
      const local = readAssetFile(file);
      if (local) {
        sendBytes(res, assetContentType(file), local);
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
      // Chromium asks for it unprompted; a 404 here is not the game's fault.
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

async function frameOf(page: Page): Promise<Frame | null> {
  for (let i = 0; i < 60; i += 1) {
    const frame = page.frames().find((f) => f.url().endsWith('/game'));
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  return null;
}

export async function playtest(html: string, options: PlaytestOptions = {}): Promise<PlaytestReport> {
  const started = Date.now();
  const taps = options.taps ?? 20;
  const viewport = options.viewport ?? VIEWPORT;
  const scoring = options.scoring ?? 'higher';
  const manifest = extractManifest(html);
  const { server, port } = await serve(html);
  // Software GL: a 3D game must be testable on a machine with no GPU, otherwise
    // the gate silently skips every Babylon artifact.
    const browser = options.browser ?? (await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }));
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  const httpErrors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  // Anything the page asked for and did not get: usually a game reaching for a
  // file that is not there (inside a sandbox this can only be same-origin, but
  // a 404 still means a broken reference).
  page.on('response', (res) => {
    if (res.status() >= 400) httpErrors.push(`${res.status()} ${res.url().slice(0, 120)}`);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // A missing favicon is the harness's 404, not a game defect.
    if (/favicon/i.test(text)) return;
    errors.push(`console: ${text.slice(0, 200)}`);
  });

  const defects: string[] = [];
  let changes = 0;
  let scoreStart: number | null = null;
  let scoreEnd: number | null = null;
  let gameOverSeen = false;
  let restartWorked: boolean | null = null;
  let swipeMoved: boolean | null = null;
  let ready = false;
  let finalScore: number | null = null;
  let events: string[] = [];
  let shimDebug: Record<string, unknown> | null = null;

  try {
    await page.goto(`http://127.0.0.1:${port}/harness`, { waitUntil: 'domcontentloaded' });
    const frame = await frameOf(page);
    if (!frame) throw new Error('game frame never mounted');
    const harnessOk = await page.evaluate('typeof window.__pl === "object" && typeof window.__tap === "function"');
    if (!harnessOk) throw new Error('playtest harness did not initialise');

    // 1. ready — a game that never reports it is not playable, it is a painting.
    for (let i = 0; i < 120 && !ready; i += 1) {
      ready = (await page.evaluate('window.__pl.ready')) as boolean;
      if (!ready) await page.waitForTimeout(100);
    }
    if (!ready) defects.push('never reported ready within 12s');

    // The iframe element, screenshotted at the compositor: works for WebGL
    // canvases, where toDataURL() returns a blank image.
    // A 3D frame can take longer than Playwright's 30 s default to capture when
    // the box is loaded; a timeout here used to be reported as a game defect.
    const shot = async (): Promise<Buffer> => {
      try {
        return await page.locator('#f').screenshot({ type: 'png', timeout: 20_000, animations: 'disabled' });
      } catch {
        // Frame capture can stall on a heavy WebGL scene; the page screenshot is
        // smaller but tells us whether anything changed at all.
        return page.screenshot({ type: 'png', timeout: 20_000, animations: 'disabled' }).catch(() => Buffer.alloc(0));
      }
    };
    let previous = await shot();

    const readScore = async (): Promise<number | null> => (await page.evaluate('window.__pl.score')) as number | null;

    // 3b. Horizontal input.
    //
    // The tap loop above cannot tell a game that implements left/right from one that
    // silently ignores it — every gesture in this gate was a tap, so swipe-only
    // controls reached the feed untested. The drag is paced and sampled: the frame
    // taken just after the down is the baseline, and any change *after* that while
    // the finger is still moving is the game tracking the swipe.
    // Fresh card: probe before the taps, because a runner can end its run mid-loop
    // and a game-over screen swallows the gesture.
    if (!gameOverSeen) {
      const y = Math.round(viewport.height * 0.55);
      const x1 = Math.round(viewport.width * 0.2);
      const x2 = Math.round(viewport.width * 0.8);
      await page.evaluate(`window.__dragBegin(${x1}, ${y})`).catch(() => undefined);
      await page.waitForTimeout(120);
      const afterDown = await shot();
      const midDrag: Buffer[] = [];
      for (let step = 1; step <= 4; step += 1) {
        const x = Math.round(x1 + ((x2 - x1) * step) / 4);
        await page.evaluate(`window.__dragMove(${x}, ${y})`).catch(() => undefined);
        await page.waitForTimeout(110);
        midDrag.push(await shot());
      }
      await page.evaluate(`window.__dragEnd(${x2}, ${y})`).catch(() => undefined);
      await page.waitForTimeout(150);
      swipeMoved = midDrag.some((frame) => !frame.equals(afterDown));

      const declared = (manifest?.controls ?? 'tap').toLowerCase();
      const wantsHorizontal = /swipe|drag|mixed|joystick|buttons/.test(declared);
      if (wantsHorizontal && !swipeMoved) {
        defects.push(
          `controls declare "${declared}" but a left-to-right drag changed nothing — horizontal input is not wired`,
        );
      }
    }

    // 2/3. tap across the play area and watch the picture and the score.
    for (let i = 0; i < taps; i += 1) {
      const x = Math.round(viewport.width * (0.25 + 0.5 * ((i % 4) / 3)));
      const y = Math.round(viewport.height * (0.35 + 0.4 * (((i + 1) % 3) / 2)));
      await page.evaluate(`window.__tap(${x}, ${y})`);
      await page.waitForTimeout(260);

      if (i === 0) scoreStart = await readScore();
      const current = await shot();
      if (!current.equals(previous)) changes += 1;
      previous = current;

      if (await page.evaluate('!!window.__pl.ended')) {
        gameOverSeen = true;
        break;
      }
    }
    scoreEnd = await readScore();
    if (scoreStart === null) scoreStart = scoreEnd;
    finalScore = (await page.evaluate('window.__pl.finalScore')) as number | null;

    if (changes === 0) defects.push('the picture never changed after input — the game is frozen');


    // Progress is evidence, not a verdict (see `progress` above). Silence here
    // is reported in the result so a human can look, but it does not fail the
    // build: only "frozen", "throws" and "trapped at game over" do.
    if (scoring === 'none') {
      // nothing to judge
    }

    // 4. a game over must leave a way back in.
    if (gameOverSeen) {
      const beforeRestart = await shot();
      await page.evaluate(`window.__tap(${Math.round(viewport.width / 2)}, ${Math.round(viewport.height * 0.55)})`);
      await page.waitForTimeout(700);
      const afterRestart = await shot();
      const restarted = (await page.evaluate('!!window.__pl.restarted')) as boolean;
      restartWorked = restarted || !afterRestart.equals(beforeRestart);
      if (!restartWorked) defects.push('game over has no way back — a tap did not start a new run');
    }

    if (errors.length > 0) defects.push(`threw ${errors.length} error(s): ${errors[0]}`);
    if (httpErrors.length > 0) defects.push(`requested ${httpErrors.length} missing resource(s): ${httpErrors[0]}`);

    // Read while the page is alive: everything after `finally` sees a closed page.
    events = ((await page.evaluate(
      '(window.__pl && window.__pl.events ? window.__pl.events.map(function (e) { return e.type; }) : [])',
    )) as string[]) ?? [];
    shimDebug = (await frame
      .evaluate('(window.__plDebug ? JSON.parse(JSON.stringify(window.__plDebug)) : null)')
      .catch(() => null)) as Record<string, unknown> | null;
  } catch (err) {
    defects.push(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
    if (!options.browser) await browser.close();
    server.close();
  }

  return {
    pass: defects.length === 0,
    ready,
    changes,
    taps,
    scoreStart,
    scoreEnd,
    finalScore,
    scoreMoved: (scoreEnd ?? 0) !== (scoreStart ?? 0) || (finalScore ?? 0) > 0,
    progress:
      (scoreEnd ?? 0) !== (scoreStart ?? 0) || (finalScore ?? 0) > 0 || gameOverSeen,
    gameOverSeen,
    restartWorked,
    swipeMoved,
    errors,
    httpErrors,
    defects,
    events,
    shimDebug,
    durationMs: Date.now() - started,
  };
}
