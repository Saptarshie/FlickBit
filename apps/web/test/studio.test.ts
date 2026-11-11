import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import * as schema from '@playloop/db';
import { setTestDb } from '../src/lib/db';

// Mutable mock so individual tests can simulate an anonymous caller.
const authState: { user: { id: string } | null } = { user: { id: '11111111-1111-4111-8111-111111111111' } };
vi.mock('../auth', () => ({
  auth: async () => (authState.user ? { user: authState.user } : null),
}));

describe('POST /api/studio/generate', () => {
  let client: PGlite;
  let db: any;

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema });
    const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
    await migrate(db, { migrationsFolder });
    setTestDb(db);

    await db.insert(schema.users).values({
      id: '11111111-1111-4111-8111-111111111111',
      handle: 'testcreator',
      displayName: 'Test Creator',
      email: 'creator@test.local',
      role: 'user',
    });
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
  });

  it('rejects missing or empty prompt with 400', async () => {
    const { POST } = await import('../app/api/studio/generate/route');
    const req = new NextRequest('http://localhost:3000/api/studio/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: '   ' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('validation_error');
  });

  it('refuses to generate for an anonymous caller', async () => {
    const { POST } = await import('../app/api/studio/generate/route');
    const previous = authState.user;
    authState.user = null;
    try {
      const req = new NextRequest('http://localhost:3000/api/studio/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'anonymous game' }),
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    } finally {
      authState.user = previous;
    }
  });

  it('rejects prompts over the length cap', async () => {
    const { POST } = await import('../app/api/studio/generate/route');
    const req = new NextRequest('http://localhost:3000/api/studio/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'a'.repeat(700) }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain('600');
  });

  it('streams progress and completes game creation over SSE', { timeout: 120_000 }, async () => {
    const { POST } = await import('../app/api/studio/generate/route');
    const req = new NextRequest('http://localhost:3000/api/studio/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'Neon arcade flappy bird',
        templateId: 'flappy',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let streamedText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamedText += decoder.decode(value);
    }

    expect(streamedText).toContain('event: progress');
    expect(streamedText).toContain('event: complete');
    expect(streamedText).toContain('artifactUrl');
    expect(streamedText).toContain('versionNo');

    // Verify game row created in database
    const games = await db.select().from(schema.games);
    expect(games.length).toBeGreaterThanOrEqual(1);
    expect(games[0].status).toBe('published');
    expect(games[0].publishedVersionId).not.toBeNull();
  });

  it('thread: 401 when signed out, 404 for someone else, full session for the creator', async () => {
    const mod = await import('../app/api/studio/thread/route');

    const previous = authState.user;
    authState.user = null;
    const unauth = await mod.GET(new NextRequest('http://localhost:3000/api/studio/thread?gameId=00000000-0000-4000-8000-000000000000'), undefined as never);
    authState.user = previous;
    expect(unauth.status).toBe(401);

    const [own] = await db.select({ id: schema.games.id }).from(schema.games).limit(1);
    expect(own).toBeTruthy();

    // A game created by another account must not leak through the thread API.
    const [stranger] = await db
      .insert(schema.users)
      .values({ handle: 'othercreator', displayName: 'Other', email: 'other@test.local', role: 'user' })
      .returning({ id: schema.users.id });
    const [strangerGame] = await db
      .insert(schema.games)
      .values({ creatorId: stranger!.id, title: 'Not yours', status: 'published', moderation: 'approved' })
      .returning({ id: schema.games.id });
    const forbidden = await mod.GET(
      new NextRequest(`http://localhost:3000/api/studio/thread?gameId=${strangerGame!.id}`),
      undefined as never,
    );
    expect(forbidden.status).toBe(404);

    const ok = await mod.GET(new NextRequest(`http://localhost:3000/api/studio/thread?gameId=${own!.id}`), undefined as never);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.data.game.id).toBe(own!.id);
    expect(Array.isArray(body.data.messages)).toBe(true);
    expect(body.data.versions.length).toBeGreaterThanOrEqual(1);
    expect(body.data.versions[0].artifactUrl).toContain('/v/');
  });
});
