import { describe, expect, it } from 'vitest';
import { fetchFeedGames, type GameCard, type FeedPage } from './feed';

const PLAY_ORIGIN = process.env.PLAY_ORIGIN ?? 'http://play.localhost:3001';

describe('fetchFeedGames', () => {
  it('returns 20 items and always a null cursor', async () => {
    const page: FeedPage = await fetchFeedGames();
    expect(page.items).toHaveLength(20);
    expect(page.cursor).toBeNull();
    // cursor is ignored while the feed is a mock
    const page2: FeedPage = await fetchFeedGames('cursor-token');
    expect(page2.items).toHaveLength(20);
    expect(page2.cursor).toBeNull();
  });

  it('artifactUrls start with the play origin and end with .html', async () => {
    const { items } = await fetchFeedGames();
    for (const card of items) {
      expect(card.artifactUrl.startsWith(`${PLAY_ORIGIN}/v/`)).toBe(true);
      expect(card.artifactUrl.endsWith('.html')).toBe(true);
      expect(card.artifactUrl).toMatch(/^https?:\/\/.+\/v\/[0-9a-f]{64}\.html$/);
    }
  });

  it('every card has a non-empty title and tags', async () => {
    const { items } = await fetchFeedGames();
    for (const card of items) {
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.tags.length).toBeGreaterThan(0);
      for (const tag of card.tags) expect(tag.length).toBeGreaterThan(0);
    }
  });

  it('cards conform to the GameCard contract', async () => {
    const { items } = await fetchFeedGames();
    const seenIds = new Set<string>();
    for (const card of items) {
      const shape: GameCard = card;
      expect(typeof shape.id).toBe('string');
      expect(shape.id.length).toBeGreaterThan(0);
      expect(shape.versionId.length).toBeGreaterThan(0);
      expect(seenIds.has(card.id)).toBe(false);
      seenIds.add(card.id);
      expect(card.description.length).toBeGreaterThan(0);
      expect(card.creator.id.length).toBeGreaterThan(0);
      expect(card.creator.handle.length).toBeGreaterThan(0);
      expect(card.counts).toEqual({ likes: 0, saves: 0, comments: 0, plays: 0 });
      expect(card.viewer).toEqual({ liked: false, saved: false, followsCreator: false });
      expect(card.forkedFrom ?? null).toBeNull();
      expect(card.posterUrl ?? null).toBeNull();
    }
  });
});
