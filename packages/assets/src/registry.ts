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

/** Filter for the agent: only what it is allowed to ship, only what it asked for. */
export function searchAssets(
  index: AssetIndex,
  query: { text?: string; kind?: AssetKind; tags?: string[]; maxBytes?: number; commercialOnly?: boolean },
): AssetRecord[] {
  const needle = query.text?.toLowerCase().trim() ?? '';
  const tags = (query.tags ?? []).map((t) => t.toLowerCase());
  return index.assets
    .filter((a) => (query.commercialOnly === false ? true : a.licence.commercialUse))
    .filter((a) => (query.kind ? a.kind === query.kind : true))
    .filter((a) => (query.maxBytes ? a.bytes <= query.maxBytes : true))
    .filter((a) => (tags.length === 0 ? true : tags.every((t) => a.tags.some((tag) => tag.toLowerCase() === t))))
    .filter((a) => {
      if (!needle) return true;
      const hay = [a.name, a.id, a.kind, ...a.tags].join(' ').toLowerCase();
      return needle.split(/\s+/).every((word) => hay.includes(word));
    })
    .sort((a, b) => a.bytes - b.bytes);
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
