import { chromium, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { SHIM_SOURCE } from '../../sdk/src/shim-source';
import { injectShim } from './inject';

export type SmokeReport = {
  pass: boolean;
  readyWithin3s: boolean;
  consoleErrors: string[];
  uncaught: string[];
  blankScreen: boolean;
  interactive: boolean;
  fps: number;
  framesDiffer: boolean;
  screenshots: string[];
};

export interface SmokeOptions {
  /** Directory the two screenshots are written to (default: os.tmpdir()). */
  workDir?: string;
  /** Budget for Playwright navigation/action timeouts (default: 30000). */
  timeoutMs?: number;
}

/** The page-side harness installs `window.__pl`; typed locally so this module
 * does not need a global augmentation to be consumed by other packages. */
type HarnessEvents = NonNullable<{ __pl?: { events?: HarnessEventList } }['__pl']>['events'];

type HarnessEventList = {
  errors: { code: string; message: string; stack?: string }[];
  readyAt: number | null;
  gameOver: unknown[];
  score: unknown[];
};

/** Mobile portrait box from the artifact spec: 390x844. */
const VIEWPORT = { width: 390, height: 844 } as const;
const READY_WINDOW_MS = 3000;
const INPUT_MS = 8000;
const FPS_WINDOW_MS = 2000;
/** A single colour covering more than this fraction of samples counts as flat. */
const SINGLE_COLOUR_RATIO = 0.98;
/** Both frames flat only counts as blank when the frames barely changed. */
const NEAR_IDENTICAL_RATIO = 0.995;
/** Resources matching this marker never get a response (blocks window load). */
const HANG_MARKER = '__pl_hang';
const SDK_SRC_DIR = new URL('../../sdk/src/', import.meta.url);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------ */
/* The host side: the real GameHost from packages/sdk, served to the    */
/* harness page. @playloop/sdk is not linked into this package, so the  */
/* contract sources are transpiled from the workspace instead of       */
/* imported through the (absent) workspace link.                       */
/* ------------------------------------------------------------------ */

interface SdkModules {
  hostJs: string;
  protocolJs: string;
}

let sdkCache: SdkModules | null = null;

function transpileSdk(): SdkModules {
  if (sdkCache) return sdkCache;
  const read = (name: string): string => readFileSync(new URL(name, SDK_SRC_DIR), 'utf8');
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  };
  const protocolJs = ts.transpileModule(read('protocol.ts'), {
    compilerOptions,
    fileName: 'protocol.ts',
  }).outputText;
  const hostSource = read('host.ts').replace("from './protocol'", "from './protocol.js'");
  if (!hostSource.includes("from './protocol.js'")) {
    throw new Error("smoke: sdk host.ts no longer imports './protocol'; update transpileSdk()");
  }
  const hostJs = ts.transpileModule(hostSource, {
    compilerOptions,
    fileName: 'host.ts',
  }).outputText;
  sdkCache = { hostJs, protocolJs };
  return sdkCache;
}

function buildHarnessHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>PlayLoop smoke harness</title>
<style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>
</head>
<body>
<iframe id="pl-game" sandbox="allow-scripts" allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope" referrerpolicy="no-referrer" loading="eager"></iframe>
<script type="module">
import { GameHost } from '/sdk/host.js';
const events = { readyAt: null, gameOver: [], score: [], errors: [], perf: [], logs: [] };
const iframe = document.getElementById('pl-game');
const host = new GameHost(iframe, {
  handshakeTimeoutMs: ${READY_WINDOW_MS},
  onReady: function () { if (events.readyAt === null) { events.readyAt = performance.now(); } },
  onGameOver: function (p) { events.gameOver.push(p); },
  onScore: function (p) { events.score.push(p); },
  onError: function (e) { events.errors.push({ message: String((e && e.message) || e), code: e && e.code, stack: e && e.stack }); },
  onPerf: function (p) { events.perf.push(p); },
  onLog: function (p) { events.logs.push(p); },
});
window.__pl = { events: events, host: host };
iframe.src = '/game';
</script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* In-page probes are plain string expressions: evaluate() runs them as  */
/* expressions, so they never depend on transpiler function naming.     */
/* ------------------------------------------------------------------ */

/** Samples requestAnimationFrame ticks over a window; resolves raw counts. */
function fpsProbeSrc(windowMs: number): string {
  return `(() => new Promise((resolve) => {
  let ticks = 0;
  const t0 = performance.now();
  const step = () => {
    ticks += 1;
    const elapsed = performance.now() - t0;
    if (elapsed < ${String(windowMs)}) { requestAnimationFrame(step); }
    else { resolve({ ticks: ticks, ms: elapsed }); }
  };
  requestAnimationFrame(step);
}))()`;
}

