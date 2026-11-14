/**
 * Engine injection for the gate harnesses.
 *
 * The worker injects the pinned engine when it serves `/v/<sha>.html`. The gates
 * open artifacts from their own local server instead, so unless they reproduce
 * that step they test a page that references `/r/…` and receives a 404 — which
 * looks exactly like "the game never starts". Every 3D and Phaser template hit
 * this; the fix belongs here, once, rather than in each caller.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { extractManifest } from './validate';

const RUNTIME_FILE_RE = /^([a-z0-9-]+)@(\d+\.\d+\.\d+)-([0-9a-f]{16})\.js$/;

/**
 * Locate `apps/play-worker/runtimes` from wherever the process happens to run.
 *
 * Tests run with cwd set to the package (`packages/gamekit`), the CLI runs from
 * the repo root, and the worker runs from `apps/play-worker`. Walking up until
 * the directory exists is the only version that works in all three.
 */
export function defaultRuntimesDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'apps', 'play-worker', 'runtimes');
    if (existsSync(candidate)) return candidate;
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), 'apps', 'play-worker', 'runtimes');
}

/**
 * Pick the newest published file for an engine id.
 * Returns null when the engine is not on disk (micro games, or a fresh clone
 * before `install-runtime.mjs` has run).
 */
export function runtimeFileFor(id: string, runtimesDir: string): string | null {
  if (!existsSync(runtimesDir)) return null;
  const candidates = readdirSync(runtimesDir).filter((file) => file.startsWith(`${id}@`));
  if (candidates.length === 0) return null;
  const parse = (file: string) => {
    const match = RUNTIME_FILE_RE.exec(file);
    return match ? match[2]!.split('.').map((n) => Number(n)) : [0, 0, 0];
  };
  candidates.sort((a, b) => {
    const [a1, a2, a3] = parse(a);
    const [b1, b2, b3] = parse(b);
    return (b1! - a1!) || (b2! - a2!) || (b3! - a3!);
  });
  return candidates[0] ?? null;
}

/**
 * Engine bytes for a `/r/:file` request, straight from disk. The harnesses serve
 * this themselves so a gate run needs no running play worker.
 */
export function readRuntimeFile(file: string, runtimesDir?: string): Buffer | null {
  if (RUNTIME_FILE_RE.exec(file) === null) return null;
  const dir = runtimesDir ?? defaultRuntimesDir();
  const full = path.join(dir, file);
  if (!existsSync(full)) return null;
  try {
    // Typed as string by this project's @types/node overloads; it is bytes.
    return readFileSync(full) as unknown as Buffer;
  } catch {
    return null;
  }
}

/** Locate `apps/play-worker/assets` the same way engines are located. */
export function defaultAssetsDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'apps', 'play-worker', 'assets');
    if (existsSync(candidate)) return candidate;
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), 'apps', 'play-worker', 'assets');
}

// Must stay in step with the worker's ASSET_FILE_RE: a gate that cannot serve a
// format the platform publishes reports a 404 as "the game is broken".
const ASSET_FILE_RE = /^[0-9a-f]{16}\.(webp|png|ogg|mp3|glb)$/;

/** Asset bytes for a `/a/:file` request, straight from disk. */
export function readAssetFile(file: string, assetsDir?: string): Buffer | null {
  if (ASSET_FILE_RE.exec(file) === null) return null;
  const dir = assetsDir ?? defaultAssetsDir();
  const full = path.join(dir, file);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full) as unknown as Buffer;
  } catch {
    return null;
  }
}

export function assetContentType(file: string): string {
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  return 'audio/ogg';
}

/**
 * Write raw bytes to an http response.
 *
 * `ServerResponse.end` is typed to accept a string first, so passing a Buffer
 * needs a cast; doing it once here keeps the lie in one place, and the bytes are
 * written verbatim at runtime (a JS engine is not safe to round-trip through
 * `latin1`/UTF-8).
 */
export function sendBytes(res: { setHeader(name: string, value: string): void; end(chunk: unknown): void }, type: string, bytes: Buffer): void {
  res.setHeader('content-type', type);
  // The harness frame is sandboxed (opaque origin), so its own asset requests are
  // cross-origin. Without this the playtest gate reports CORS errors for sprites and
  // glTF that work fine in a normal page.
  res.setHeader('access-control-allow-origin', '*');
  res.end(bytes);
}

/**
 * Insert the pinned engine script the way the worker does: after the opening
 * `<head>`, before any game code. No-op when the document already loads a
 * runtime, when it declares none, or when the engine is not published.
 */
export function injectRuntime(
  html: string,
  options: { runtimesDir?: string } = {},
): { html: string; injected: string | null } {
  const manifest = extractManifest(html);
  const id = manifest?.runtime;
  if (!id || id === 'micro') return { html, injected: null };
  if (/<script[^>]+src=["'][^"']*\/r\//i.test(html)) return { html, injected: null };

  const dir = options.runtimesDir ?? defaultRuntimesDir();
  const file = runtimeFileFor(id, dir);
  if (!file) return { html, injected: null };

  const tag = `<script src="/r/${file}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return { html: html.slice(0, at) + tag + html.slice(at), injected: file };
  }
  return { html: `${tag}${html}`, injected: file };
}
