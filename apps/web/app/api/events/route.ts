import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EVENT_TYPES, insertEvents, type EventRow } from '@playloop/db';
import { auth } from '../../../auth';
import { getDb } from '../../../src/lib/db';
import {
  ANON_COOKIE_NAME,
  makeAnonId,
  setAnonCookie,
  verifyAnonId,
  type AnonCookieOptions,
} from '../../../src/lib/anon';
import { parseBody, wrap } from '../../../src/lib/api-helpers';

const eventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  ts: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'ts must be an ISO date string')
    .nullish(),
  gameId: z.uuid().nullish(),
  versionId: z.uuid().nullish(),
  position: z.number().int().nullish(),
  source: z.string().nullish(),
  props: z.record(z.string(), z.unknown()).nullish(),
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

  await insertEvents(getDb(), rows);

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
