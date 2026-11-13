'use client';

import { useEffect, useRef, useState } from 'react';
import { useFeedStore } from '../lib/feed-store';
import { prefetchRuntimes } from '../lib/runtime-prefetch';
import { shouldShowSplash, splashDone } from '../lib/splash';

const SEEN_KEY = 'pl.splash.shown';

/**
 * Boot animation that also does work.
 *
 * It is not decoration with a timer: while it plays, the default engine is
 * fetched and the first feed page is on its way. On a cold visit that hides the
 * only cost the player would otherwise feel — the Phaser download — behind a
 * brand moment they expected to see anyway.
 *
 * Shown at most once per tab session, never when the OS asks for reduced motion,
 * and it yields the screen the instant the feed can paint.
 */
export default function SplashGate({ children }: { children: React.ReactNode }) {
  const feedReady = useFeedStore((s) => s.feedReady);
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const startedAt = useRef(0);

  useEffect(() => {
    const reducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let seen = false;
    try {
      seen = sessionStorage.getItem(SEEN_KEY) === '1';
    } catch {
      seen = false;
    }

    if (!shouldShowSplash({ seen, reducedMotion })) return;

    startedAt.current = performance.now();
    setVisible(true);
    try {
      sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* private mode: show it every time, no harm */
    }

    // Warm what the first cards will need. Phaser is the default runtime, so it
    // is fetched before any card asks for it.
    void prefetchRuntimes(['phaser4']);

    // The engine fetch is fire-and-forget; also give the prerendered shell a
    // frame to paint so the first visible thing is the animation, not a white box.
    requestAnimationFrame(() => document.body.classList.add('pl-booting'));
  }, []);

  useEffect(() => {
    if (!visible || leaving) return;
    const tick = window.setInterval(() => {
      const elapsed = performance.now() - startedAt.current;
      if (splashDone(elapsed, feedReady)) {
        setLeaving(true);
        window.clearInterval(tick);
        // Let the fade finish before unmounting so nothing pops.
        window.setTimeout(() => {
          setVisible(false);
          document.body.classList.remove('pl-booting');
        }, 320);
      }
    }, 60);
    return () => window.clearInterval(tick);
  }, [visible, leaving, feedReady]);

  return (
    <>
      {children}
      {visible ? (
        <div className={`pl-splash${leaving ? ' pl-splash--out' : ''}`} role="presentation" aria-hidden="true">
          <div className="pl-splash__mark">
            <span className="pl-splash__dot" />
            <span className="pl-splash__dot" />
            <span className="pl-splash__dot" />
          </div>
          <div className="pl-splash__word">FlickBit</div>
          <div className="pl-splash__line">
            <span />
          </div>
        </div>
      ) : null}
    </>
  );
}
