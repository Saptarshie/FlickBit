import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SHIM_SOURCE } from '@playloop/sdk';
import { allowedEmbedders, artifactUrl, createApp, injectShim } from '../src/app';

// frame-ancestors pins who may embed an artifact (see src/app.ts).
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; " +
  "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; " +
  "frame-src 'none'; form-action 'none'; base-uri 'none'; " +
  'frame-ancestors http://localhost:3000';

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gameHtml(): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<script type="application/json" id="pl-manifest">',
    '{"title":"Test Game","description":"A tiny test game","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":["arcade"],"scoring":"higher"}',
    '</script>',
    '<script>',
    '/* GAME_SCRIPT_MARKER */',
    'function frame() { PlayLoop.ready(); }',
    'frame();',
    '</script>',
    '</head>',
    '<body><canvas id="c"></canvas></body>',
    '</html>',
    '',
  ].join('\n');
}

let artifactsDir: string;
let app: ReturnType<typeof createApp>;
let validSha: string;

beforeAll(() => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'play-worker-test-'));
  app = createApp({ artifactsDir });

  // 1. a real, valid artifact: content-addressed, manifest present
  const html = gameHtml();
  validSha = sha256Hex(html);
  writeFileSync(path.join(artifactsDir, `${validSha}.html`), html);

  // 2. hash mismatch: file named after the hash of DIFFERENT bytes
  const mismatchBytes = Buffer.from(gameHtml().replace('Test Game', 'Evil Game'), 'utf8');
  writeFileSync(path.join(artifactsDir, `${sha256Hex('not the real bytes')}.html`), mismatchBytes);

  // 3. no manifest: hash matches its own bytes but no pl-manifest
  const noManifest = '<!doctype html>\n<html><head><title>x</title></head><body>hi</body></html>\n';
  writeFileSync(path.join(artifactsDir, `${sha256Hex(noManifest)}.html`), noManifest);
});

afterAll(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

describe('GET /healthz', () => {
  it('returns 200 {ok:true}', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /v/:sha.html', () => {
  it('serves the artifact with the exact security headers', async () => {
    const res = await request(app).get(`/v/${validSha}.html`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    // Content-addressed by the game, but the body inlines the shim, so it must
    // revalidate: an immutable shim pinned players to a frozen input path.
    expect(res.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('injects the shim script before the game script', async () => {
    const res = await request(app).get(`/v/${validSha}.html`);
    expect(res.status).toBe(200);
    const body = res.text;
    // body is exactly the original html with the shim injected
    expect(body).toBe(injectShim(gameHtml(), SHIM_SOURCE));
    const shimIndex = body.indexOf('<script>' + SHIM_SOURCE + '</script>');
    const gameIndex = body.indexOf('GAME_SCRIPT_MARKER');
    expect(shimIndex).toBeGreaterThan(-1);
    expect(gameIndex).toBeGreaterThan(-1);
    expect(shimIndex).toBeLessThan(gameIndex);
    // the shim sits immediately after the opening <head> tag
    expect(body.indexOf('<head>') + '<head>'.length).toBe(shimIndex);
  });

  it('returns 404 not_found for an unknown sha', async () => {
    const res = await request(app).get(`/v/${'a'.repeat(64)}.html`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found' } });
  });

  it('returns 404 not_found for a malformed sha', async () => {
    for (const bad of ['notasha.html', `${'z'.repeat(64)}.html`, `${'a'.repeat(63)}.html`]) {
      const res = await request(app).get(`/v/${bad}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'not_found' } });
    }
  });

  it('returns 409 hash_mismatch when the bytes do not match the sha', async () => {
    const sha = sha256Hex('not the real bytes');
    const res = await request(app).get(`/v/${sha}.html`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'hash_mismatch' } });
  });

  it('returns 404 no_manifest when the artifact has no manifest (a content fault, not a server one)', async () => {
    const noManifest = '<!doctype html>\n<html><head><title>x</title></head><body>hi</body></html>\n';
    const sha = sha256Hex(noManifest);
    const res = await request(app).get(`/v/${sha}.html`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'no_manifest' } });
  });
});

describe('allowedEmbedders', () => {
  it('never uses the play origin, which would block the app that embeds games', () => {
    // The regression: PLAY_ORIGIN leaked into frame-ancestors, so every game
    // frame in the feed loaded as chrome-error.
    expect(allowedEmbedders({ PLAY_ORIGIN: 'http://localhost:3001' })).toBe('http://localhost:3000');
  });

  it('takes the app origin and accepts a list', () => {
    expect(allowedEmbedders({ APP_ORIGIN: 'https://play.example.com' })).toBe('https://play.example.com');
    expect(allowedEmbedders({ APP_ORIGIN: 'https://a.example, https://b.example' })).toBe(
      'https://a.example https://b.example',
    );
  });
});

describe('artifactUrl', () => {
  it('builds the expected url', () => {
    const sha = 'b'.repeat(64);
    expect(artifactUrl('https://play.example.com', sha)).toBe(
      `https://play.example.com/v/${sha}.html`,
    );
  });
});

describe('injectShim', () => {
  it('prepends the shim when there is no head tag', () => {
    const out = injectShim('<html><body>hi</body></html>', 'SHIM');
    expect(out).toBe('<script>SHIM</script><html><body>hi</body></html>');
  });
});
