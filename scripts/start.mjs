/**
 * Production runner: `pnpm start`.
 *
 * Starts the same three processes as `pnpm dev`, but serving the built app:
 *   1. database      — only when DATABASE_URL points at this machine and nothing
 *                      is listening there (PGlite wire server, no Docker needed)
 *   2. play-worker   — :3001, serves artifacts + the runtime smoke service
 *   3. next start    — :3000, the production build in apps/web/.next
 *
 * Requires `pnpm build` first. Point DATABASE_URL at a real Postgres and set
 * PLAYLOOP_DB=external to skip the embedded database entirely.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Same root .env loading the app uses, so ports and URLs agree.
const envPath = path.join(root, '.env');
if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const buildId = path.join(root, 'apps', 'web', '.next', 'BUILD_ID');
if (!existsSync(buildId)) {
  console.error('\n[start] no production build found. Run:\n\n  pnpm build\n\nthen `pnpm start` again.\n');
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function run(label, command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_ENV: 'production' },
    ...opts,
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`\n[start] ${label} exited with code ${code}. Shutting down.`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const waitForPort = (port, host = '127.0.0.1', timeoutMs = 60_000) => {
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
};

const listening = async (port) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  return new Promise((resolve) => {
    socket.setTimeout(600);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
};

const dbPort = Number.parseInt(process.env.DB_PORT ?? '5432', 10);
const databaseUrl = process.env.DATABASE_URL ?? '';
const localDb = /@(127\.0\.0\.1|localhost)[:/]/.test(databaseUrl) || databaseUrl === '';
const externalDb = process.env.PLAYLOOP_DB === 'external' || !localDb;

if (externalDb) {
  console.log('[start] using the external database from DATABASE_URL');
} else if (await listening(dbPort)) {
  console.log(`[start] database already listening on :${dbPort}`);
} else {
  console.log('[start] starting the embedded database (PGlite + pgvector)...');
  run('db', 'pnpm', ['exec', 'tsx', path.join(root, 'scripts', 'dev-db.ts')]);
  if (!(await waitForPort(dbPort))) {
    console.error(`[start] database did not come up on :${dbPort}`);
    shutdown(1);
  }
}

console.log('[start] starting play-worker and the production web server...\n');
// Run the worker inside its own package: ARTIFACTS_DIR defaults to a path
// relative to the process cwd, so starting it from the repo root doubled it to
// apps/play-worker/apps/play-worker/artifacts and every game 404'd.
run('worker', 'pnpm', ['exec', 'tsx', 'src/server.ts'], { cwd: path.join(root, 'apps', 'play-worker') });
run('web', 'pnpm', ['--filter', '@playloop/web', 'exec', 'next', 'start']);

const webOk = await waitForPort(3000);
const workerOk = await waitForPort(3001);
console.log(
  `\n[start] web        http://localhost:3000  ${webOk ? 'ready' : 'NOT READY'}\n` +
    `[start] artifacts  http://localhost:3001  ${workerOk ? 'ready' : 'NOT READY'}\n`,
);
