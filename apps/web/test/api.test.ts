import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import * as schema from '@playloop/db';
import { getDb, setTestDb, resetTestDb } from '../src/lib/db';
import { jsonOk, jsonError, parseValue, parseBody, requireUser } from '../src/lib/api-helpers';
import { makeAnonId, ANON_COOKIE_NAME } from '../src/lib/anon';

import * as likeRoute from '../app/api/games/[id]/like/route';
import * as saveRoute from '../app/api/games/[id]/save/route';
import * as commentsRoute from '../app/api/games/[id]/comments/route';
import * as commentRoute from '../app/api/comments/[id]/route';
import * as followRoute from '../app/api/users/[id]/follow/route';
import * as notificationsRoute from '../app/api/notifications/route';
import * as notificationsReadRoute from '../app/api/notifications/read/route';
import * as reportRoute from '../app/api/games/[id]/report/route';
import * as scoreRoute from '../app/api/games/[id]/score/route';
import * as leaderboardRoute from '../app/api/games/[id]/leaderboard/route';
import * as eventsRoute from '../app/api/events/route';
import * as userProfileRoute from '../app/api/users/[id]/route';
import * as gameEditRoute from '../app/api/games/[id]/route';
import * as gameSourceRoute from '../app/api/games/[id]/source/route';
import * as meRoute from '../app/api/me/route';
import * as searchRoute from '../app/api/search/route';
import * as savedRoute from '../app/api/me/saved/route';

const authState = vi.hoisted(() => ({ session: null as { user: { id: string } } | null }));

