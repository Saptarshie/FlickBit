/**
 * Game runtimes.
 *
 * A game is never shipped with its engine. The artifact carries gameplay, the
 * platform carries the engine, and the two meet at serve time:
 *
 *   <script src="/r/phaser4@4.2.1-<hash>.js"></script>   (cached forever)
 *   <script>/* the 8 KB the model actually wrote *\/</script>
 *
 * The URL is content-addressed, so it can be cached immutably, and an artifact
 * pins the exact runtime it was built against — a new engine version can never
 * silently change an old game.
 *
 * `micro` is special: it is the protocol shim that is inlined into every
 * artifact (it is ~6 KB and must exist before any game code). It has no file.
 */

export type RuntimeId = 'micro' | 'phaser4' | 'babylon';

export type RuntimeDescriptor = {
  id: RuntimeId;
  /** Exact engine version, pinned by the artifact's manifest. */
  version: string;
  /** File served from the play origin (`/r/<id>@<version>-<hash>.js`), if any. */
  file?: string;
  /** Subresource-integrity string, filled in by whoever serves the file. */
  integrity?: string;
  /** Emitted when a manifest asks for a runtime the platform cannot serve. */
  available: boolean;
  /** What the engine is good at; the planner uses this to choose. */
  capabilities: string[];
  /** Rough compressed size, for prefetch budgeting. */
  approxGzipBytes: number;
};

/**
 * The allowlist. A manifest may only name an id from this table — never a URL.
 * Sizes are measured, not guessed (`gzip -9` of the published build).
 */
export const RUNTIMES: Record<RuntimeId, RuntimeDescriptor> = {
  micro: {
    id: 'micro',
    version: '1.0.0',
    available: true,
    capabilities: ['2d', 'arcade', 'pixels', 'no-assets'],
    approxGzipBytes: 0,
  },
  phaser4: {
    id: 'phaser4',
    version: '4.2.1',
    file: 'phaser4',
    // Phaser 4.2.1 full build: 1,344 KB raw / 346 KB gzip (measured).
    //
    // Tree-shaking was measured, not assumed: bundling `phaser.esm.js` with
    // esbuild importing only { Game, Scene, Scale, AUTO } produced 1,361 KB
    // (360 KB gz) — no gain. Phaser 4 ships one module graph with side effects,
    // so 346 KB is the floor.
    available: true,
    capabilities: ['2d', 'physics', 'tilemaps', 'particles', 'tweens', 'many-entities'],
    approxGzipBytes: 344 * 1024,
  },
  babylon: {
    id: 'babylon',
    version: '9.36.0',
    file: 'babylon',
    // Babylon.js 9.36 UMD: 8,700 KB raw / 1,881 KB gzip (measured). A
    // tree-shaken build lands nearer 500-800 KB; this is the ceiling, on
    // purpose, so the prefetch budget stays honest.
    available: false,
    capabilities: ['3d', 'webgl', 'webgpu', 'physics3d'],
    approxGzipBytes: 1881 * 1024,
  },
};

export const RUNTIME_IDS = Object.keys(RUNTIMES) as RuntimeId[];

export function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === 'string' && (RUNTIME_IDS as string[]).includes(value);
}

/** The runtime a manifest asks for, or `micro` when it names none. */
export function resolveRuntime(id?: string | null): RuntimeDescriptor {
  return isRuntimeId(id) ? RUNTIMES[id] : RUNTIMES.micro;
}

/** One page of JS for a runtime; `micro` needs none. */
export function isInlinedRuntime(descriptor: RuntimeDescriptor): boolean {
  return descriptor.id === 'micro';
}

/**
 * `/r/<id>@<version>-<hash>.js`.
 *
 * The hash is the first 16 hex chars of the file's sha384 (the same digest the
 * SRI attribute uses), so "which bytes are these" is answerable from the URL.
 */
export function runtimeFileName(id: RuntimeId, version: string, integrity: string): string {
  const digest = integrity.replace(/^sha(256|384|512)-/, '').slice(0, 16);
  return `${id}@${version}-${digest}.js`;
}

export function runtimeUrl(base: string, id: RuntimeId, version: string, integrity: string): string {
  return `${base.replace(/\/$/, '')}/r/${runtimeFileName(id, version, integrity)}`;
}

/**
 * Prefetch order for a set of upcoming games: cheapest first, deduped, and
 * never more than `budgetBytes` of engine in flight.
 */
export function planPrefetch(
  runtimes: Array<string | null | undefined>,
  opts: { loaded?: Set<string>; budgetBytes?: number } = {},
): RuntimeDescriptor[] {
  const loaded = opts.loaded ?? new Set<string>();
  const budget = opts.budgetBytes ?? 700 * 1024;
  const chosen: RuntimeDescriptor[] = [];
  let spent = 0;
  const seen = new Set<string>();
  for (const id of runtimes) {
    if (!id || seen.has(id) || loaded.has(id)) continue;
    seen.add(id);
    const descriptor = RUNTIMES[id as RuntimeId];
    if (!descriptor || !descriptor.available || isInlinedRuntime(descriptor)) continue;
    if (spent + descriptor.approxGzipBytes > budget) continue;
    spent += descriptor.approxGzipBytes;
    chosen.push(descriptor);
  }
  return chosen;
}
