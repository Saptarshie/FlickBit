/**
 * Asset registry — the platform's own vocabulary of sprites, tiles, UI and sound.
 *
 * Three rules make this safe to hand to a model:
 *  1. Every asset is content-addressed. Its URL *is* its hash, so a cached copy
 *     can never be stale and two games using the same sprite share one download.
 *  2. Every asset carries its licence and, when the licence demands it, the exact
 *     attribution string. The agent may only pick from records that allow
 *     commercial use; remixes inherit the provenance block.
 *  3. The registry is a file, not a database. It is small, diffable, and can be
 *     rebuilt from the optimised bytes at any time.
 */
import { createHash } from 'node:crypto';

export type AssetKind = 'sprite' | 'tileset' | 'background' | 'ui' | 'icon' | 'sfx' | 'music' | 'model';

/**
 * A flat content-addressed store is right for delivery and wrong for retrieval.
 * This is the retrieval vocabulary: the folders a human would browse and a model
 * can be told about ("2d/characters"). Every asset has exactly one.
 */
export const CATEGORIES = [
  '2d/characters',
  '2d/enemies',
  '2d/environments',
  '2d/tilesets',
  '2d/objects',
  '2d/effects',
  '3d/characters',
  '3d/environments',
  '3d/props',
  '3d/vehicles',
  '3d/weapons',
  'ui/buttons',
  'ui/panels',
  'ui/icons',
  'ui/hud',
  'audio/sfx',
  'audio/music',
] as const;

export type AssetCategory = (typeof CATEGORIES)[number];

export type Licence = {
  /** SPDX-style identifier: 'CC0-1.0', 'CC-BY-4.0', 'QAL-1.0', ... */
  id: string;
  commercialUse: boolean;
  modification: boolean;
  /** May the file itself be redistributed (e.g. inside a remixable project)? */
  redistribution: boolean;
  /** Exact text to display when attribution is required. Empty for CC0. */
  attribution: string;
  /** Where the licence text lives, for the audit trail. */
  url: string;
};

export type AssetRecord = {
  id: string;
  name: string;
  kind: AssetKind;
  tags: string[];
  /** sha256 of the optimised bytes, hex. */
  sha256: string;
  /** '<sha256[0:16]>.<ext>' — the file name under /a/. */
  file: string;
  bytes: number;
  width?: number;
  height?: number;
  /** True when the image must be drawn with nearest-neighbour scaling. */
  pixelArt: boolean;
  /** Where it belongs in the browse tree, e.g. '2d/characters'. */
  category?: AssetCategory;
  /** Which runtimes can consume it (all of them, today). */
  runtime: Array<'micro' | 'phaser4' | 'babylon'>;
  licence: Licence;
  source: string;
  /** Where the raw file came from, for reproducibility. */
  sourceUrl?: string;
};

export const CC0: Licence = {
  id: 'CC0-1.0',
  commercialUse: true,
  modification: true,
  redistribution: true,
  attribution: '',
  url: 'https://creativecommons.org/publicdomain/zero/1.0/',
};