interface FrameStats {
  /** Dominant-colour fraction of the t=1s frame. */
  dom1: number;
  /** Dominant-colour fraction of the t=8s frame. */
  dom2: number;
  /** Fraction of sampled pixels with identical colour in both frames. */
  sameRatio: number;
}

/** Colour statistics over every 4th pixel of both screenshots. */
function frameStatsSrc(b64a: string, b64b: string): string {
  return `(() => {
  const load = async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const dominant = (data) => {
    const counts = new Map();
    let total = 0;
    for (let i = 0; i < data.length; i += 16) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
      total += 1;
    }
    let max = 0;
    for (const n of counts.values()) { if (n > max) { max = n; } }
    return total > 0 ? max / total : 1;
  };
  return (async () => {
    const a = await load(${JSON.stringify(b64a)});
    const b = await load(${JSON.stringify(b64b)});
    let same = 0;
    let total = 0;
    for (let i = 0; i < a.length; i += 16) {
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) { same += 1; }
      total += 1;
    }
    return { dom1: dominant(a), dom2: dominant(b), sameRatio: total > 0 ? same / total : 1 };
  })();
})()`;
}

const READY_AT_SRC = '(() => (window.__pl ? window.__pl.events.readyAt : null))()';
const EVENTS_SRC =
  '(() => (window.__pl ? JSON.parse(JSON.stringify(window.__pl.events)) : null))()';

/* ------------------------------------------------------------------ */

async function measureFps(page: Page, windowMs: number): Promise<number> {
  const src = fpsProbeSrc(windowMs);
  const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame());
  const runners: Array<() => Promise<unknown>> = [];
  if (frame) {
    const target = frame;
    runners.push(() => target.evaluate(src));
  }
  runners.push(() => page.evaluate(src));
  for (const run of runners) {
    try {
      const sample = (await run()) as { ticks?: number; ms?: number } | null;
      if (sample && typeof sample.ticks === 'number' && typeof sample.ms === 'number' && sample.ms > 0) {
        return (sample.ticks * 1000) / sample.ms;
      }
    } catch {
      /* context gone or probe rejected: try the next one */
    }
  }
  return 0;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/**
 * Smoke-test one game artifact. The artifact is served with the guest shim
 * injected at the top of <head> (injectShim) inside a sandboxed iframe driven
 * by the real GameHost harness, exactly like the production play Worker serves
 * it. Detection rules follow docs/03-game-artifact-spec.md: ready within 3s,
 * no console errors, no uncaught exceptions, a non-blank frame that changes
 * between t=1s and t=8s of synthetic input, interactivity, and rAF-sampled
 * fps >= 30.
 */
