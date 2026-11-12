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

const app = createApp({ artifactsDir });
app.listen(port, () => {
  console.log(`play-worker listening on http://localhost:${port} (artifacts: ${artifactsDir})`);
});
