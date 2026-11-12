import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inArray, sql } from 'drizzle-orm';
import { EVENT_TYPES, games, insertEvents, type EventRow } from '@playloop/db';
import { auth } from '../../../auth';
import { getDb } from '../../../src/lib/db';
import {
  ANON_COOKIE_NAME,
  makeAnonId,
  setAnonCookie,
  verifyAnonId,
  type AnonCookieOptions,
} from '../../../src/lib/anon';
import { jsonError, parseBody, wrap } from '../../../src/lib/api-helpers';
import { takeRateLimit } from '../../../src/lib/rate-limit';

const eventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  ts: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'ts must be an ISO date string')
    .nullish(),
  gameId: z.uuid().nullish(),
  versionId: z.uuid().nullish(),
  position: z.number().int().nullish(),
  source: z.string().max(64).nullish(),
  // A beacon is a few hundred bytes; anything larger is abuse, not analytics.
  props: z
    .record(z.string(), z.unknown())
    .nullish()
    .refine((v) => v == null || JSON.stringify(v).length <= 2048, 'props are too large'),
});

const bodySchema = z.object({ events: z.array(z.unknown()).max(50) });

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function serializeCookie(name: string, value: string, options: AnonCookieOptions): string {
  const sameSite = options.sameSite === 'lax' ? 'Lax' : options.sameSite === 'strict' ? 'Strict' : 'None';
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${sameSite}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

/**
 * Anonymous analytics beacon. Reachable without login: identity comes from the
 * auth session when present, else the signed `pl_anon` cookie (minted and set
 * on the response when missing). Invalid events are dropped, invalid batches
 * (non-array or over 50) are rejected with 400. Always answers 204 on success.
 */
export const POST = wrap(async (req) => {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > 256 * 1024) {
    return jsonError('payload_too_large', 'Analytics batches are limited to 256 KB', 413);
  }
  const { events: rawEvents } = await parseBody(req, bodySchema);

  const session = (await auth()) as { user?: { id?: string | null } | null } | null;
  const userId = session?.user?.id ?? null;

  let anonId: string | null = null;
  let mintedAnon = false;
  if (!userId) {
    const raw = getCookie(req, ANON_COOKIE_NAME);
    if (raw && verifyAnonId(raw)) {
      anonId = raw;
    } else {
      anonId = makeAnonId(randomUUID());
      mintedAnon = true;
    }
  }

  const rows: EventRow[] = [];
  for (const raw of rawEvents) {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) continue; // drop invalid events, keep the batch
    const ev = parsed.data;
    rows.push({
      type: ev.type,
      ts: ev.ts ? new Date(ev.ts) : undefined,
      userId,
      anonId,
      gameId: ev.gameId ?? null,
      versionId: ev.versionId ?? null,
      position: ev.position ?? null,
      source: ev.source ?? null,
      props: ev.props ?? null,
    });
  }

  const db = getDb();

  // An unknown gameId would trip the events FK and lose the WHOLE batch (the
  // beacon is fire-and-forget, so the client never learns). Drop just those.
  const referenced = [...new Set(rows.map((r) => r.gameId).filter((id): id is string => Boolean(id)))];
  if (referenced.length > 0) {
    const known = await db.select({ id: games.id }).from(games).where(inArray(games.id, referenced));
    const knownIds = new Set(known.map((g: { id: string }) => g.id));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const id = rows[i]!.gameId;
      if (id && !knownIds.has(id)) rows.splice(i, 1);
    }
  }

  await insertEvents(db, rows);

  // The card counts are denormalised on `games`, so a finished play must bump
  // the counter here — otherwise every game shows 0 plays forever and the
  // ranker has no behavioural signal.
  // One countable play per identity per game per minute: play_count feeds the
  // ranker's only behavioural signal, so an unfiltered beacon could poison it.
  const viewer = userId ?? anonId ?? 'anon';
  const playsByGame = new Map<string, number>();
  for (const row of rows) {
    if (row.type === 'play_15s' && row.gameId) {
      const gate = takeRateLimit('play15', `${viewer}:${row.gameId}`, 1, 60_000);
      if (!gate.allowed) continue;
      playsByGame.set(row.gameId, (playsByGame.get(row.gameId) ?? 0) + 1);
    }
  }
  for (const [gameId, plays] of playsByGame) {
    await db.execute(sql`
      UPDATE games SET play_count = play_count + ${plays} WHERE id = ${gameId}
    `);
  }

  const headers = new Headers();
  if (mintedAnon && anonId) {
    setAnonCookie(
      {
        set: (name, value, options) => {
          headers.append('Set-Cookie', serializeCookie(name, value, options));
        },
      },
      anonId,
    );
  }
  return new Response(null, { status: 204, headers });
});
