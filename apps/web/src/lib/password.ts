import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEY_LEN = 64;
const PREFIX = 'scrypt';

/**
 * Password hashing for handle accounts.
 *
 * scrypt is in Node's stdlib (no native dependency to compile on Windows) and
 * is deliberately slow; parameters here are the Node defaults (N=16384, r=8,
 * p=1) with a 16-byte random salt per password. Format: `scrypt$<salt>$<key>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEY_LEN);
  return `${PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time verification; false for malformed/absent hashes. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== PREFIX || !saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length !== KEY_LEN) return false;
  const actual = await scryptAsync(password.normalize('NFKC'), salt, KEY_LEN);
  return timingSafeEqual(actual, expected);
}

export const MIN_PASSWORD_LENGTH = 6;

/** Handles that must never be claimable by a visitor. */
export const RESERVED_HANDLES = new Set(['playloop', 'admin', 'support', 'official']);
