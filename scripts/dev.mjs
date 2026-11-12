/**
 * One-command dev stack: `pnpm dev`
 *
 *   1. scripts/dev-db.ts   -> PGlite over the Postgres wire protocol on :5432
 *                             (migrate + seed + artifacts, no Docker needed)
 *   2. turbo run dev       -> apps/web on :3000, apps/play-worker on :3001
 *
 * The db server is started first and its readiness is awaited, so the web app
 * never boots against a dead database. Ctrl-C tears everything down.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const children = [];

// Dev builds into `.next-dev` (see apps/web/next.config.ts) so `next build` can
// run at any time without deleting the running server's manifest. A production
// marker can only appear here if someone built with NEXT_DIST_DIR pointing at
// it, so clear that case and never touch `.next` (that is the build output).
const devNextDir = path.join(root, 'apps', 'web', '.next-dev');
if (existsSync(path.join(devNextDir, 'BUILD_ID'))) {
  console.log('[dev] clearing a production build from the dev output directory');
  rmSync(devNextDir, { recursive: true, force: true });
}
let shuttingDown = false;

function run(label, command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${label} exited with code ${code}. Shutting down.`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 500);
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/**
 * Refuse to start next to an existing stack with a message that says what to do.
 * Two dev servers silently fight over :3000 and the second one dies with a
 * Turbo error that looks like a code problem.
 */
async function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(600);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const dbPort = Number.parseInt(process.env.DB_PORT ?? '5432', 10);

for (const [port, name] of [
  [3000, 'the web app'],
  [3001, 'the artifact worker'],
]) {
  if (await portInUse(port)) {
    console.error(`[dev] port ${port} (${name}) is already in use — something is still running.`);
    console.error('      Stop it (Ctrl-C in that terminal, or kill the process on that port)');
    console.error('      and run `pnpm dev` again.');
    process.exit(1);
  }
}

console.log('[dev] starting database (PGlite + pgvector, no Docker required)...');
run('db', 'pnpm', ['exec', 'tsx', path.join(root, 'scripts', 'dev-db.ts')]);

try {
  await waitForPort(dbPort);
} catch (err) {
  console.error(`[dev] database failed to start: ${err.message}`);
  shutdown(1);
}

console.log('[dev] database ready -> starting web + play-worker\n');
run('apps', 'pnpm', ['exec', 'turbo', 'run', 'dev']);
