import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route gating at the edge.
 *
 * This middleware must NOT import `auth`: Next bundles middleware for the edge
 * runtime, and `auth.ts` pulls in `node:crypto` (scrypt) — importing it fails the
 * whole build with `UnhandledSchemeError: node:crypto`.
 *
 * So this is a cheap presence check on the Auth.js session cookie. It is a
 * redirect layer, not an authorization boundary: every API route still calls
 * `requireUser`/`auth()`, and pages read the real session. Forging a cookie buys
 * nothing.
 */
const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token'];

/** Only these screens need an identity; the feed and shared links stay public. */
const PROTECTED = ['/studio', '/saved', '/notifications'];

function hasSessionCookie(req: NextRequest): boolean {
  return SESSION_COOKIES.some((name) => Boolean(req.cookies.get(name)?.value));
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  const needsSession =
    PROTECTED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
    pathname.startsWith('/api/studio/');

  if (!needsSession || hasSessionCookie(req)) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: { code: 'unauthorized', message: 'Sign in required' } }, { status: 401 });
  }
  const loginUrl = new URL('/login', req.nextUrl);
  loginUrl.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/studio/:path*', '/saved/:path*', '/notifications/:path*', '/api/studio/:path*'],
};
