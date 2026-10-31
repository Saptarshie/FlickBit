/**
 * Type-only global declaration of the PlayLoop guest API (the object the
 * injected shim installs as `window.PlayLoop` inside the sandboxed game frame).
 */

interface PlayLoopSafeArea {
  /** Pixels of host overlay to avoid at the top of the frame. */
  top: number;
  /** Pixels of host overlay to avoid at the bottom of the frame. */
  bottom: number;
}

interface PlayLoopGameOverOptions {
  score?: number;
  won?: boolean;
  stats?: Record<string, unknown>;
}

interface PlayLoopStorage {
  /** Resolve a stored value routed through the host; null on miss or timeout. */
  get(key: string): Promise<unknown>;
  /** Persist a value routed through the host (<= 16KB per game per user). */
  set(key: string, value: unknown): Promise<void>;
}

interface PlayLoopAPI {
  /** Call once when the first interactive frame is drawn. */
  ready(): void;
  /** End the run. */
  gameOver(options?: PlayLoopGameOverOptions): void;
  /** Push a score without ending the run. */
  submitScore(score: number): void;
  /** Host-routed key/value storage (the sandboxed origin has none). */
  storage: PlayLoopStorage;
  /** Seeded PRNG (mulberry32); default seed comes from the URL `seed` param. */
  rng(seed?: number | string): () => number;
  /** Ask the host device for haptic feedback. */
  haptic(type: 'light' | 'medium' | 'heavy' | (string & {})): void;
  /** Ask the host to open a share sheet. */
  share(text?: string): void;
  /** Dev logging surfaced in the Studio console. */
  log(message: unknown): void;
  /** Live values from the host init message; read before laying out UI. */
  readonly safeArea: PlayLoopSafeArea;
  /** Host asks the game to freeze (timers/rAF are also suspended shim-side). */
  onPause(callback: () => void): void;
  /** Host asks the game to continue. */
  onResume(callback: () => void): void;
  /** Host requests a fresh run. */
  onRestart(callback: () => void): void;
}

/** Global `PlayLoop` inside the game frame. */
declare const PlayLoop: PlayLoopAPI;

interface Window {
  PlayLoop?: PlayLoopAPI;
}
