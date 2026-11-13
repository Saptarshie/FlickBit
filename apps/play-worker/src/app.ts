import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { extractManifest } from '@playloop/gamekit';
import { runSmokeTest } from '@playloop/gamekit/smoke';
import { playtest } from '@playloop/gamekit/playtest';
import { captureFrames } from '@playloop/gamekit/capture';
import { RUNTIMES, SHIM_SOURCE, type RuntimeId, runtimeFileName } from '@playloop/sdk';

/** The exact CSP required on the play origin (docs/03-game-artifact-spec.md). */
// `frame-ancestors` pins who may embed an artifact: without it any site could
// frame a game and click-jack the player.
//
// It must be the APP's origin, not the play origin. This used to fall back to
// PLAY_ORIGIN, and `pnpm start` exports .env into every child — so the worker
// announced "only :3001 may embed me" and every game frame in the feed became
// chrome-error. APP_ORIGIN (comma-separated for several deployments) is the
// canonical setting.
export function allowedEmbedders(env: Record<string, string | undefined> = process.env): string {
  // Deliberately ignores PLAY_ORIGIN: that is where artifacts are SERVED from,
  // and allowing it means the feed's own origin (:3000) is blocked.
  return (env.APP_ORIGIN || env.PLAYER_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .join(' ');
}

const WEB_ORIGINS = allowedEmbedders();

/**
 * `embedders` exists so tests and benchmarks can mount the worker on an
 * ephemeral port without weakening the production default: the header is still
 * derived from the caller, never from the request.
 */
export function contentSecurityPolicy(embedders: string = WEB_ORIGINS): string {
  return (
    "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; " +
    // 'self' is required for the content-addressed sprite catalogue at /a/;
    // connect-src stays 'none', so a game still cannot open a socket.
    "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src data:; connect-src 'none'; " +
    "frame-src 'none'; form-action 'none'; base-uri 'none'; " +
    `frame-ancestors ${embedders}`
  );
}

const CSP = contentSecurityPolicy();

/**
 * The URL is content-addressed by the GAME hash, but the response also carries
 * the guest shim, which changes with the SDK. `immutable, max-age=1y` therefore
 * pinned players to whatever shim they first loaded: input replay fixes never
 * reached them and every game looked frozen while the server was correct.
 * Revalidate every time instead; the ETag turns it into a 304 on the wire.
 */
const CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** Artifact filenames are exactly 64 lowercase hex chars + .html — anything else 404s. */
const ARTIFACT_FILE_RE = /^([0-9a-f]{64})\.html$/;

/**
 * A runtime file: `<id>@<version>-<16 hex>.js`. The hash makes the URL
 * content-addressed, which is what lets it be cached immutably for a year
 * while a game can still pin an exact build.
 */
const RUNTIME_FILE_RE = /^([a-z0-9-]+)@(\d+\.\d+\.\d+)-([0-9a-f]{16})\.js$/;
/** Content-addressed assets: <sha256[0:16]>.<ext>. */
const ASSET_FILE_RE = /^([0-9a-f]{16})\.(webp|png|ogg|mp3|json)$/;

export type ServedRuntime = {
  file: string;
  id: string;
  version: string;
  integrity: string;
  bytes: number;
};

/** sha384 base64 — the SRI attribute this file must carry. */
export function sriFor(bytes: Buffer): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

/**
 * Insert the guest shim as an inline <script> immediately after the opening
 * <head> tag (so it runs before any game script), or prepend it when the
 * document has no <head> at all.
 */
export function injectShim(html: string, shimSource: string, engineSrc?: string): string {
  const tag = `<script>${shimSource}</script>` + (engineSrc ? `<script src="${engineSrc}"></script>` : '');
  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (headMatch !== null) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

/** Canonical public URL for a content-addressed artifact. */
export function artifactUrl(base: string, sha: string): string {
  return base + '/v/' + sha + '.html';
}

function sendError(
  res: express.Response,
  status: number,
  code:
    | 'not_found'
    | 'hash_mismatch'
    | 'no_manifest'
    | 'forbidden'
    | 'payload_too_large'
    | 'internal'
    | 'runtime_unavailable',
): void {
  res.status(status).json({ error: { code } });
}

const EMPTY_RUNTIMES = new Map<string, ServedRuntime>();

/**
 * Index the runtime directory: `<id>@<version>-<hash>.js`.
 *
 * The file name carries its own digest, so a swapped or truncated file is
 * detectable at boot instead of at the player's expense. A mismatch is a hard
 * error: serving an engine under a hash it does not have would silently defeat
 * both the immutable cache and the artifact's pin.
 */
export function loadRuntimes(dir: string): Map<string, ServedRuntime> {
  const out = new Map<string, ServedRuntime>();
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    const match = RUNTIME_FILE_RE.exec(file);
    if (match === null) continue;
    const bytes = readFileSync(path.join(dir, file));
    // The name carries the first 16 hex chars of the same digest SRI uses.
    const hex = createHash('sha384').update(bytes).digest('hex');
    if (match[3] !== hex.slice(0, 16)) {
      console.warn(`[runtimes] ${file} does not match its own hash; ignoring it`);
      continue;
    }
    const integrity = sriFor(bytes);
    out.set(file, {
      file,
      id: match[1] as string,
      version: match[2] as string,
      integrity,
      bytes: bytes.byteLength,
    });
  }
  return out;
}

export function createApp(opts: { artifactsDir: string; runtimesDir?: string; assetsDir?: string; embedders?: string }): express.Express {
  const app = express();
  // Resolved once; :sha is validated to 64 lowercase hex before any fs access,
  // so path.join can never escape this directory.
  const artifactsDir = path.resolve(opts.artifactsDir);
  const runtimesDir = opts.runtimesDir ? path.resolve(opts.runtimesDir) : null;
  const assetsDir = opts.assetsDir ? path.resolve(opts.assetsDir) : null;
  const runtimes = runtimesDir ? loadRuntimes(runtimesDir) : EMPTY_RUNTIMES;
  const csp = contentSecurityPolicy(opts.embedders ?? WEB_ORIGINS);

  /** The exact build a game pinned, or the newest one we hold for that engine. */
  function runtimeFor(id: string, version?: string): ServedRuntime | null {
    let best: ServedRuntime | null = null;
    for (const runtime of runtimes.values()) {
      if (runtime.id !== id) continue;
      if (version !== undefined && runtime.version !== version) continue;
      if (best === null || runtime.version.localeCompare(best.version, undefined, { numeric: true }) > 0) {
        best = runtime;
      }
    }
    return best;
  }

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  /**
   * Runtime gate, hosted here because this process is plain Node: the Next app
   * cannot bundle Playwright (chromium-bidi fails to resolve) and should not.
   *
   * This endpoint drives a headless browser over caller-supplied HTML, so it is
   * guarded: loopback callers only, plus a shared token when one is configured.
   * (It used to be reachable from anywhere the worker was, which on a laptop
   * meant the whole LAN.)
   */
  const internalOnly: express.RequestHandler = (req, res, next) => {
    const remote = req.socket.remoteAddress ?? '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const token = process.env.PLAYLOOP_INTERNAL_TOKEN;
    if (!loopback) {
      sendError(res, 403, 'forbidden');
      return;
    }
    if (token && req.get('x-internal-token') !== token) {
      sendError(res, 403, 'forbidden');
      return;
    }
    next();
  };

  app.post('/internal/smoke', internalOnly, express.json({ limit: '1mb' }), async (req, res) => {
    const html = typeof req.body?.html === 'string' ? req.body.html : '';
    if (!html) {
      res.status(400).json({ error: { code: 'missing_html', message: 'Send { html }' } });
      return;
    }
    try {
      const report = await runSmokeTest(html, { timeoutMs: 30_000 });
      res.status(200).json({
        pass: report.pass,
        fps: report.fps,
        blankScreen: report.blankScreen,
        interactive: report.interactive,
        consoleErrors: report.consoleErrors.slice(0, 8),
        uncaught: report.uncaught.slice(0, 5),
      });
    } catch (err) {
      res.status(500).json({ error: { code: 'smoke_failed', message: err instanceof Error ? err.message : String(err) } });
    }
  });

  /**
   * The runtime index: what this origin can serve, with URLs and SRI. The feed
   * reads it once per session to plan prefetches, so it must stay small and
   * cheap (it is a few hundred bytes).
   */
  /**
   * Playtest gate, beside the smoke gate and for the same reason: this is the
   * only process that can own Playwright. It answers "can a player actually
   * play this" — taps move the world, the run reaches an end, and a tap after
   * the end starts a new one.
   */
  app.post('/internal/playtest', internalOnly, express.json({ limit: '1mb' }), async (req, res) => {
    const html = typeof req.body?.html === 'string' ? req.body.html : '';
    const scoring = req.body?.scoring === 'none' || req.body?.scoring === 'lower' ? req.body.scoring : 'higher';
    if (!html) {
      res.status(400).json({ error: { code: 'missing_html', message: 'Send { html }' } });
      return;
    }
    try {
      const report = await playtest(html, { scoring });
      res.status(200).json(report);
    } catch (err) {
      res.status(500).json({ error: { code: 'playtest_failed', message: err instanceof Error ? err.message : String(err) } });
    }
  });

  /**
   * Screenshots for the visual reviewer. Same isolation as the other gates, and
   * the same rule: only this process may own a browser.
   */
  app.post('/internal/capture', internalOnly, express.json({ limit: '1mb' }), async (req, res) => {
    const html = typeof req.body?.html === 'string' ? req.body.html : '';
    if (!html) {
      res.status(400).json({ error: { code: 'missing_html', message: 'Send { html }' } });
      return;
    }
    try {
      const frames = await captureFrames(html);
      res.status(200).json(frames);
    } catch (err) {
      res.status(500).json({ error: { code: 'capture_failed', message: err instanceof Error ? err.message : String(err) } });
    }
  });

  app.get('/r/index.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', allowedEmbedders().split(' ')[0] ?? '*');
    res.json({
      runtimes: [...runtimes.values()].map((runtime) => ({
        id: runtime.id,
        version: runtime.version,
        file: runtime.file,
        url: `/r/${runtime.file}`,
        integrity: runtime.integrity,
        bytes: runtime.bytes,
      })),
    });
  });

  /**
   * The asset catalogue. Small JSON, revalidated, so the studio can list what is
   * available without shipping a copy of the index inside every build.
   */
  app.get('/a/index.json', async (_req, res) => {
    if (assetsDir === null) {
      res.status(200).json({ version: 1, assets: [] });
      return;
    }
    try {
      const body = await readFile(path.join(assetsDir, 'index.json'));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.send(body);
    } catch {
      res.status(200).json({ version: 1, assets: [] });
    }
  });

  /**
   * Asset bytes. Same contract as engines: the file name *is* the hash, so a
   * year-long immutable cache is truthful, and a sprite shared by fifty games is
   * downloaded once per browser.
   */
  app.get('/a/:file', async (req, res) => {
    const name = req.params.file ?? '';
    if (ASSET_FILE_RE.exec(name) === null || assetsDir === null) {
      sendError(res, 404, 'not_found');
      return;
    }
    const ext = name.split('.').pop();
    const type = ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : ext === 'json' ? 'application/json' : 'audio/ogg';
    try {
      const bytes = await readFile(path.join(assetsDir, name));
      res.setHeader('Content-Type', `${type}; charset=utf-8`.replace('; charset=utf-8', ext === 'webp' || ext === 'png' ? '' : '; charset=utf-8'));
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(bytes);
    } catch {
      sendError(res, 404, 'not_found');
    }
  });

  /**
   * Engine files. Content-addressed, so `immutable` is honest: those exact
   * bytes can never change. This is what makes "load the engine once" true —
   * the second game on the same engine reads it from the HTTP cache (and the
   * V8 code cache) with no request at all.
   */
  app.get('/r/:file', async (req, res) => {
    const name = req.params.file ?? '';
    if (RUNTIME_FILE_RE.exec(name) === null || runtimesDir === null) {
      sendError(res, 404, 'not_found');
      return;
    }
    const known = runtimes.get(name);
    try {
      const bytes = await readFile(path.join(runtimesDir, name));
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (known) res.setHeader('X-Integrity', known.integrity);
      res.send(bytes);
    } catch {
      sendError(res, 404, 'not_found');
    }
  });

  app.get('/v/:file', async (req, res) => {
    const match = ARTIFACT_FILE_RE.exec(req.params.file ?? '');
    if (match === null) {
      sendError(res, 404, 'not_found');
      return;
    }
    const sha = match[1] as string;
    const filePath = path.join(artifactsDir, `${sha}.html`);

    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      // missing or unreadable
      sendError(res, 404, 'not_found');
      return;
    }

    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== sha) {
      sendError(res, 409, 'hash_mismatch');
      return;
    }

    const html = bytes.toString('utf8');
    const manifest = extractManifest(html);
    if (manifest === null) {
      // A content defect, not a server fault: the artifact is what is wrong.
      sendError(res, 404, 'no_manifest');
      return;
    }

    // A game that names an engine is only playable when that exact build is
    // present. Serving the HTML anyway produces a blank frame and a console
    // ReferenceError inside the sandbox — the failure the player cannot
    // diagnose. Answer loudly instead so the card can offer Retry.
    let engineSrc: string | undefined;
    const runtimeId = manifest.runtime;
    if (runtimeId !== undefined && runtimeId !== 'micro') {
      if (!(runtimeId in RUNTIMES)) {
        sendError(res, 503, 'runtime_unavailable');
        return;
      }
      const runtime = runtimeFor(runtimeId, manifest.runtimeVersion);
      if (runtime === null) {
        sendError(res, 503, 'runtime_unavailable');
        return;
      }
      engineSrc = `/r/${runtime.file}`;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(injectShim(html, SHIM_SOURCE, engineSrc));
  });

  // Every unmatched route (unknown artifact, traversal attempts, anything
  // else) gets the same JSON 404.
  app.use((_req, res) => {
    sendError(res, 404, 'not_found');
  });

  // Express's default error handler prints an HTML stack trace (absolute paths
  // included) when NODE_ENV is not production; answer with the JSON envelope.
  app.use((err: { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.type === 'entity.too.large' ? 413 : (err.status ?? 500);
    sendError(res, status, status === 413 ? 'payload_too_large' : 'internal');
  });

  return app;
}
