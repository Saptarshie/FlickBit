/**
 * Splash / boot animation decisions, kept out of the component so they can be
 * tested without a DOM.
 *
 * The rule the product cares about: the intro is a *loading* animation, never a
 * delay. It shows while the first feed page and the default engine are warming
 * up, and it leaves the moment the feed can paint — even if that is 300 ms.
 */

/** Below this the animation would read as a stutter, not a brand moment. */
export const SPLASH_MIN_MS = 700;

/** Above this the animation itself becomes the lag. */
export const SPLASH_MAX_MS = 2400;

export type SplashContext = {
  /** Shown earlier in this tab session? */
  seen: boolean;
  /** OS-level "reduce motion" — the animation is skipped, not shortened. */
  reducedMotion: boolean;
};

export function shouldShowSplash({ seen, reducedMotion }: SplashContext): boolean {
  if (reducedMotion) return false;
  return !seen;
}

/**
 * Two conditions, and the animation ends on whichever comes last:
 *   - the feed has painted at least one card (never show a splash over a ready feed)
 *   - the minimum brand time elapsed (never flash a logo for 80 ms)
 * …with a hard ceiling so a slow DB or a failed feed cannot hold the screen.
 */
export function splashDone(elapsedMs: number, feedReady: boolean): boolean {
  if (elapsedMs >= SPLASH_MAX_MS) return true;
  return feedReady && elapsedMs >= SPLASH_MIN_MS;
}
