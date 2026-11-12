/**
 * Dev database server: a real PostgreSQL wire-protocol endpoint backed by
 * PGlite (Postgres compiled to WASM) with pgvector, so the whole app runs
 * locally with `pnpm dev` and no Docker/Postgres install.
 *
 * Responsibilities:
 *  1. open/create the on-disk PGlite data directory (persistent across runs)
 *  2. apply drizzle migrations + the raw DDL files (events, stats)
 *  3. seed the 8 template games and write their artifacts to disk
 *  4. listen on DATABASE_URL's port for the app's postgres-js client
 *
 * Not for production: production points DATABASE_URL at a real Postgres.
 */
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@playloop/db';
import { seed } from '@playloop/db/seed';
import { publishPendingSeeds } from './seeds';

const root = fileURLToPath(new URL('..', import.meta.url));

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1000);
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

// Load the repo-root .env so DB_PORT etc. behave the same as in the app.
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
/**
 * A timestamped copy of the data directory, at most one per 12 hours.
 *
 * PGlite is a single WASM process: `Stop-Process -Force` (or a crash) leaves it
 * mid-checkpoint and the next open aborts with an unrecoverable "Aborted()".
 * A recent snapshot is the difference between losing the database and losing
 * twelve hours of it.
 */
async function snapshot(dataDir: string): Promise<void> {
  try {
    const backups = path.join(path.dirname(dataDir), 'backups');
    await mkdir(backups, { recursive: true });
    const existing = (await readdir(backups)).filter((name) => name.startsWith('pglite-')).sort();
    if (!existsSync(path.join(dataDir, 'base'))) return;
    // Always snapshot on boot. A hard kill (no signal, as on Windows) can leave
    // PGlite unable to flush, so the state at boot is the newest one known good.
    const newest = existing[existing.length - 1];
    if (newest && Date.now() - (await stat(path.join(backups, newest))).mtimeMs < 10 * 60 * 1000) return;
    const target = path.join(backups, `pglite-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await cp(dataDir, target, { recursive: true });
    console.log(`[db] snapshot written to ${path.relative(path.join(root), target)}`);
    // Keep the three most recent snapshots.
    const all = (await readdir(backups)).filter((name) => name.startsWith('pglite-')).sort();
    for (const stale of all.slice(0, Math.max(0, all.length - 3))) {
      await rm(path.join(backups, stale), { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[db] snapshot skipped:', err instanceof Error ? err.message : err);
  }
}

/**
 * Can this data directory be opened at all?
 *
 * PGlite compiles Postgres to wasm and the module CANNOT be re-initialised in a
 * process after it has aborted: the old recovery path caught the abort, moved
 * the directory and created a fresh instance — and hit the same abort, leaving
 * the stack dead. So the check runs in a *separate* process, before this one
 * touches the files.
 */
function probeDataDir(dataDir: string): boolean {
  const code = `
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite(${JSON.stringify(dataDir)});
    await db.query('select 1');
    await db.close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(root, 'packages', 'db'),
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status === 0) return true;
  // Last line only: the wasm stack is dozens of frames long and says nothing new.
  const detail = (result.stderr || result.stdout || 'unknown error').trim().split(String.fromCharCode(10)).pop();
  console.warn(`[db] probe failed (${detail ?? 'unknown error'})`);
  return false;
}

/**
 * Open the database, moving a damaged directory aside first.
 *
 * The directory is damaged whenever the process was killed mid-write (a hard
 * kill on Windows sends no signal, so PGlite cannot flush). A snapshot is taken
 * on every boot, so the newest good copy is restored automatically — losing a
 * day of dev data is a lot better than a stack that will not start.
 */
async function prepareDatabase(dataDir: string) {
  const hasData = existsSync(path.join(dataDir, 'base'));
  if (hasData && !probeDataDir(dataDir)) {
    const broken = `${dataDir}.corrupt-${Date.now()}`;
    console.warn(`[db] the data directory is damaged; moving it to ${path.relative(root, broken)}`);
    await rename(dataDir, broken).catch(() => undefined);
    await mkdir(dataDir, { recursive: true });

    // Restore the most recent snapshot that still opens.
    const backups = path.join(root, '.data', 'backups');
    const candidates = existsSync(backups)
      ? (await readdir(backups)).filter((n) => n.startsWith('pglite-')).sort().reverse()
      : [];
    for (const name of candidates) {
      const source = path.join(backups, name);
      if (!probeDataDir(source)) continue;
      await cp(source, dataDir, { recursive: true });
      console.warn(`[db] restored the snapshot ${name}`);
      break;
    }
    if (!existsSync(path.join(dataDir, 'base'))) {
      console.warn('[db] no usable snapshot — starting a fresh database (templates are reseeded).');
    }
  }
}

async function main(): Promise<void> {
  const dataDir = path.join(root, '.data', 'pglite');
  const artifactsDir = path.join(root, 'apps', 'play-worker', 'artifacts');
  const port = Number.parseInt(process.env.DB_PORT ?? '5432', 10);

  await mkdir(dataDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  // Two PGlite instances over one directory is exactly how it gets corrupted.
  if (await isListening(port)) {
    console.log(`[db] a database is already listening on :${port} — reusing it.`);
    return;
  }

  // Repair first, then snapshot: a damaged directory must never become the
  // newest "good" copy.
  await prepareDatabase(dataDir);
  await snapshot(dataDir);
  const pg = await PGlite.create({ dataDir, extensions: { vector } });
  const db = drizzle(pg, { schema });

  // Migrations are idempotent (drizzle tracks applied hashes).
  await migrate(db, { migrationsFolder: path.join(root, 'packages', 'db', 'migrations') });

  const eventsSql = await readFile(path.join(root, 'packages', 'db', 'events.sql'), 'utf8');
  const statsSql = await readFile(path.join(root, 'packages', 'db', 'stats.sql'), 'utf8');
  await pg.exec(eventsSql);
  await pg.exec(statsSql);

  const result = await seed(db as never, { artifactsDir });
  console.log(`[db] seeded: systemUser=${result.systemUserId} newTemplateGames=${result.templateGames}`);

  // Any game produced by `pnpm gen:seed` is published here, inside the process
  // that owns the database — a separate script cannot connect while this server
  // holds the single allowed socket.
  try {
    const pending = await publishPendingSeeds(db, {
      seedsDir: path.join(root, '.artifacts', 'seeds'),
      artifactsDir,
      log: console.log,
    });
    if (pending.published) console.log(`[db] generated seeds published: ${pending.published}`);
  } catch (err) {
    // Best effort: a bad seed file must never stop the dev stack from booting.
    console.error('[db] seed publish failed:', err instanceof Error ? err.message : err);
  }

  // EXACTLY ONE connection. PGlite runs every statement on a single engine and
  // keeps one unnamed prepared statement per session; with two sockets the
  // Parse/Bind frames interleave and the server answers with
  //   'bind message supplies 11 parameters, but prepared statement requires 10'
  // or 'unnamed prepared statement does not exist'. Both were random 500s on
  // the feed under concurrency. Serialising at the socket is the only correct
  // option without a real Postgres.
  const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1', maxConnections: 1 });
  await server.start();
  console.log(`[db] postgres wire protocol on postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
  console.log(`[db] artifacts served from ${artifactsDir}`);

  const shutdown = async () => {
    try {
      await server.stop();
    } catch {
      /* ignore */
    }
    await pg.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[db] failed to start:', err);
  process.exit(1);
});
