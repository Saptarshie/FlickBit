/**
 * Runtime prefetch — "load the engine once", arranged so nobody waits for it.
 *
 * The feed already knows each card's runtime (it rides in the manifest), so the
 * engine a card needs can be downloaded 3–4 cards early, on an idle callback,
 * at low priority. By the time the card is scrolled to, the bytes are in the
 * HTTP cache and the iframe's first paint is local.
 *
 * Three rules this module exists to enforce:
 *   1. Never block a scroll. Prefetch is fire-and-forget; failures are silent.
 *   2. Never spend the user's metered data unasked (`saveData`, 2G/3G, >700 KB).
 *   3. Never fetch twice. A module-level Set outlives React re-renders.
 */

export type RuntimeInfo = {
  id: string;
  version: string;
  url: string;
  integrity: string;
  bytes: number;
};

/** Cheap, conservative: what the engine may cost this session. */
const BUDGET_BYTES = 700 * 1024;

const fetched = new Set<string>();
const failed = new Set<string>();
let indexPromise: Promise<RuntimeInfo[]> | null = null;

function sameOriginPlayBase(): string {
  // The worker is same-origin in dev (`localhost:3001` differs, so the feed
  // passes its origin through NEXT_PUBLIC_PLAY_ORIGIN).
  return (
    process.env.NEXT_PUBLIC_PLAY_ORIGIN ??
    (typeof window !== 'undefined' ? window.location.origin : '')
  ).replace(/\/$/, '');
}

function connection():
  | { saveData?: boolean; effectiveType?: string; downlink?: number }
  | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string; downlink?: number } })
    .connection;
}

/** False when prefetching would cost the user real money or time. */
export function mayPrefetch(): boolean {
  const c = connection();
  if (!c) return true;
  if (c.saveData === true) return false;
  const slow = c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g';
  if (slow) return false;
  if (typeof c.downlink === 'number' && c.downlink > 0 && c.downlink < 1.5) return false;
  return true;
}

/** The origin's runtime catalogue, fetched at most once per session. */
export async function runtimeIndex(): Promise<RuntimeInfo[]> {
  if (typeof window === 'undefined') return [];
  indexPromise ??= fetch(`${sameOriginPlayBase()}/r/index.json`, {
    cache: 'force-cache',
    credentials: 'omit',
  })
    .then((res) => (res.ok ? (res.json() as Promise<{ runtimes?: RuntimeInfo[] }>) : { runtimes: [] }))
    .then((body) => body.runtimes ?? [])
    .catch(() => []);
  return indexPromise;
}

/**
 * Download the engines these cards will need, cheapest first, within budget.
 * Returns the ids it started fetching (handy in tests and devtools).
 */
export async function prefetchRuntimes(ids: Array<string | null | undefined>): Promise<string[]> {
  if (typeof window === 'undefined' || !mayPrefetch()) return [];
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id) && id !== 'micro'))];
  const missing = wanted.filter((id) => !fetched.has(id) && !failed.has(id));
  if (missing.length === 0) return [];

  const index = await runtimeIndex();
  if (index.length === 0) return [];

  const run = () => {
    let spent = 0;
    const started: string[] = [];
    for (const id of missing) {
      const info = index.filter((r) => r.id === id).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
      if (!info) continue;
      if (spent + info.bytes > BUDGET_BYTES) continue;
      spent += info.bytes;
      fetched.add(id);
      started.push(id);
      // `priority` is not in the TS lib yet but is honoured by Chromium.
      void fetch(info.url, {
        cache: 'force-cache',
        credentials: 'omit',
        priority: 'low',
        integrity: info.integrity,
      } as RequestInit).catch(() => {
        fetched.delete(id);
        failed.add(id);
      });
    }
    return started;
  };

  // Yield to the current frame: a prefetch must never delay a swipe.
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof idle === 'function') {
    return new Promise<string[]>((resolve) => idle(() => resolve(run()), { timeout: 2000 }));
  }
  return new Promise<string[]>((resolve) => setTimeout(() => resolve(run()), 120));
}

/** Test seam. */
export function __resetRuntimePrefetch(): void {
  fetched.clear();
  failed.clear();
  indexPromise = null;
}
