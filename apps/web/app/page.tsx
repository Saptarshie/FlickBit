'use client';

import FeedScreen from '../src/components/FeedScreen';

/**
 * Feed route.
 *
 * Keyboard shortcuts (ArrowUp/Down, Space, M, Home/End, PageUp/PageDown) are
 * owned by FeedScreen only — this route used to install a second window
 * `keydown` listener, so every shortcut fired twice and one ArrowDown skipped
 * two cards.
 */
export default function Home() {
  return <FeedScreen />;
}