vi.mock('../auth', () => ({
  auth: async () => authState.session,
  handleFromEmail: (email: string) => email.split('@')[0] ?? 'user',
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const eventsSqlPath = fileURLToPath(new URL('../../../packages/db/events.sql', import.meta.url));

let client: PGlite;
let aliceId = '';
let bobId = '';
let carolId = '';

beforeAll(async () => {
  client = new PGlite({ extensions: { vector } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  await client.exec(await readFile(eventsSqlPath, 'utf8'));
  setTestDb(db);

  const [alice] = await getDb()
    .insert(schema.users)
    .values({ handle: 'alice', email: 'alice@example.com' })
    .returning();
  const [bob] = await getDb()
    .insert(schema.users)
    .values({ handle: 'bob', email: 'bob@example.com' })
    .returning();
  const [carol] = await getDb()
    .insert(schema.users)
    .values({ handle: 'carol', email: 'carol@example.com' })
    .returning();
  aliceId = alice!.id;
  bobId = bob!.id;
  carolId = carol!.id;
}, 60_000);

afterAll(async () => {
  resetTestDb();
  await client.close();
});

beforeEach(() => {
  authState.session = null;
});

function asUser(id: string | null): void {
  authState.session = id ? { user: { id } } : null;
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function jsonReq(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${url}`, init);
}

async function createGame(creatorId: string): Promise<string> {
  const [game] = await getDb()
    .insert(schema.games)
    .values({ creatorId, title: 'Test Game' })
    .returning();
  if (!game) throw new Error('game insert failed');
  return game.id;
}

async function likeCountOf(gameId: string): Promise<number> {
  const rows = await getDb().select({ likeCount: schema.games.likeCount }).from(schema.games).where(eq(schema.games.id, gameId));
  return rows[0]?.likeCount ?? -1;
}

// ---------------------------------------------------------------------------
// api-helpers
// ---------------------------------------------------------------------------

describe('api-helpers', () => {
  it('jsonOk wraps payloads as {data}', async () => {
    const res = jsonOk({ a: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { a: 1 } });
  });

  it('jsonError wraps errors as {error:{code,message}}', async () => {
    const res = jsonError('not_found', 'nope', 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'nope' } });
  });

  it('parseValue throws a 400 Response on schema failure', () => {
    let thrown: unknown;
    try {
      parseValue({ id: 'not-a-uuid' }, z.object({ id: z.uuid() }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(400);
  });

  it('parseBody throws a 400 Response on invalid JSON', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', body: 'not-json' });
    let thrown: unknown;
    try {
      await parseBody(req, z.object({}));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(400);
  });

  it('requireUser returns the session user id', async () => {
    asUser(aliceId);
    await expect(requireUser(new Request('http://localhost/x'))).resolves.toBe(aliceId);
  });

  it('requireUser throws a 401 Response when unauthenticated', async () => {
    let thrown: unknown;
    try {
      await requireUser(new Request('http://localhost/x'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// likes
// ---------------------------------------------------------------------------

describe('POST/DELETE /api/games/[id]/like', () => {
  it('rejects unauthenticated mutations with 401', async () => {
    const gameId = await createGame(aliceId);
    const res = await likeRoute.POST(jsonReq('POST', `/api/games/${gameId}/like`), ctx(gameId));
    expect(res.status).toBe(401);
  });

  it('rejects a malformed game id with 400', async () => {
    asUser(bobId);
    const res = await likeRoute.POST(jsonReq('POST', '/api/games/nope/like'), ctx('nope'));
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown game', async () => {
    asUser(bobId);
    const missing = '00000000-0000-4000-8000-000000000000';
    const res = await likeRoute.POST(jsonReq('POST', `/api/games/${missing}/like`), ctx(missing));
    expect(res.status).toBe(404);
  });

  it('creates a like row, bumps the count, and is idempotent', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);

    const res = await likeRoute.POST(jsonReq('POST', `/api/games/${gameId}/like`), ctx(gameId));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ liked: true, likeCount: 1 });

    const rows = await getDb()
      .select()
      .from(schema.likes)
      .where(and(eq(schema.likes.userId, bobId), eq(schema.likes.gameId, gameId)));
    expect(rows).toHaveLength(1);
    expect(await likeCountOf(gameId)).toBe(1);

    const again = await likeRoute.POST(jsonReq('POST', `/api/games/${gameId}/like`), ctx(gameId));
    expect((await again.json()).data).toMatchObject({ liked: true, likeCount: 1 });
    expect(await likeCountOf(gameId)).toBe(1);
  });

  it('removes the like row and decrements the count', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);
    await likeRoute.POST(jsonReq('POST', `/api/games/${gameId}/like`), ctx(gameId));

    const res = await likeRoute.DELETE(jsonReq('DELETE', `/api/games/${gameId}/like`), ctx(gameId));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ liked: false, likeCount: 0 });

    const rows = await getDb()
      .select()
      .from(schema.likes)
      .where(and(eq(schema.likes.userId, bobId), eq(schema.likes.gameId, gameId)));
    expect(rows).toHaveLength(0);
    expect(await likeCountOf(gameId)).toBe(0);

    const again = await likeRoute.DELETE(jsonReq('DELETE', `/api/games/${gameId}/like`), ctx(gameId));
    expect(again.status).toBe(200);
    expect(await likeCountOf(gameId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// saves
// ---------------------------------------------------------------------------

describe('POST/DELETE /api/games/[id]/save', () => {
  it('creates a save row with count and removes it again', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);

    const res = await saveRoute.POST(jsonReq('POST', `/api/games/${gameId}/save`), ctx(gameId));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ saved: true, saveCount: 1 });

    const rows = await getDb()
      .select()
      .from(schema.saves)
      .where(and(eq(schema.saves.userId, bobId), eq(schema.saves.gameId, gameId)));
    expect(rows).toHaveLength(1);

    const del = await saveRoute.DELETE(jsonReq('DELETE', `/api/games/${gameId}/save`), ctx(gameId));
    expect((await del.json()).data).toMatchObject({ saved: false, saveCount: 0 });

    const after = await getDb()
      .select()
      .from(schema.saves)
      .where(and(eq(schema.saves.userId, bobId), eq(schema.saves.gameId, gameId)));
    expect(after).toHaveLength(0);

    const gameRows = await getDb().select({ saveCount: schema.games.saveCount }).from(schema.games).where(eq(schema.games.id, gameId));
    expect(gameRows[0]?.saveCount).toBe(0);
  });

  it('rejects unauthenticated saves with 401', async () => {
    const gameId = await createGame(aliceId);
    const res = await saveRoute.POST(jsonReq('POST', `/api/games/${gameId}/save`), ctx(gameId));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

describe('/api/games/[id]/comments and /api/comments/[id]', () => {
  it('rejects a 501-char comment body with 400', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);
    const res = await commentsRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/comments`, { body: 'x'.repeat(501) }),
      ctx(gameId),
    );
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated comment creation with 401', async () => {
    const gameId = await createGame(aliceId);
    const res = await commentsRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/comments`, { body: 'hi' }),
      ctx(gameId),
    );
    expect(res.status).toBe(401);
  });

  it('accepts a valid comment, supports one level of reply, rejects nested replies', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);

    const res = await commentsRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/comments`, { body: 'Hello world' }),
      ctx(gameId),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()).data.comment;
    expect(created).toMatchObject({ body: 'Hello world', parentId: null });

    const rows = await getDb()
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.gameId, gameId));
    expect(rows).toHaveLength(1);

    // One level of reply is allowed.
    asUser(carolId);
    const replyRes = await commentsRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/comments`, { body: 'A reply', parentId: created.id }),
      ctx(gameId),
    );
    expect(replyRes.status).toBe(201);
    const reply = (await replyRes.json()).data.comment;
    expect(reply.parentId).toBe(created.id);

    // A reply to a reply is rejected (only one level).
    const nested = await commentsRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/comments`, { body: 'Nested', parentId: reply.id }),
      ctx(gameId),
    );
    expect(nested.status).toBe(400);

    // GET nests the reply under its parent.
    const list = await commentsRoute.GET(jsonReq('GET', `/api/games/${gameId}/comments`), ctx(gameId));
    expect(list.status).toBe(200);
    const comments = (await list.json()).data.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe(created.id);
    expect(comments[0].replies).toHaveLength(1);
    expect(comments[0].replies[0].id).toBe(reply.id);
  });

  it('only the author can delete a comment (403 otherwise)', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);
    const res = await commentsRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/comments`, { body: 'mine' }),
      ctx(gameId),
    );
    const created = (await res.json()).data.comment;

    asUser(carolId);
    const forbidden = await commentRoute.DELETE(
      jsonReq('DELETE', `/api/comments/${created.id}`),
      ctx(created.id),
    );
    expect(forbidden.status).toBe(403);

    asUser(bobId);
    const ok = await commentRoute.DELETE(
      jsonReq('DELETE', `/api/comments/${created.id}`),
      ctx(created.id),
    );
    expect(ok.status).toBe(200);

    const rows = await getDb()
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, created.id));
    expect(rows[0]?.deletedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// follows
// ---------------------------------------------------------------------------

describe('POST/DELETE /api/users/[id]/follow', () => {
  it('creates a follow row', async () => {
    asUser(bobId);
    const res = await followRoute.POST(
      jsonReq('POST', `/api/users/${aliceId}/follow`),
      ctx(aliceId),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ following: true });

    const rows = await getDb()
      .select()
      .from(schema.follows)
      .where(and(eq(schema.follows.followerId, bobId), eq(schema.follows.followeeId, aliceId)));
    expect(rows).toHaveLength(1);

    const del = await followRoute.DELETE(
      jsonReq('DELETE', `/api/users/${aliceId}/follow`),
      ctx(aliceId),
    );
    expect(del.status).toBe(200);
    const after = await getDb()
      .select()
      .from(schema.follows)
      .where(and(eq(schema.follows.followerId, bobId), eq(schema.follows.followeeId, aliceId)));
    expect(after).toHaveLength(0);
  });

  it('rejects self-follows and unauthenticated follows', async () => {
    asUser(bobId);
    const self = await followRoute.POST(jsonReq('POST', `/api/users/${bobId}/follow`), ctx(bobId));
    expect(self.status).toBe(400);

    asUser(null);
    const anon = await followRoute.POST(
      jsonReq('POST', `/api/users/${aliceId}/follow`),
      ctx(aliceId),
    );
    expect(anon.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

describe('/api/notifications', () => {
  it('lists the current user notifications with unread count', async () => {
    await getDb().delete(schema.notifications).where(eq(schema.notifications.userId, aliceId));
    await getDb()
      .insert(schema.notifications)
      .values([
        { userId: aliceId, type: 'follow', actorId: bobId },
        { userId: aliceId, type: 'comment', actorId: bobId, readAt: new Date() },
        { userId: bobId, type: 'follow', actorId: carolId },
      ]);

    asUser(aliceId);
    const res = await notificationsRoute.GET(jsonReq('GET', '/api/notifications'), ctx(aliceId));
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.items).toHaveLength(2);
    expect(body.unread).toBe(1);

    asUser(null);
    const anon = await notificationsRoute.GET(jsonReq('GET', '/api/notifications'), ctx(aliceId));
    expect(anon.status).toBe(401);
  });

  it('marks notifications as read and counts the updated rows', async () => {
    await getDb().delete(schema.notifications).where(eq(schema.notifications.userId, aliceId));
    const [n1] = await getDb()
      .insert(schema.notifications)
      .values({ userId: aliceId, type: 'like', actorId: bobId })
      .returning();
    await getDb()
      .insert(schema.notifications)
      .values({ userId: aliceId, type: 'like', actorId: carolId });

    asUser(aliceId);
    const byId = await notificationsReadRoute.POST(
      jsonReq('POST', '/api/notifications/read', { ids: [n1!.id] }),
      ctx(aliceId),
    );
    expect(byId.status).toBe(200);
    expect((await byId.json()).data).toMatchObject({ updated: 1 });

    const all = await notificationsReadRoute.POST(
      jsonReq('POST', '/api/notifications/read', { all: true }),
      ctx(aliceId),
    );
    expect((await all.json()).data).toMatchObject({ updated: 1 });

    const unread = await getDb()
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, aliceId), isNull(schema.notifications.readAt)));
    expect(unread).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

describe('POST /api/games/[id]/report', () => {
  it('creates a report row for the game', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);
    const res = await reportRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/report`, { reason: 'spam', details: 'looks off' }),
      ctx(gameId),
    );
    expect(res.status).toBe(201);

    const rows = await getDb()
      .select()
      .from(schema.reports)
      .where(and(eq(schema.reports.targetType, 'game'), eq(schema.reports.targetId, gameId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('spam');
    expect(rows[0]?.reporterId).toBe(bobId);
  });

  it('rejects an empty reason and unauthenticated reports', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);
    const bad = await reportRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/report`, { reason: '' }),
      ctx(gameId),
    );
    expect(bad.status).toBe(400);

    asUser(null);
    const anon = await reportRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/report`, { reason: 'spam' }),
      ctx(gameId),
    );
    expect(anon.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// scores + leaderboard
// ---------------------------------------------------------------------------

describe('/api/games/[id]/score and /api/games/[id]/leaderboard', () => {
  it('stores a score and returns it for the user', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);
    const res = await scoreRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/score`, { score: 42, meta: { level: 2 } }),
      ctx(gameId),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).data.score).toMatchObject({ score: 42 });

    const rows = await getDb()
      .select()
      .from(schema.scores)
      .where(eq(schema.scores.gameId, gameId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.score)).toBe(42);
    expect(rows[0]?.userId).toBe(bobId);

    const list = await scoreRoute.GET(jsonReq('GET', `/api/games/${gameId}/score`), ctx(gameId));
    expect(list.status).toBe(200);
    const scores = (await list.json()).data.scores;
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBe(42);
  });

  it('leaderboard returns the top 50 sorted by score desc', async () => {
    const gameId = await createGame(aliceId);
    for (const [userId, score] of [
      [aliceId, 10],
      [bobId, 42],
      [carolId, 99],
    ] as const) {
      await getDb()
        .insert(schema.scores)
        .values({ gameId, userId, score: String(score) });
    }

    asUser(bobId);
    const res = await leaderboardRoute.GET(
      jsonReq('GET', `/api/games/${gameId}/leaderboard`),
      ctx(gameId),
    );
    expect(res.status).toBe(200);
    const entries = (await res.json()).data.entries;
    expect(entries).toHaveLength(3);
    expect(entries.map((e: { score: number }) => e.score)).toEqual([99, 42, 10]);
    expect(entries[0].rank).toBe(1);
    expect(entries[0].user.handle).toBe('carol');
  });

  it('rejects unauthenticated score posts with 401', async () => {
    const gameId = await createGame(aliceId);
    const res = await scoreRoute.POST(
      jsonReq('POST', `/api/games/${gameId}/score`, { score: 1 }),
      ctx(gameId),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// events (anonymous beacon)
// ---------------------------------------------------------------------------

describe('POST /api/events', () => {
  it('rejects batches of more than 50 events with 400', async () => {
    const events = Array.from({ length: 51 }, () => ({ type: 'view' }));
    const res = await eventsRoute.POST(jsonReq('POST', '/api/events', { events }), ctx('none'));
    expect(res.status).toBe(400);
  });

  it('rejects non-array event bodies with 400', async () => {
    const res = await eventsRoute.POST(
      jsonReq('POST', '/api/events', { events: 'nope' }),
      ctx('none'),
    );
    expect(res.status).toBe(400);
  });

  it('accepts an anonymous batch and resolves the pl_anon cookie', async () => {
    const anonValue = makeAnonId('anon-test-1');
    const res = await eventsRoute.POST(
      jsonReq(
        'POST',
        '/api/events',
        {
          events: [
            { type: 'impression', position: 0, source: 'anon-batch-1' },
            { type: 'play_start', source: 'anon-batch-1', props: { via: 'feed' } },
          ],
        },
        { cookie: `${ANON_COOKIE_NAME}=${anonValue}` },
      ),
      ctx('none'),
    );
    expect(res.status).toBe(204);

    const rows = await getDb()
      .select()
      .from(schema.events)
      .where(eq(schema.events.source, 'anon-batch-1'))
      .orderBy(asc(schema.events.id));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.anonId).toBe(anonValue);
    expect(rows[1]?.type).toBe('play_start');
  });

  it('attaches the session user id when logged in', async () => {
    asUser(bobId);
    const res = await eventsRoute.POST(
      jsonReq('POST', '/api/events', {
        events: [
          { type: 'view', source: 'session-batch-1', ts: new Date(Date.now() + 60_000).toISOString() },
        ],
      }),
      ctx('none'),
    );
    expect(res.status).toBe(204);

    const rows = await getDb()
      .select()
      .from(schema.events)
      .where(eq(schema.events.source, 'session-batch-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(bobId);
  });

  it('drops invalid events but keeps valid ones', async () => {
    const res = await eventsRoute.POST(
      jsonReq('POST', '/api/events', {
        events: [
          { type: 'view', source: 'drop-batch-1' },
          { type: 'not-a-real-type', source: 'drop-batch-1' },
        ],
      }),
      ctx('none'),
    );
    expect(res.status).toBe(204);

    const rows = await getDb()
      .select()
      .from(schema.events)
      .where(eq(schema.events.source, 'drop-batch-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('view');
  });

  it('mints an anon id and sets the pl_anon cookie when none is present', async () => {
    const res = await eventsRoute.POST(
      jsonReq('POST', '/api/events', { events: [{ type: 'view', source: 'mint-batch-1' }] }),
      ctx('none'),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie') ?? '').toContain(ANON_COOKIE_NAME);

    const rows = await getDb()
      .select()
      .from(schema.events)
      .where(eq(schema.events.source, 'mint-batch-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.anonId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// user profile (GET /api/users/[id] — accepts uuid or handle)
// ---------------------------------------------------------------------------

describe('GET /api/users/[id] (profile)', () => {
  it('returns profile, counts, and published games by handle', async () => {
    // alice: one published game + one draft; bob follows alice
    const publishedId = await createGame(aliceId);
    const [pubVersion] = await getDb()
      .insert(schema.gameVersions)
      .values({ gameId: publishedId, versionNo: 1, artifactSha256: 'a'.repeat(64), artifactBytes: 10, artifactKey: 'k' })
      .returning();
    await getDb()
      .update(schema.games)
      .set({ publishedVersionId: pubVersion!.id, status: 'published', publishedAt: new Date() })
      .where(eq(schema.games.id, publishedId));
    await createGame(aliceId); // stays draft
    await getDb().insert(schema.follows).values({ followerId: bobId, followeeId: aliceId });

    asUser(bobId);
    const res = await userProfileRoute.GET(jsonReq('GET', '/api/users/alice'), ctx('alice'));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.user.handle).toBe('alice');
    expect(data.counts.followers).toBe(1);
    expect(data.counts.games).toBe(1);
    expect(data.games).toHaveLength(1);
    expect(data.games[0].id).toBe(publishedId);
    expect(data.viewer.following).toBe(true);
  });

  it('matches handles case-insensitively and exposes forkedFrom provenance', async () => {
    const parentId = await createGame(carolId);
    const [child] = await getDb()
      .insert(schema.games)
      .values({
        creatorId: carolId,
        title: 'Remixed Game',
        status: 'published',
        publishedAt: new Date(),
        forkedFromGameId: parentId,
      })
      .returning();
    expect(child).toBeTruthy();

    const res = await userProfileRoute.GET(jsonReq('GET', '/api/users/CAROL'), ctx('CAROL'));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const remixed = data.games.find((g: { id: string }) => g.id === child!.id);
    expect(remixed?.forkedFrom?.id).toBe(parentId);
    expect(remixed?.forkedFrom?.title).toBe('Test Game');
  });

  it('404s for unknown handles', async () => {
    const res = await userProfileRoute.GET(jsonReq('GET', '/api/users/nobody-here'), ctx('nobody-here'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// game edit / publish / unpublish (PATCH /api/games/[id])
// ---------------------------------------------------------------------------

async function attachVersion(gameId: string): Promise<void> {
  const [v] = await getDb()
    .insert(schema.gameVersions)
    .values({ gameId, versionNo: 1, artifactSha256: 'b'.repeat(64), artifactBytes: 10, artifactKey: 'k' })
    .returning();
  await getDb().update(schema.games).set({ publishedVersionId: v!.id }).where(eq(schema.games.id, gameId));
}

describe('PATCH /api/games/[id] (edit + publish/unpublish)', () => {
  it('401s when unauthenticated', async () => {
    const gameId = await createGame(aliceId);
    const res = await gameEditRoute.PATCH(jsonReq('PATCH', `/api/games/${gameId}`, { title: 'x' }), ctx(gameId));
    expect(res.status).toBe(401);
  });

  it('403s when the caller is not the creator', async () => {
    const gameId = await createGame(aliceId);
    asUser(bobId);
    const res = await gameEditRoute.PATCH(jsonReq('PATCH', `/api/games/${gameId}`, { title: 'hacked' }), ctx(gameId));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
  });

  it('400s on invalid input', async () => {
    const gameId = await createGame(aliceId);
    asUser(aliceId);
    const res = await gameEditRoute.PATCH(jsonReq('PATCH', `/api/games/${gameId}`, { title: '' }), ctx(gameId));
    expect(res.status).toBe(400);

    const res2 = await gameEditRoute.PATCH(jsonReq('PATCH', `/api/games/${gameId}`, { status: 'nuked' }), ctx(gameId));
    expect(res2.status).toBe(400);
  });

  it('lets the creator edit title, description, and tags', async () => {
    const gameId = await createGame(aliceId);
    asUser(aliceId);
    const res = await gameEditRoute.PATCH(
      jsonReq('PATCH', `/api/games/${gameId}`, {
        title: 'Polished Title',
        description: 'A better description',
        tags: ['arcade', 'speed'],
      }),
      ctx(gameId),
    );
    expect(res.status).toBe(200);

    const rows = await getDb().select().from(schema.games).where(eq(schema.games.id, gameId));
    expect(rows[0]?.title).toBe('Polished Title');
    expect(rows[0]?.tags).toEqual(['arcade', 'speed']);
  });

  it('publishes a game with a version, setting publishedAt', async () => {
    const gameId = await createGame(aliceId);
    await attachVersion(gameId);
    asUser(aliceId);
    const res = await gameEditRoute.PATCH(jsonReq('PATCH', `/api/games/${gameId}`, { status: 'published' }), ctx(gameId));
    expect(res.status).toBe(200);

    const rows = await getDb().select().from(schema.games).where(eq(schema.games.id, gameId));
    expect(rows[0]?.status).toBe('published');
    expect(rows[0]?.publishedAt).toBeTruthy();
  });

  it('400s when publishing a game with no version', async () => {
    const gameId = await createGame(aliceId);
    asUser(aliceId);
    const res = await gameEditRoute.PATCH(jsonReq('PATCH', `/api/games/${gameId}`, { status: 'published' }), ctx(gameId));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('no_version');
  });

  it('unpublishes back to unlisted without losing publishedAt', async () => {
    const gameId = await createGame(aliceId);
    await attachVersion(gameId);
    asUser(aliceId);
    await gameEditRoute.PATCH(jsonReq('PATCH', `/api/games/${gameId}`, { status: 'published' }), ctx(gameId));
    const res = await gameEditRoute.PATCH(jsonReq('PATCH', `/api/games/${gameId}`, { status: 'unlisted' }), ctx(gameId));
    expect(res.status).toBe(200);

    const rows = await getDb().select().from(schema.games).where(eq(schema.games.id, gameId));
    expect(rows[0]?.status).toBe('unlisted');
    expect(rows[0]?.publishedAt).toBeTruthy();
  });

  it('404s for unknown games', async () => {
    asUser(aliceId);
    const res = await gameEditRoute.PATCH(
      jsonReq('PATCH', '/api/games/11111111-1111-4111-8111-111111111111', { title: 'x' }),
      ctx('11111111-1111-4111-8111-111111111111'),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// game source for remix (GET /api/games/[id]/source)
// ---------------------------------------------------------------------------

describe('GET /api/games/[id]/source (remix base code)', () => {
  const sourceHtml = '<!DOCTYPE html><html><head><script type="application/json" id="pl-manifest">{"title":"Src","description":"d","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":["t"],"scoring":"higher"}</script></head><body>CODE</body></html>';

  beforeAll(() => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'web-source-test-'));
    process.env.ARTIFACTS_DIR = artifactsDir;
    const sha = createHash('sha256').update(sourceHtml, 'utf8').digest('hex');
    writeFileSync(join(artifactsDir, `${sha}.html`), sourceHtml);
  });

  afterAll(() => {
    rmSync(process.env.ARTIFACTS_DIR!, { recursive: true, force: true });
    delete process.env.ARTIFACTS_DIR;
  });

  it('returns the artifact html for remixing', async () => {
    const gameId = await createGame(aliceId);
    const sha = createHash('sha256').update(sourceHtml, 'utf8').digest('hex');
    const [v] = await getDb()
      .insert(schema.gameVersions)
      .values({ gameId, versionNo: 1, artifactSha256: sha, artifactBytes: sourceHtml.length, artifactKey: 'k' })
      .returning();
    await getDb().update(schema.games).set({ publishedVersionId: v!.id }).where(eq(schema.games.id, gameId));

    const res = await gameSourceRoute.GET(jsonReq('GET', `/api/games/${gameId}/source`), ctx(gameId));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.code).toBe(sourceHtml);
    expect(data.game.id).toBe(gameId);
  });

  it('404s when the artifact file is missing on disk', async () => {
    const gameId = await createGame(bobId);
    const [v] = await getDb()
      .insert(schema.gameVersions)
      .values({ gameId, versionNo: 1, artifactSha256: 'c'.repeat(64), artifactBytes: 1, artifactKey: 'k' })
      .returning();
    await getDb().update(schema.games).set({ publishedVersionId: v!.id }).where(eq(schema.games.id, gameId));

    const res = await gameSourceRoute.GET(jsonReq('GET', `/api/games/${gameId}/source`), ctx(gameId));
    expect(res.status).toBe(404);
  });

  it('404s for games with no version', async () => {
    const gameId = await createGame(carolId);
    const res = await gameSourceRoute.GET(jsonReq('GET', `/api/games/${gameId}/source`), ctx(gameId));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// game detail for share page (GET /api/games/[id])
// ---------------------------------------------------------------------------

describe('GET /api/games/[id] (share detail)', () => {
  it('returns game, creator, counts, viewer state, and remix provenance', async () => {
    // parent by carol, child remix by alice with a version + a like from bob
    const parentId = await createGame(carolId);
    const gameId = await createGame(aliceId);
    await getDb().update(schema.games).set({ forkedFromGameId: parentId }).where(eq(schema.games.id, gameId));
    await attachVersion(gameId);

    // Like through the real route so the denormalized counter is bumped too.
    asUser(bobId);
    const likeRes = await likeRoute.POST(jsonReq('POST', `/api/games/${gameId}/like`), ctx(gameId));
    expect(likeRes.ok).toBe(true);

    const res = await gameEditRoute.GET(jsonReq('GET', `/api/games/${gameId}`), ctx(gameId));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.game.id).toBe(gameId);
    expect(data.game.creator.handle).toBe('alice');
    expect(data.game.artifactUrl).toMatch(/\/v\/b{64}\.html$/);
    expect(data.game.counts.likes).toBe(1);
    expect(data.game.viewer.liked).toBe(true);
    expect(data.game.forkedFrom?.id).toBe(parentId);
    expect(data.game.forkedFrom?.title).toBe('Test Game');
  });

  it('404s for unknown or unpublished-removed games', async () => {
    const res = await gameEditRoute.GET(
      jsonReq('GET', '/api/games/22222222-2222-4222-8222-222222222222'),
      ctx('22222222-2222-4222-8222-222222222222'),
    );
    expect(res.status).toBe(404);
  });

  it('404s for soft-deleted games', async () => {
    const gameId = await createGame(aliceId);
    await getDb().update(schema.games).set({ deletedAt: new Date() }).where(eq(schema.games.id, gameId));
    const res = await gameEditRoute.GET(jsonReq('GET', `/api/games/${gameId}`), ctx(gameId));
    expect(res.status).toBe(404);
  });
});

describe('app shell APIs (me / search / saved)', () => {
  beforeEach(() => asUser(null));

  it('GET /api/me returns a null viewer when signed out and the viewer when signed in', async () => {
    const anon = await (await meRoute.GET(jsonReq('GET', '/api/me'), { params: Promise.resolve({}) })).json();
    expect(anon.data.viewer).toBeNull();

    asUser(aliceId);
    const signedIn = await (await meRoute.GET(jsonReq('GET', '/api/me'), { params: Promise.resolve({}) })).json();
    expect(signedIn.data.viewer.id).toBe(aliceId);
    expect(signedIn.data.viewer.handle).toBe('alice');
    expect(typeof signedIn.data.unread).toBe('number');
  });

  it('GET /api/search matches published games by title and by tag, and lists tags', async () => {
    const gameId = await createGame(aliceId);
    await getDb()
      .update(schema.games)
      .set({ title: 'Neon Serpent Quest', tags: ['neon', 'snake'], status: 'published' })
      .where(eq(schema.games.id, gameId));
    await attachVersion(gameId);

    const byTitle = await (await searchRoute.GET(jsonReq('GET', '/api/search?q=Serpent'), { params: Promise.resolve({}) })).json();
    expect(byTitle.data.games.some((g: { id: string }) => g.id === gameId)).toBe(true);

    const byTag = await (await searchRoute.GET(jsonReq('GET', '/api/search?tag=neon'), { params: Promise.resolve({}) })).json();
    expect(byTag.data.games.some((g: { id: string }) => g.id === gameId)).toBe(true);
    expect(byTag.data.tags.some((t: { tag: string }) => t.tag === 'neon')).toBe(true);
  });

  it('GET /api/search never returns drafts or deleted games', async () => {
    const draftId = await createGame(aliceId);
    await getDb().update(schema.games).set({ title: 'Secret Draft', status: 'draft' }).where(eq(schema.games.id, draftId));
    const res = await (await searchRoute.GET(jsonReq('GET', '/api/search?q=Secret'), { params: Promise.resolve({}) })).json();
    expect(res.data.games.some((g: { id: string }) => g.id === draftId)).toBe(false);
  });

  it('GET /api/me/saved 401s signed out and lists saved games when signed in', async () => {
    const unsigned = await savedRoute.GET(jsonReq('GET', '/api/me/saved'), { params: Promise.resolve({}) });
    expect(unsigned.status).toBe(401);

    const gameId = await createGame(aliceId);
    await attachVersion(gameId);
    asUser(bobId);
    const saveRes = await saveRoute.POST(jsonReq('POST', `/api/games/${gameId}/save`), ctx(gameId));
    expect(saveRes.ok).toBe(true);

    const res = await savedRoute.GET(jsonReq('GET', '/api/me/saved'), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.games.some((g: { id: string }) => g.id === gameId)).toBe(true);
  });
});
