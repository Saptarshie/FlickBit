'use server';

/**
 * Feed data access (server action).
 *
 * Real DB-backed feed: pulls candidates from `@playloop/recsys` (trending /
 * fresh / social / explore -> ranker -> MMR diversify) and hydrates the cards
 * from Postgres. Returns an empty page (never fake games) when nothing is
 * published or the DB is unreachable, so the UI shows an honest empty state.
 */

import { fetchFeedPage } from '@playloop/recsys';
import { auth } from '../../auth';
import { getDb } from './db';

export type GameCard = {
  id: string;
  versionId: string;
  title: string;
  description: string;
  tags: string[];
  creator: { id: string; handle: string; avatar: string | null };
  artifactUrl: string;
  posterUrl: string | null;
  counts: { likes: number; saves: number; comments: number; plays: number };
  viewer: { liked: boolean; saved: boolean; followsCreator: boolean };
  forkedFrom?: { id: string; title: string } | null;
  /** Primary tag, used by the client for ambient theming/analytics. */
  primaryTag?: string;
};

export type FeedPage = {
  items: GameCard[];
  cursor: string | null;
};

const PAGE_SIZE = 10;

export async function fetchFeedGames(cursor?: string): Promise<FeedPage> {
  const session = await auth();
  const playOrigin = process.env.PLAY_ORIGIN ?? 'http://localhost:3001';

  let page;
  try {
    page = await fetchFeedPage(getDb(), {
      userId: session?.user?.id,
      cursor,
      limit: PAGE_SIZE,
      playOrigin,
    });
  } catch (err) {
    // Swallowing this turned a backend outage into "No games yet — be the
    // first to create one". Let the client show a real error state.
    console.error('[feed] query failed:', err instanceof Error ? err.message : err);
    throw err;
  }

  return {
    items: page.items.map((c) => ({ ...c, primaryTag: c.tags[0] })),
    cursor: page.cursor,
  };
}
