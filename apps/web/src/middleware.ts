import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';
import { auth, type NextAuthRequest } from '../auth';

type NextMiddlewareFn = (
  req: NextRequest,
  event: NextFetchEvent,
) => Response | void | Promise<Response | void>;

/** Paths that never require a session. */
const PUBLIC_EXACT = new Set(['/', '/login', '/api/auth', '/api/events']);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/events/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  // Static assets (favicon.ico, manifest.webmanifest, /js/app.js, ...)
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return lastSegment.includes('.');
}

const middleware = auth((req: NextAuthRequest) => {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (!req.auth) {
    const loginUrl = new URL('/login', req.nextUrl);
    loginUrl.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
});

export default middleware as unknown as NextMiddlewareFn;

export const config = {
  matcher: [
    // Everything except /api/auth, /api/events, Next internals and dotted static files.
    '/((?!api/auth|api/events|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};
