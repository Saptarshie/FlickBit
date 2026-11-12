import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { extractManifest } from '@playloop/gamekit';
import { runSmokeTest } from '@playloop/gamekit/smoke';
import { SHIM_SOURCE } from '@playloop/sdk';

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

const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; " +
  "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; " +
  "frame-src 'none'; form-action 'none'; base-uri 'none'; " +
  `frame-ancestors ${WEB_ORIGINS}`;

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
 * Insert the guest shim as an inline <script> immediately after the opening
 * <head> tag (so it runs before any game script), or prepend it when the
 * document has no <head> at all.
 */
export function injectShim(html: string, shimSource: string): string {
  const tag = `<script>${shimSource}</script>`;
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
  code: 'not_found' | 'hash_mismatch' | 'no_manifest' | 'forbidden' | 'payload_too_large' | 'internal',
): void {
  res.status(status).json({ error: { code } });
}

export function createApp(opts: { artifactsDir: string }): express.Express {
  const app = express();
  // Resolved once; :sha is validated to 64 lowercase hex before any fs access,
  // so path.join can never escape this directory.
  const artifactsDir = path.resolve(opts.artifactsDir);

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
    if (extractManifest(html) === null) {
      // A content defect, not a server fault: the artifact is what is wrong.
      sendError(res, 404, 'no_manifest');
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(injectShim(html, SHIM_SOURCE));
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
