/**
 * Stop everything this repo started: `pnpm stop`.
 *
 * `pnpm dev` / `pnpm start` run a database, an artifact worker and Next — each
 * behind a pnpm/turbo wrapper, and Next spawns its own workers. Closing the
 * terminal can leave any of them behind, and the next start then dies with
 * EADDRINUSE (or, worse, two databases open one PGlite directory and corrupt
 * it). This finds every node process whose command line points into this repo
 * and stops it, then reports which ports are free.
 *
 * Windows has no SIGTERM for console apps, so this is a hard stop; the database
 * takes a snapshot on every boot and repairs itself if a kill left it damaged.
 */
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const isWindows = process.platform === 'win32';
const PORTS = [3000, 3001, 5432];

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function pidsForRepo() {
  if (!isWindows) {
    const out = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes(root) && !line.includes('scripts/stop.mjs'))
      .map((line) => Number.parseInt(line.split(/\s+/)[0], 10))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
  }

  const script = `
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*${root.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*stop.mjs*' } |
      Select-Object -ExpandProperty ProcessId
  `;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
}

const pids = pidsForRepo();
if (pids.length === 0) {
  console.log('[stop] nothing of this repo is running');
} else {
  for (const pid of pids) {
    try {
      execFileSync(isWindows ? 'taskkill' : 'kill', isWindows ? ['/PID', String(pid), '/F'] : ['-9', String(pid)], {
        stdio: 'ignore',
      });
      console.log(`[stop] stopped ${pid}`);
    } catch {
      // Already gone.
    }
  }
}

// Wait for the sockets to actually close before telling anyone it is free.
for (let attempt = 0; attempt < 20; attempt += 1) {
  const busy = [];
  for (const port of PORTS) if (await listening(port)) busy.push(port);
  if (busy.length === 0) {
    console.log('[stop] ports free: ' + PORTS.join(', '));
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const stillBusy = [];
for (const port of PORTS) if (await listening(port)) stillBusy.push(port);
console.error(`[stop] still listening on ${stillBusy.join(', ')} — something outside this repo owns the port.`);
if (isWindows) console.error('[stop] find it with: netstat -ano | findstr :3000');
process.exit(1);
