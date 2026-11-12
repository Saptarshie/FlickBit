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

/**
 * Ids already reported in this page session. Bounded: an infinite feed would
 * otherwise keep every impression id for the life of the tab.
 */
const seen = new Set<string>();
const SEEN_LIMIT = 500;
function markSeen(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}
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
    if (!markSeen(`${type}:${gameId}`)) return;
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
