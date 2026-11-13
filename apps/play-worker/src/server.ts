import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app';

const port = Number.parseInt(process.env.PORT ?? '', 10) || 3001;

/**
 * Find the monorepo root without trusting the cwd.
 *
 * `.env` sets `ARTIFACTS_DIR=./apps/play-worker/artifacts`, which is relative to
 * the REPO ROOT. Resolving it against the cwd silently produced
 * `apps/play-worker/apps/play-worker/artifacts` whenever the worker was launched
 * from inside its package (pnpm start did exactly that) and every game 404'd.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const artifactsDir = process.env.ARTIFACTS_DIR
  ? path.resolve(repoRoot(), process.env.ARTIFACTS_DIR)
  : path.join(repoRoot(), 'apps', 'play-worker', 'artifacts');

mkdirSync(artifactsDir, { recursive: true });

// Engines live beside the artifacts and are addressed by hash, so this one
// directory is the whole "shared runtime" story for the server.
// Assets sit beside the artifacts and are addressed by hash too: /a/<sha16>.webp
// is immutable, shared by every game that draws that sprite.
const assetsDir = process.env.ASSETS_DIR
  ? path.resolve(repoRoot(), process.env.ASSETS_DIR)
  : path.join(path.dirname(artifactsDir), 'assets');
mkdirSync(assetsDir, { recursive: true });

const runtimesDir = process.env.RUNTIMES_DIR
  ? path.resolve(repoRoot(), process.env.RUNTIMES_DIR)
  : path.join(path.dirname(artifactsDir), 'runtimes');
mkdirSync(runtimesDir, { recursive: true });

const app = createApp({ artifactsDir, runtimesDir, assetsDir });
/**
 * Bind dual-stack.
 *
 * '127.0.0.1' looked safer but breaks the app: browsers resolve `localhost` to
 * ::1 first, so every game frame failed with chrome-error. '::' accepts both
 * families. The dangerous endpoint is /internal/smoke, which is guarded on its
 * own (loopback caller + optional token) rather than by the bind address.
 */
const host = process.env.HOST ?? '::';
app.listen(port, host, () => {
  console.log(`play-worker listening on http://${host}:${port} (artifacts: ${artifactsDir}, runtimes: ${runtimesDir})`);
});
