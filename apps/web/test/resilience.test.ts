import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as schema from '@playloop/db';
import { setTestDb } from '../src/lib/db';
import { humanizeDbError } from '../src/lib/db-errors';

const authState: { user: { id: string } | null } = { user: { id: '11111111-1111-4111-8111-111111111111' } };
vi.mock('../auth', () => ({
  auth: async () => (authState.user ? { user: authState.user } : null),
}));

// Keep the tests out of the real artifact store.
const ARTIFACTS = '.artifacts/test-artifacts';
process.env.ARTIFACTS_DIR = ARTIFACTS;

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('resilience: stale sessions, failed publishes, error text', () => {
  let client: PGlite;
  let db: any;

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema });
    const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
    await migrate(db, { migrationsFolder });
    setTestDb(db);

    await db.insert(schema.users).values([
      { id: OWNER, handle: 'owner', displayName: 'Owner', email: 'owner@test.local', role: 'user' },
      { id: OTHER, handle: 'other', displayName: 'Other', email: 'other@test.local', role: 'user' },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
    await rm(path.resolve(process.cwd(), '../..', ARTIFACTS), { recursive: true, force: true });
    await rm(path.resolve(process.cwd(), '../..', '.artifacts/pending'), { recursive: true, force: true });
  });

  it('rejects a session whose account is gone instead of failing on a foreign key', async () => {
    const { POST } = await import('../app/api/studio/generate/route');
    const previous = authState.user;
    // A cookie from a database that no longer exists.
    authState.user = { id: '99999999-9999-4999-8999-999999999999' };
    try {
      const req = new NextRequest('http://localhost:3000/api/studio/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'a tiny platformer' }),
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('session_stale');
      expect(json.error.message).toMatch(/sign in again/i);
    } finally {
      authState.user = previous;
    }
  });

  it('publishing: refuses anonymous, unknown and foreign builds', async () => {
    const { POST } = await import('../app/api/studio/publish/route');
    const previous = authState.user;
    const sha = 'a'.repeat(64);

    authState.user = null;
    const anon = await POST(
      new NextRequest('http://localhost:3000/api/studio/publish', { method: 'POST', body: JSON.stringify({ sha }) }),
    );
    expect(anon.status).toBe(401);

    authState.user = previous;
    const unknown = await POST(
      new NextRequest('http://localhost:3000/api/studio/publish', { method: 'POST', body: JSON.stringify({ sha }) }),
    );
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe('not_found');

    const { savePendingBuild } = await import('../src/lib/pending-builds');
    await savePendingBuild(
      { sha256: sha, bytes: 10, metadata: { title: 'T', description: 'D', tags: [] } },
      { creatorId: OTHER },
    );
    const foreign = await POST(
      new NextRequest('http://localhost:3000/api/studio/publish', { method: 'POST', body: JSON.stringify({ sha }) }),
    );
    expect(foreign.status).toBe(403);
  });

  it('publishes a finished build on retry and clears the marker', async () => {
    const sha = 'b'.repeat(64);
    const dir = path.resolve(process.cwd(), '../..', ARTIFACTS);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${sha}.html`), '<!doctype html><canvas></canvas>', 'utf8');

    const { savePendingBuild, readPendingBuild } = await import('../src/lib/pending-builds');
    await savePendingBuild(
      { sha256: sha, bytes: 30, metadata: { title: 'Retry Me', description: 'A build that failed to save', tags: ['arcade'] } },
      { creatorId: OWNER, gameId: null, forkedFromId: null },
    );

    const { POST } = await import('../app/api/studio/publish/route');
    const res = await POST(
      new NextRequest('http://localhost:3000/api/studio/publish', { method: 'POST', body: JSON.stringify({ sha }) }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.versionNo).toBe(1);
    expect(data.artifactUrl).toContain(`/v/${sha}.html`);

    const games = await db.select().from(schema.games);
    expect(games.some((g: { id: string; title: string }) => g.id === data.gameId && g.title === 'Retry Me')).toBe(true);

    // The marker is gone: a second retry cannot double-publish.
    expect(await readPendingBuild(sha)).toBeNull();
  });

  it('publishArtifact is idempotent for the same artifact', async () => {
    const { publishArtifact } = await import('../src/lib/publish');
    const sha = 'c'.repeat(64);
    const first = await publishArtifact(db, {
      creatorId: OWNER,
      sha256: sha,
      bytes: 42,
      metadata: { title: 'Idem', description: 'once', tags: [] },
    });
    const again = await publishArtifact(db, {
      creatorId: OWNER,
      sha256: sha,
      bytes: 42,
      metadata: { title: 'Idem', description: 'once', tags: [] },
      gameId: first.gameId,
    });
    expect(again.gameId).toBe(first.gameId);
    expect(again.reused).toBe(true);
  });

  it('recognises a dead database through the wrapped cause chain', () => {
    // Drizzle -> postgres-js -> socket, exactly as it arrives at the route.
    const socket = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const driver = Object.assign(new Error('Failed query: select 1'), { cause: socket });
    const outer = Object.assign(new Error('Failed query: select 1'), { cause: driver });
    const human = humanizeDbError(outer);
    expect(human.code).toBe('db_unavailable');
    expect(human.message).toMatch(/pnpm start/);
  });

  it('never hands a raw query to the user', () => {
    const fk = Object.assign(new Error('Failed query: insert into "games" (creator_id) values ($1)\nparams: abc'), {
      code: '23503',
    });
    const human = humanizeDbError(fk);
    expect(human.code).toBe('foreign_key');
    expect(human.message).not.toMatch(/insert into|params:/i);
    expect(human.retryable).toBe(true);
    // The technical detail is preserved for the server log.
    expect(human.detail).toMatch(/insert into/);
  });
});
