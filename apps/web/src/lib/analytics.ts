'use client';

/**
 * Fire-and-forget analytics beacons.
 *
 * The events API and the hourly rollup existed but nothing ever POSTed to them,
 * so every game read `plays: 0` and the ranker had no behavioural signal at all
 * (it collapsed to "newest first"). Events are batched per call and de-duped per
 * page load for impression-style types.
 */
type EventType =
  | 'impression'
  | 'play_start'
  | 'play_15s'
  | 'gameover'
  | 'replay'
  | 'like'
  | 'save'
  | 'comment'
  | 'share'
  | 'remix'
  | 'skip_fast';

const seen = new Set<string>();
let queue: Record<string, unknown>[] = [];
let flushTimer: number | null = null;

function flush(): void {
  const batch = queue;
  queue = [];
  flushTimer = null;
  if (batch.length === 0) return;
  try {
    void fetch('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics must never break the UI */
  }
}

export function track(
  type: EventType,
  gameId: string | null,
  options: { once?: boolean; position?: number; versionId?: string; props?: Record<string, unknown> } = {},
): void {
  if (gameId && options.once) {
    const key = `${type}:${gameId}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  queue.push({
    type,
    ts: new Date().toISOString(),
    gameId: gameId ?? undefined,
    versionId: options.versionId,
    position: options.position,
    props: options.props,
  });
  if (flushTimer === null) {
    flushTimer = window.setTimeout(flush, 400);
  }
}
