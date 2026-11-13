import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SHIM_SOURCE } from '@playloop/sdk';
import { allowedEmbedders, artifactUrl, createApp, injectShim, loadRuntimes } from '../src/app';

// frame-ancestors pins who may embed an artifact (see src/app.ts).
const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src data:; connect-src 'none'; " +
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

// ---------------------------------------------------------------------------
// Shared runtimes: the engine is served once, by hash, and pinned per game.
// ---------------------------------------------------------------------------

describe('runtime serving', () => {
  let dir: string;
  let runtimeApp: ReturnType<typeof createApp>;
  let engineFile: string;
  let engineSha: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'play-worker-runtimes-'));
    const engine = Buffer.from('/* fake engine */ window.PHASER = { VERSION: "4.2.1" };', 'utf8');
    engineSha = createHash('sha384').update(engine).digest('hex');
    engineFile = `phaser4@4.2.1-${engineSha.slice(0, 16)}.js`;
    writeFileSync(path.join(dir, engineFile), engine);
    runtimeApp = createApp({ artifactsDir: dir, runtimesDir: dir });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('indexes a runtime by its file name and rejects one whose bytes were swapped', () => {
    const index = loadRuntimes(dir);
    expect([...index.keys()]).toEqual([engineFile]);

    const tampered = `phaser4@4.2.1-${'0'.repeat(16)}.js`;
    writeFileSync(path.join(dir, tampered), 'not the bytes the name promises');
    expect(loadRuntimes(dir).has(tampered)).toBe(false);
    rmSync(path.join(dir, tampered));
  });

  it('serves the engine immutably with its integrity hash', async () => {
    const res = await request(runtimeApp).get(`/r/${engineFile}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.headers['cache-control']).toContain('immutable');
    const onDisk = readFileSync(path.join(dir, engineFile));
    expect(res.headers['x-integrity']).toBe(`sha384-${createHash('sha384').update(onDisk).digest('base64')}`);
  });

  it('404s a traversal attempt and an unknown engine', async () => {
    expect((await request(runtimeApp).get('/r/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await request(runtimeApp).get('/r/nope@1.0.0-0000000000000000.js')).status).toBe(404);
  });

  it('lists what the origin can serve', async () => {
    const res = await request(runtimeApp).get('/r/index.json');
    expect(res.status).toBe(200);
    expect(res.body.runtimes[0]).toMatchObject({ id: 'phaser4', version: '4.2.1', url: `/r/${engineFile}` });
  });

  it('injects the pinned engine before the game code, and only when the game asks', async () => {
    const plain = await request(runtimeApp).get(`/v/${validSha}.html`);
    expect(plain.text).not.toContain('<script src="/r/');

    const withEngine = Buffer.from(
      gameHtml().replace('"scoring":"higher"', '"scoring":"higher","runtime":"phaser4","runtimeVersion":"4.2.1"'),
      'utf8',
    );
    const sha = sha256Hex(withEngine);
    writeFileSync(path.join(dir, `${sha}.html`), withEngine);

    const res = await request(runtimeApp).get(`/v/${sha}.html`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<script src="/r/${engineFile}"></script>`);
    // The shim comes first: the protocol must exist before any engine uses it.
    expect(res.text.indexOf('<script>')).toBeLessThan(res.text.indexOf(`<script src="/r/${engineFile}">`));
  });

  it('answers 503 (not a blank frame) when a game pins an engine this origin does not hold', async () => {
    const orphan = Buffer.from(
      gameHtml().replace('"scoring":"higher"', '"scoring":"higher","runtime":"babylon","runtimeVersion":"9.36.0"'),
      'utf8',
    );
    const sha = sha256Hex(orphan);
    writeFileSync(path.join(dir, `${sha}.html`), orphan);

    const res = await request(runtimeApp).get(`/v/${sha}.html`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('runtime_unavailable');
  });
});
