import { randomUUID } from 'node:crypto';
import { auth } from '../../../auth';
import { getDb } from '@/lib/db';
import {
  ANON_COOKIE_NAME,
  makeAnonId,
  setAnonCookie,
  verifyAnonId,
  type AnonCookieOptions,
} from '@/lib/anon';
import { wrap } from '@/lib/api-helpers';
import { fetchFeedPage } from '@playloop/recsys';

export const dynamic = 'force-dynamic';

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

export const GET = wrap(async (req) => {
  const session = (await auth()) as { user?: { id?: string | null } | null } | null;
  const userId = session?.user?.id ?? null;

  const cookieAnon = getCookie(req, ANON_COOKIE_NAME);
  let anonId: string | undefined = cookieAnon && verifyAnonId(cookieAnon) ? cookieAnon : undefined;
  let newlyMintedAnon: string | null = null;

  if (!userId && !anonId) {
    anonId = makeAnonId(randomUUID());
    newlyMintedAnon = anonId;
  }

    const { searchParams } = new URL(req.url);
    const cursor = searchParams.get('cursor') || undefined;
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : 10;

    const playOrigin =
      process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://play.localhost:3001';

  const feedPage = await fetchFeedPage(getDb(), {
    userId: userId ?? undefined,
    anonId,
    cursor,
    limit: Number.isFinite(limit) ? limit : 10,
    playOrigin,
  });

  const headers = new Headers({ 'content-type': 'application/json' });
  if (newlyMintedAnon) {
    setAnonCookie(
      {
        set: (name, value, options) => {
          headers.append('Set-Cookie', serializeCookie(name, value, options));
        },
      },
      newlyMintedAnon,
    );
  }

  return new Response(JSON.stringify({ data: feedPage }), { status: 200, headers });
});
