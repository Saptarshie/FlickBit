import { createHmac, timingSafeEqual } from 'node:crypto';

export const ANON_COOKIE_NAME = 'pl_anon';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Signing secret: AUTH_SECRET in production, dev-secret otherwise; truncated to 32 chars. */
function anonSecret(): string {
  return (process.env.AUTH_SECRET ?? 'dev-secret').slice(0, 32);
}

function signValue(value: string): string {
  return createHmac('sha256', anonSecret()).update(value).digest('hex');
}

/** Produce a tamper-evident anonymous id: `<value>.<hmacSha256Hex(value, secret)>`. */
export function makeAnonId(value: string): string {
  if (!value) throw new Error('anon id value must be non-empty');
  return `${value}.${signValue(value)}`;
}

/** Verify a signed anonymous id; rejects empty, malformed, or tampered values. */
export function verifyAnonId(raw: string): boolean {
  if (!raw) return false;
  const sep = raw.lastIndexOf('.');
  if (sep <= 0 || sep === raw.length - 1) return false;
  const value = raw.slice(0, sep);
  const signature = raw.slice(sep + 1);
  if (!value || !signature) return false;
  const expected = signValue(value);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AnonCookieOptions {
  httpOnly: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
}

/** Minimal structural type of the Next.js cookies() store (or any compatible setter). */
export interface AnonCookieStore {
  set(name: string, value: string, options: AnonCookieOptions): void;
}

/** Set the signed anon id in the pl_anon cookie (httpOnly, lax, one year). */
export function setAnonCookie(cookieStore: AnonCookieStore, value: string): void {
  cookieStore.set(ANON_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  });
}
