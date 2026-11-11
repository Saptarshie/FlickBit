/**
 * Per-user generation quota.
 *
 * Generation is the only expensive operation in the product (a single game is a
 * multi-minute LLM completion, up to a few repair passes). Without a cap an
 * authenticated account can still burn arbitrary spend, so every process keeps
 * a sliding one-hour window per user.
 *
 * This is deliberately in-memory: it protects the single dev server and any
 * single-instance deployment. A horizontally scaled deployment must move this
 * to Redis/Postgres — the call site does not change.
 */
export const MAX_PROMPT_LENGTH = 600;
export const GENERATIONS_PER_HOUR = 12;

type Bucket = { hits: number[]; };
const globalForQuota = globalThis as unknown as { __playloopGenQuota?: Map<string, Bucket> };
const buckets = (globalForQuota.__playloopGenQuota ??= new Map<string, Bucket>());

const WINDOW_MS = 60 * 60 * 1000;

export type QuotaResult =
  | { allowed: true; remaining: number }
  | { allowed: false; limit: number; retryAfterSeconds: number };

export function takeGenerationSlot(userId: string, now = Date.now()): QuotaResult {
  const bucket = buckets.get(userId) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);

  if (bucket.hits.length >= GENERATIONS_PER_HOUR) {
    buckets.set(userId, bucket);
    const oldest = bucket.hits[0] ?? now;
    return {
      allowed: false,
      limit: GENERATIONS_PER_HOUR,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }

  bucket.hits.push(now);
  buckets.set(userId, bucket);
  return { allowed: true, remaining: GENERATIONS_PER_HOUR - bucket.hits.length };
}

/** Test helper: forget all windows. */
export function resetGenerationQuota(): void {
  buckets.clear();
}
