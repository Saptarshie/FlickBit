'use client';

import { useEffect } from 'react';
import FeedScreen from '../src/components/FeedScreen';
import { useFeedStore } from '../src/lib/feed-store';

/**
 * Feed route. Reels-style scroll feed plus desktop keyboard shortcuts:
 * ArrowUp/ArrowDown = previous/next card, Space = pause/resume, M = mute.
 */
export default function Home() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      const state = useFeedStore.getState();
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          event.preventDefault();
          const dir = event.key === 'ArrowDown' ? 1 : -1;
          const next = Math.max(0, Math.min(state.activeIndex + dir, Math.max(state.itemCount - 1, 0)));
          if (next !== state.activeIndex) {
            state.setActiveIndex(next);
            state.scrollToIndex?.(next);
          }
          break;
        }
        case ' ':
          event.preventDefault();
          state.togglePlaying();
          break;
        case 'm':
        case 'M':
          event.preventDefault();
          state.toggleMuted();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return <FeedScreen />;
}
