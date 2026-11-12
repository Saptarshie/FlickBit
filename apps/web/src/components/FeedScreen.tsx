'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { fetchFeedGames, type GameCard } from '../lib/feed';
import { useFeedStore } from '../lib/feed-store';
import { prefetchRuntimes } from '../lib/runtime-prefetch';
import GameCardView from './GameCardView';
import { BottomNav } from './AppNav';

/** Hard memory rule (docs 08/12): at most 3 iframes — active ±1. */
const MOUNT_RADIUS = 1;
/** Fetch the next page when the viewer is this close to the end. */
const PREFETCH_WITHIN = 3;

/**
 * Reels-style vertical feed: snap scrolling in both directions, active card by
 * IntersectionObserver, cursor pagination, and at most 3 live iframes.
 */
export default function FeedScreen() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);
  const ratioByIndex = useRef<Map<number, number>>(new Map());

  const activeIndex = useFeedStore((s) => s.activeIndex);
  const muted = useFeedStore((s) => s.muted);

  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    queryKey: ['feed'],
    queryFn: ({ pageParam }) => fetchFeedGames(pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor ?? undefined,
    staleTime: 30_000,
  });

  const items: GameCard[] = data?.pages.flatMap((p) => p.items) ?? [];
  const nextPageFailed = isFetchNextPageError;
  const itemCount = items.length;

  useEffect(() => {
    useFeedStore.getState().setItemCount(itemCount);
  }, [itemCount]);

  useEffect(() => {
    useFeedStore.getState().registerScrollToIndex((index) => {
      const el = cardRefs.current[index];
      if (el && containerRef.current) {
        // scrollIntoView is layout-agnostic; offsetTop was only right while the
        // snap container sat at the top of the document.
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
    return () => useFeedStore.getState().registerScrollToIndex(null);
  }, []);

  // Prefetch more cards as the viewer approaches the end.
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    if (itemCount > 0 && activeIndex >= itemCount - PREFETCH_WITHIN) void fetchNextPage();
  }, [activeIndex, itemCount, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Prefetch the engines the next few cards will need.
  //
  // Announced 3–4 cards early, on an idle callback, at low priority: by the
  // time a card is on screen its engine is already in the HTTP cache. The
  // module dedupes across renders and checks saveData/2G itself.
  useEffect(() => {
    const ahead = items.slice(activeIndex + 1, activeIndex + PREFETCH_WITHIN + 2);
    if (ahead.length === 0) return;
    void prefetchRuntimes(ahead.map((card) => (card as GameCard).runtime));
  }, [activeIndex, items]);

  // IntersectionObserver decides the active card.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || itemCount === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = cardRefs.current.indexOf(entry.target as HTMLElement);
          if (index >= 0) ratioByIndex.current.set(index, entry.intersectionRatio);
        }
        let best = -1;
        let bestRatio = 0;
        for (const [index, ratio] of ratioByIndex.current) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            best = index;
          }
        }
        if (best >= 0 && bestRatio >= 0.55 && useFeedStore.getState().activeIndex !== best) {
          useFeedStore.getState().setActiveIndex(best);
        }
      },
      { root: container, threshold: [0, 0.55, 1] },
    );

    for (const el of cardRefs.current) {
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [itemCount]);

  const goTo = useCallback(
    (index: number) => {
      const state = useFeedStore.getState();
      const clamped = Math.max(0, Math.min(index, Math.max(itemCount - 1, 0)));
      if (clamped !== state.activeIndex) state.setActiveIndex(clamped);
      const el = cardRefs.current[clamped];
      if (el && containerRef.current) containerRef.current.scrollTo({ top: el.offsetTop, behavior: 'smooth' });
    },
    [itemCount],
  );

  const goNext = useCallback(() => goTo(useFeedStore.getState().activeIndex + 1), [goTo]);
  const goPrev = useCallback(() => goTo(useFeedStore.getState().activeIndex - 1), [goTo]);

  // Desktop keys: arrows / PageUp / PageDown / Home / End navigate, Space
  // pauses, M mutes. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      // A sheet that is actually OPEN owns the keyboard. Closed sheets stay
      // mounted inside an aria-hidden container, so "does a dialog exist?" is
      // the wrong question — it disabled every shortcut in the feed.
      const sheetOpen = [...document.querySelectorAll('[role="dialog"]')].some(
        (el) => !el.closest('[aria-hidden="true"]'),
      );
      if (sheetOpen) return;
      switch (event.key) {
        case 'ArrowDown':
        case 'PageDown':
          event.preventDefault();
          goNext();
          break;
        case 'ArrowUp':
        case 'PageUp':
          event.preventDefault();
          goPrev();
          break;
        case 'Home':
          event.preventDefault();
          goTo(0);
          break;
        case 'End':
          event.preventDefault();
          goTo(itemCount - 1);
          break;
        case ' ':
        case 'Spacebar': {
          event.preventDefault();
          const state = useFeedStore.getState();
          state.setPlaying(!state.isPlaying);
          break;
        }
        case 'm':
        case 'M':
          useFeedStore.getState().toggleMuted();
          break;
        case 'Escape':
          if (useFeedStore.getState().engagedGameId) {
            event.preventDefault();
            useFeedStore.getState().setEngaged(null);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, goTo, itemCount]);

  const toggleMute = () => useFeedStore.getState().toggleMuted();

  if (isLoading) {
    return (
      <div style={{ height: '100dvh', display: 'flex', alignItems: 'flex-end', background: '#0b0b10' }}>
        <div style={{ padding: '0 16px calc(env(safe-area-inset-bottom, 0px) + 96px)', width: '100%' }}>
          <div style={{ width: 240, height: 22, borderRadius: 6, background: 'rgba(255,255,255,0.14)' }} />
          <div style={{ width: '80%', height: 16, borderRadius: 6, background: 'rgba(255,255,255,0.10)', marginTop: 10 }} />
          <div style={{ width: 180, height: 16, borderRadius: 6, background: 'rgba(255,255,255,0.10)', marginTop: 10 }} />
        </div>
      </div>
    );
  }

  if (isError || itemCount === 0) {
    return (
      <div style={{ height: '100dvh', display: 'grid', placeItems: 'center', background: '#0b0b10', color: '#fff' }}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{isError ? 'Could not load the feed' : 'No games yet'}</div>
          <div style={{ opacity: 0.65, fontSize: 14, marginTop: 6 }}>
            {isError ? 'Check the server and try again.' : 'Be the first: create a game in the studio.'}
          </div>
          {isError ? (
            <button
              type="button"
              onClick={() => refetch()}
              style={{ marginTop: 16, minWidth: 120, minHeight: 48, borderRadius: 24, border: 'none', background: '#fff', color: '#0b0b10', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}
            >
              Retry
            </button>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <Link href="/studio" style={{ color: '#8ab4ff', fontSize: 14 }}>
              Open the studio →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Transparent top bar over the feed. */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: 'calc(44px + env(safe-area-inset-top, 0px))',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingLeft: 14,
          paddingRight: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          zIndex: 30,
          pointerEvents: 'none',
        }}
      >
        <Link href="/" style={{ color: '#fff', fontWeight: 800, fontSize: 17, textDecoration: 'none', pointerEvents: 'auto', textShadow: '0 1px 4px rgba(0,0,0,0.6)' }}>
          PlayLoop
        </Link>
        <div style={{ display: 'flex', gap: 8, pointerEvents: 'auto' }}>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? 'Unmute' : 'Mute'}
            style={{ width: 38, height: 38, borderRadius: 19, border: 'none', background: 'rgba(0,0,0,0.42)', color: '#fff', fontSize: 15, cursor: 'pointer' }}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <Link
            href="/studio"
            aria-label="Create a game"
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontSize: 22,
              fontWeight: 700,
              textDecoration: 'none',
              lineHeight: '38px',
            }}
          >
            +
          </Link>
        </div>
      </div>

      <div
        ref={containerRef}
        data-testid="feed-scroll"
        style={{
          height: '100dvh',
          overflowY: 'scroll',
          scrollSnapType: 'y mandatory',
          overscrollBehavior: 'none',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}
      >
        {items.map((card, index) => (
          <section
            key={card.id}
            ref={(el) => {
              cardRefs.current[index] = el;
            }}
            aria-label={card.title}
            style={{
              height: '100dvh',
              scrollSnapAlign: 'start',
              scrollSnapStop: 'always',
              position: 'relative',
              overflow: 'hidden',
              background: '#0b0b10',
            }}
          >
            <GameCardView
              card={card}
              live={Math.abs(index - activeIndex) <= MOUNT_RADIUS}
              isActive={index === activeIndex}
              onNext={goNext}
              onPrev={goPrev}
            />
          </section>
        ))}

        {/* End-of-feed sentinel: fetches the next page, or says you're done. */}
        <section
          aria-label="End of feed"
          style={{ height: '100dvh', display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.7)', background: '#0b0b10' }}
        >
          <div style={{ textAlign: 'center' }}>
            {hasNextPage ? (
              <>
                <button
                  type="button"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage}
                  style={{ minHeight: 48, padding: '0 22px', borderRadius: 24, border: 'none', background: '#fff', color: '#0b0b10', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}
                >
                  {isFetchingNextPage ? 'Loading…' : nextPageFailed ? 'Retry' : 'Load more'}
                </button>
                {nextPageFailed ? (
                  <p style={{ marginTop: 8, fontSize: 13, color: '#fca5a5' }}>Couldn’t load more games. Check your connection.</p>
                ) : null}
              </>
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 700 }}>You’re all caught up</div>
                <Link href="/studio" style={{ display: 'inline-block', marginTop: 12, color: '#8ab4ff', fontSize: 14 }}>
                  Create the next one →
                </Link>
              </>
            )}
          </div>
        </section>
      </div>

      <BottomNav transparent />
    </>
  );
}
