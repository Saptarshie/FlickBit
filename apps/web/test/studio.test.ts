import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import * as schema from '@playloop/db';
import { setTestDb } from '../src/lib/db';

vi.mock('../auth', () => ({
  auth: async () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }),
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

  it('streams progress and completes game creation over SSE', async () => {
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

    // Verify game row created in database
    const games = await db.select().from(schema.games);
    expect(games.length).toBeGreaterThanOrEqual(1);
    expect(games[0].status).toBe('published');
    expect(games[0].publishedVersionId).not.toBeNull();
  });
});