export async function runSmokeTest(html: string, opts: SmokeOptions = {}): Promise<SmokeReport> {
  const workDir = opts.workDir ?? tmpdir();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  mkdirSync(workDir, { recursive: true });

  const gameHtml = injectShim(html, SHIM_SOURCE);
  const sdk = transpileSdk();

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.includes(HANG_MARKER)) {
      return; // never respond: keeps window "load" from ever firing
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.startsWith('/game')) {
      res.end(gameHtml);
    } else if (url.startsWith('/harness')) {
      res.end(buildHarnessHtml());
    } else if (url.startsWith('/sdk/protocol.js')) {
      res.setHeader('content-type', 'text/javascript');
      res.end(sdk.protocolJs);
    } else if (url.startsWith('/sdk/host.js')) {
      res.setHeader('content-type', 'text/javascript');
      res.end(sdk.hostJs);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const origin = 'http://127.0.0.1:' + String(port);

  const consoleErrors: string[] = [];
  const uncaught: string[] = [];

  try {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { ...VIEWPORT } });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => {
        consoleErrors.push('pageerror: ' + err.message);
        uncaught.push(err.stack || err.message);
      });

      await page.goto(origin + '/harness', { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      // --- ready window: wait for the guest ready message (max 3s) ----------
      const readyDeadline = Date.now() + READY_WINDOW_MS;
      while (Date.now() < readyDeadline) {
        const readyAt = (await page.evaluate(READY_AT_SRC)) as number | null;
        if (readyAt !== null) break;
        await sleep(150);
      }

      // --- synthetic input phase: tap center, then random taps/drags/keys ---
      // Screenshots are scheduled against the input clock (t=1s and t=8s) while
      // the input loop keeps running underneath.
      const shot1Promise = sleep(1000).then(() => page.screenshot());
      const shot2Promise = sleep(INPUT_MS).then(() => page.screenshot());
      const fpsPromise = measureFps(page, FPS_WINDOW_MS).catch(() => 0);

      await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);

      // Hold-and-release: charge/jump games only reach their interesting state
      // while the pointer is DOWN. Random taps never held long enough, so a NaN
      // in a charge ratio (Magma Hop's createRadialGradient crash) shipped.
      await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height * 0.75);
      await page.mouse.down();
      await sleep(1400);
      await page.mouse.up();
      await sleep(250);

      // Resize mid-session: a game that recomputes geometry on resize used to
      // throw instead of degrading.
      await page.setViewportSize({ width: 320, height: 568 });
      await sleep(400);
      await page.setViewportSize({ ...VIEWPORT });
      await sleep(200);

      const inputDeadline = Date.now() + INPUT_MS;
      let holdCycles = 0;
      while (Date.now() < inputDeadline) {
        const roll = Math.random();
        const x = randInt(20, VIEWPORT.width - 20);
        const y = randInt(20, VIEWPORT.height - 20);
        if (roll < 0.35) {
          await page.mouse.click(x, y);
        } else if (roll < 0.55 && holdCycles < 4) {
          // Long press, release: exercise charge-style mechanics.
          holdCycles += 1;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await sleep(500 + Math.random() * 900);
          await page.mouse.up();
        } else if (roll < 0.8) {
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(randInt(20, VIEWPORT.width - 20), randInt(20, VIEWPORT.height - 20), {
            steps: 5,
          });
          await page.mouse.up();
        } else {
          const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter'];
          await page.keyboard.press(keys[randInt(0, keys.length - 1)] ?? 'Space');
        }
        await sleep(120 + Math.random() * 220);
      }
      const [shot1, shot2] = await Promise.all([shot1Promise, shot2Promise]);

      const fps = Math.round((await fpsPromise) * 10) / 10;

      // --- analysis -------------------------------------------------------
      const events = (await page.evaluate(EVENTS_SRC)) as HarnessEvents | null;
      for (const e of events?.errors ?? []) {
        if (e.code === 'guest') {
          uncaught.push(e.stack ? String(e.message) + '\n' + String(e.stack) : String(e.message));
        }
      }

      const readyWithin3s = events?.readyAt != null && events.readyAt <= READY_WINDOW_MS;
      const gameOverSeen = (events?.gameOver.length ?? 0) > 0;
      const scoreSeen = (events?.score.length ?? 0) > 0;
      const framesDiffer = !bytesEqual(shot1, shot2);
      const liveness = gameOverSeen || scoreSeen;
      const interactive = framesDiffer || liveness;

      const stats = (await page.evaluate(
        frameStatsSrc(toBase64(shot1), toBase64(shot2)),
      )) as FrameStats;
      // Spec: "byte-identical OR more than 98 percent of sampled pixels are a
      // single colour". Two qualifications keep live games out of the crossfire:
      // - the flat-frame branch additionally requires the frames to be
      //   near-identical (a flat frame that keeps animating is not blank;
      //   shooter's playfield alone is ~98.5% flat background);
      // - a guest that proved liveness (gameOver/score message) rendered
      //   something, even if the t=1s/t=8s frames match byte-for-byte because
      //   the run ended in a static end screen before t=1s.
      const flatFrames =
        stats.dom1 > SINGLE_COLOUR_RATIO &&
        stats.dom2 > SINGLE_COLOUR_RATIO &&
        stats.sameRatio > NEAR_IDENTICAL_RATIO;
      const blankScreen = !liveness && (!framesDiffer || flatFrames);

      // --- persist screenshots -------------------------------------------
      const stamp = Date.now().toString(36) + '-' + randInt(100000, 999999).toString(36);
      const shot1Path = join(workDir, 'pl-smoke-' + stamp + '-t1.png');
      const shot2Path = join(workDir, 'pl-smoke-' + stamp + '-t2.png');
      writeFileSync(shot1Path, shot1);
      writeFileSync(shot2Path, shot2);

      const pass =
        readyWithin3s &&
        consoleErrors.length === 0 &&
        uncaught.length === 0 &&
        !blankScreen &&
        interactive &&
        fps >= 30;

      return {
        pass,
        readyWithin3s,
        consoleErrors,
        uncaught,
        blankScreen,
        interactive,
        fps,
        framesDiffer,
        screenshots: [shot1Path, shot2Path],
      };
    } finally {
      await browser.close();
    }
  } finally {
    await closeServer(server);
  }
}
