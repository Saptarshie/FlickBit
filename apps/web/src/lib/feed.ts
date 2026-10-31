'use server';

/**
 * Feed data access.
 *
 * TODO(feed): THIS IS A MOCK. The database is empty right now, so
 * `fetchFeedGames` synthesises the feed by cycling the 8 seed templates from
 * `@playloop/gamekit`. Replace the body of `fetchFeedGames` with a real DB
 * query (`@playloop/db`, games + versions + counts + viewer rows joined per
 * card, keyset-paginated on `cursor`) as soon as publishing exists. Keep the
 * `GameCard` / `FeedPage` shape stable — other modules depend on it.
 *
 * The module is a `'use server'` action module so that client components can
 * import `fetchFeedGames` directly (it runs server-side only; the templates
 * are read from disk with node:fs and hashed with node:crypto).
 */

import { createHash } from 'node:crypto';
import { TEMPLATES, extractManifest } from '@playloop/gamekit';

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
};

export type FeedPage = {
  items: GameCard[];
  cursor: string | null;
};

/** Number of cards in a mock feed page. */
const PAGE_SIZE = 20;

const DEFAULT_PLAY_ORIGIN = 'http://play.localhost:3001';

const MOCK_CREATOR_HANDLES = ['pixelpanda', 'arcade_ash', 'neonmoth', 'tapsmith', 'loopkat'];

/** Suffixes so cycled templates read as plausible variants. */
const VARIANT_SUFFIXES = ['', ' II', ' III'];

/** `sha256hex(code)` — the artifact address on the play origin. */
function artifactHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Mock feed page built from the gamekit seed templates.
 * `cursor` is ignored for now (single page, always `cursor: null`).
 */
export async function fetchFeedGames(cursor?: string): Promise<FeedPage> {
  // TODO(feed): replace with a real keyset-paginated DB query once the
  // database is populated. `cursor` is accepted but unused until then.
  void cursor;

  const origin = process.env.PLAY_ORIGIN ?? DEFAULT_PLAY_ORIGIN;

  const items: GameCard[] = [];
  for (let i = 0; i < PAGE_SIZE; i += 1) {
    const template = TEMPLATES[i % TEMPLATES.length];
    if (!template) continue;
    const manifest = extractManifest(template.code);
    const variant = Math.floor(i / TEMPLATES.length);
    const title = (manifest?.title ?? template.id) + (VARIANT_SUFFIXES[variant] ?? '');
    const description = manifest?.description ?? `Play ${title} on PlayLoop.`;
    const tags = manifest?.tags ?? ['game'];

    items.push({
      id: `seed-${template.id}-${i}`,
      versionId: `seed-${template.id}-v1`,
      title,
      description,
      tags,
      creator: {
        id: `creator-${(i % MOCK_CREATOR_HANDLES.length) + 1}`,
        handle: MOCK_CREATOR_HANDLES[i % MOCK_CREATOR_HANDLES.length] ?? 'playloop',
        avatar: null,
      },
      artifactUrl: `${origin}/v/${artifactHash(template.code)}.html`,
      posterUrl: null,
      counts: { likes: 0, saves: 0, comments: 0, plays: 0 },
      viewer: { liked: false, saved: false, followsCreator: false },
      forkedFrom: null,
    });
  }

  return { items, cursor: null };
}
