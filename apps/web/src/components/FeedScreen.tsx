'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { fetchFeedGames, type GameCard } from '../lib/feed';
import { useFeedStore } from '../lib/feed-store';
import GameCardView from './GameCardView';

/** Hard memory rule (docs 08/12): at most 3 iframes — active ±1. */
const MOUNT_RADIUS = 1;

/**
 * Reels-style vertical feed: snap scrolling, IntersectionObserver-driven
 * active card, and aggressive unmounting — only the active card and its
 * immediate neighbours keep a live game iframe; the rest render a poster
 * placeholder. Keyboard handling (↑/↓, Space, M) lives in app/page.tsx.
 */
export default function FeedScreen() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);
  const ratioByIndex = useRef<Map<number, number>>(new Map());

  const activeIndex = useFeedStore((s) => s.activeIndex);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['feed'],
    queryFn: () => fetchFeedGames(),
    staleTime: 60_000,
  });

  const items: GameCard[] = data?.items ?? [];
  const itemCount = items.length;

  // Feed length into the store (keyboard navigation clamps on it).
  useEffect(() => {
    useFeedStore.getState().setItemCount(itemCount);
  }, [itemCount]);

  // Register the scroll hook used by keyboard nav and the Next chevron.
  useEffect(() => {
    const state = useFeedStore.getState();
    state.registerScrollToIndex((index) => {
      const el = cardRefs.current[index];
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => useFeedStore.getState().registerScrollToIndex(null);
  }, []);

  // IntersectionObserver (threshold 0.6) decides the active card.
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
        if (best >= 0 && bestRatio >= 0.6 && useFeedStore.getState().activeIndex !== best) {
          useFeedStore.getState().setActiveIndex(best);
        }
      },
      { root: container, threshold: [0, 0.6, 1] },
    );

    for (const el of cardRefs.current) {
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [itemCount]);

  const goTo = (index: number) => {
    const state = useFeedStore.getState();
    const clamped = Math.max(0, Math.min(index, Math.max(itemCount - 1, 0)));
    if (clamped !== state.activeIndex) state.setActiveIndex(clamped);
    state.scrollToIndex?.(clamped);
  };

  const goNext = () => goTo(useFeedStore.getState().activeIndex + 1);

  if (isLoading) {
    return (
      <div style={{ height: '100dvh', display: 'flex', alignItems: 'flex-end', background: '#0b0b10' }}>
        <div style={{ padding: '0 16px calc(env(safe-area-inset-bottom, 0px) + 24px)' }}>
          <div style={{ width: 240, height: 22, borderRadius: 6, background: 'rgba(255,255,255,0.14)' }} />
          <div style={{ width: 320, height: 16, borderRadius: 6, background: 'rgba(255,255,255,0.10)', marginTop: 10 }} />
          <div style={{ width: 180, height: 16, borderRadius: 6, background: 'rgba(255,255,255,0.10)', marginTop: 10 }} />
        </div>
      </div>
    );
  }

  if (isError || itemCount === 0) {
    return (
      <div style={{ height: '100dvh', display: 'grid', placeItems: 'center', background: '#0b0b10', color: '#fff' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>No games yet</div>
          <button
            type="button"
            onClick={() => refetch()}
            style={{
              marginTop: 16,
              minWidth: 120,
              minHeight: 48,
              borderRadius: 24,
              border: 'none',
              background: '#fff',
              color: '#0b0b10',
              fontSize: 16,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
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
          />
        </section>
      ))}
    </div>
  );
}
