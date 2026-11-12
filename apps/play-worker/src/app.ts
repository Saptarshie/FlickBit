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
const ALLOWED_EMBEDDER = process.env.PLAYER_ORIGIN || process.env.PLAY_ORIGIN || 'http://localhost:3000';

const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; " +
  "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; " +
  "frame-src 'none'; form-action 'none'; base-uri 'none'; " +
  `frame-ancestors ${ALLOWED_EMBEDDER}`;

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
  code: 'not_found' | 'hash_mismatch' | 'no_manifest',
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
   * Localhost-only; the web app calls it during generation.
   */
  app.post('/internal/smoke', express.json({ limit: '1mb' }), async (req, res) => {
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
      sendError(res, 500, 'no_manifest');
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

  return app;
}
