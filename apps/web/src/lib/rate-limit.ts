/**
 * Small in-process rate limiter for write endpoints.
 *
 * The generation route already has a real quota (`generation-quota.ts`) because
 * a build costs money; the social endpoints had none at all, so one script could
 * fill `comments` or spin `likes`. This is deliberately simple: a sliding window
 * per (bucket, identity) held in memory.
 *
 * Limits are per process, so a multi-instance deployment should move the same
 * interface onto Redis — the call sites do not change.
 */
type Window = { hits: number[]; };

const windows = new Map<string, Window>();
let lastSweep = Date.now();
const SWEEP_MS = 60_000;

function sweep(now: number) {
  if (now - lastSweep < SWEEP_MS) return;
  lastSweep = now;
  for (const [key, w] of windows) {
    if (w.hits.length === 0 || now - w.hits[w.hits.length - 1]! > 15 * 60_000) windows.delete(key);
  }
}

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export function takeRateLimit(bucket: string, identity: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const key = `${bucket}:${identity}`;
  const existing = windows.get(key) ?? { hits: [] };
  existing.hits = existing.hits.filter((t) => now - t < windowMs);
  if (existing.hits.length >= max) {
    windows.set(key, existing);
    const oldest = existing.hits[0] ?? now;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
  }
  existing.hits.push(now);
  windows.set(key, existing);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Visible for tests. */
export function resetRateLimits() {
  windows.clear();
  lastSweep = Date.now();
}