export function sha256(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** File name is derived from the bytes: content-addressed by construction. */
export function assetFileName(sha: string, ext: string): string {
  return `${sha.slice(0, 16)}.${ext}`;
}

export function assetUrl(file: string, origin = ''): string {
  return `${origin.replace(/\/$/, '')}/a/${file}`;
}

export type AssetIndex = { version: 1; assets: AssetRecord[] };

export function parseIndex(json: unknown): AssetIndex {
  if (!json || typeof json !== 'object') return { version: 1, assets: [] };
  const assets = Array.isArray((json as AssetIndex).assets) ? (json as AssetIndex).assets : [];
  return {
    version: 1,
    assets: assets.filter(
      (a): a is AssetRecord =>
        Boolean(a) &&
        typeof a.id === 'string' &&
        typeof a.file === 'string' &&
        typeof a.sha256 === 'string' &&
        typeof a.bytes === 'number' &&
        Boolean(a.licence) &&
        typeof a.licence.commercialUse === 'boolean',
    ),
  };
}

export type AssetQuery = {
  text?: string;
  kind?: AssetKind;
  category?: AssetCategory | AssetCategory[];
  tags?: string[];
  maxBytes?: number;
  commercialOnly?: boolean;
  /** Top-k. Default 8: a model reading a prompt can act on a shortlist, not a catalogue. */
  limit?: number;
};

/**
 * Ranked retrieval, not a filter.
 *
 * The old version returned every match sorted by size, which is fine for "give me
 * the 24 smallest sprites" and useless for "give me a cat". This scores each
 * record: an exact tag/name hit beats a substring, a kind match beats a category
 * match, and a smaller file wins only as a tie-break. Returns the top `limit`.
 */
export function searchAssets(index: AssetIndex, query: AssetQuery): AssetRecord[] {
  const needle = (query.text ?? '').toLowerCase().trim();
  const words = needle.split(/\s+/).filter(Boolean);
  const tags = (query.tags ?? []).map((t) => t.toLowerCase());
  const categories = query.category === undefined ? [] : Array.isArray(query.category) ? query.category : [query.category];

  const scored = index.assets
    // parseIndex already rejects records without a licence; a caller passing a
    // hand-built list gets the benefit of the doubt rather than a crash.
    .filter((a) => (query.commercialOnly === false ? true : a.licence === undefined || a.licence.commercialUse))
    .filter((a) => (query.kind ? a.kind === query.kind : true))
    .filter((a) => (categories.length === 0 ? true : a.category !== undefined && categories.includes(a.category)))
    .filter((a) => (query.maxBytes ? a.bytes <= query.maxBytes : true))
    .filter((a) => (tags.length === 0 ? true : tags.every((t) => a.tags.some((tag) => tag.toLowerCase() === t))))
    .map((a) => {
      const id = a.id.toLowerCase();
      const name = a.name.toLowerCase();
      const tagHit = a.tags.some((tag) => tag.toLowerCase() === needle);
      let score = 0;
      let matched = 0;
      if (needle.length > 0) {
        for (const word of words) {
          if (id === word || name === word) score += 8;
          else if (tagHit) score += 6;
          else if (id.includes(word) || name.includes(word)) score += 4;
          else if (a.tags.some((tag) => tag.toLowerCase().includes(word))) score += 3;
          else if ((a.category ?? '').includes(word)) score += 2;
          else if (a.kind.includes(word)) score += 2;
          else continue;
          matched += 1;
        }
        if (matched === 0) return null; // no textual overlap at all
      }
      if (query.kind && a.kind === query.kind) score += 2;
      if (a.category && categories.includes(a.category as AssetCategory)) score += 2;
      // Prefer the cheaper file when everything else ties.
      score -= Math.min(4, a.bytes / 40_000);
      return { asset: a, score, matched };
    })
    .filter((row): row is { asset: AssetRecord; score: number; matched: number } => row !== null);

  // Precision first: if anything matches every word, those are the answer. Only
  // fall back to partial matches when the strict reading finds nothing — a model
  // asking for "cute pixel cat" should not get the whole catalogue back.
  const full = scored.filter((row) => row.matched === words.length);
  const pool = words.length === 0 || full.length > 0 ? full : scored;
  pool.sort((x, y) => y.score - x.score || x.asset.bytes - y.asset.bytes);

  return pool.slice(0, query.limit ?? 8).map((row) => row.asset);
}

/** Group by category, for a browse tree or a contact sheet per folder. */
export function byCategory(index: AssetIndex): Map<string, AssetRecord[]> {
  const out = new Map<string, AssetRecord[]>();
  for (const a of index.assets) {
    const key = a.category ?? 'uncategorised';
    const list = out.get(key) ?? [];
    list.push(a);
    out.set(key, list);
  }
  return out;
}

/** Total bytes a game adds on a cold cache. */
export function bundleBytes(assets: Array<Pick<AssetRecord, 'bytes'>>): number {
  return assets.reduce((sum, a) => sum + a.bytes, 0);
}

/** Budget check: the same shape for every publishing profile. */
export const PROFILES = {
  instant: 1_000_000,
  standard: 2_500_000,
  rich: 5_000_000,
} as const;

export type PublishProfile = keyof typeof PROFILES;

export function withinBudget(assets: Array<Pick<AssetRecord, 'bytes'>>, profile: PublishProfile): boolean {
  return bundleBytes(assets) <= PROFILES[profile];
}
