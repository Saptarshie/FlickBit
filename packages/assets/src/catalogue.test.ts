import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { byCategory, CATEGORIES, searchAssets, type AssetIndex, type AssetRecord } from './registry';
import { classify } from './browse';
import { writeBrowseTree } from './browse';
import { buildContactSheet } from './sheet';

const rec = (id: string, over: Partial<AssetRecord> = {}): AssetRecord => ({
  id,
  name: id.replace(/_/g, ' '),
  kind: 'sprite',
  tags: [],
  sha256: 'a'.repeat(64),
  file: `${'a'.repeat(16)}.webp`,
  bytes: 1000,
  pixelArt: true,
  runtime: ['micro', 'phaser4', 'babylon'],
  licence: { id: 'CC0-1.0', commercialUse: true, modification: true, redistribution: true, attribution: '', url: '' },
  source: 'test',
  ...over,
});

const INDEX: AssetIndex = {
  version: 1,
  assets: [
    rec('kp_char_skater_female_a', { category: '2d/characters', tags: ['character', 'player'] }),
    rec('kp_char_cyborg_male_a', { category: '2d/characters', tags: ['character', 'player'] }),
    rec('kp_tile_grass', { category: '2d/tilesets', kind: 'tileset', tags: ['tile', 'platform'] }),
    rec('kp_bg_hills', { category: '2d/environments', kind: 'background', tags: ['background', 'sky'] }),
    rec('kp_mdl_tower', { category: '3d/environments', kind: 'model', tags: ['model', '3d'] }),
    rec('hero_runner', { category: '2d/characters', tags: ['character', 'player', 'runner'] }),
  ],
};

describe('catalogue organisation', () => {
  it('has a fixed vocabulary of browse folders', () => {
    expect(CATEGORIES).toContain('2d/characters');
    expect(CATEGORIES).toContain('3d/weapons');
    expect(CATEGORIES).toContain('audio/sfx');
  });

  it('classifies by role, not by file name alone', () => {
    expect(classify({ id: 'kp_mdl_wall', name: 'wall', kind: 'model', tags: [], file: 'x.glb' })).toBe('3d/environments');
    expect(classify({ id: 'kp_mdl_reindeer', name: 'reindeer', kind: 'model', tags: [], file: 'x.glb' })).toBe('3d/characters');
    expect(classify({ id: 'kp_ui_button_blue', name: 'button blue', kind: 'ui', tags: [], file: 'x.webp' })).toBe('ui/buttons');
    expect(classify({ id: 'beep', name: 'beep', kind: 'sfx', tags: [], file: 'x.ogg' })).toBe('audio/sfx');
    // Unknown sprite still lands somewhere sensible rather than nowhere.
    expect(classify({ id: 'thing', name: 'thing', kind: 'sprite', tags: [], file: 'x.webp' })).toBe('2d/objects');
  });

  it('groups records into folders', () => {
    const groups = byCategory(INDEX);
    expect(groups.get('2d/characters')).toHaveLength(3);
    expect(groups.get('3d/environments')).toHaveLength(1);
  });
});

describe('asset search returns a ranked top-k', () => {
  it('ranks the asset that matches the words first', () => {
    const hits = searchAssets(INDEX, { text: 'skater', limit: 2 });
    expect(hits[0]?.id).toBe('kp_char_skater_female_a');
  });

  it('prefers records that match every word, and only widens when nothing does', () => {
    // "skater player" strictly matches one record; it must not return the cyborg.
    expect(searchAssets(INDEX, { text: 'skater player' }).map((a) => a.id)).toEqual(['kp_char_skater_female_a']);
    // "grass hills" matches nothing together, so partial matches are allowed.
    expect(searchAssets(INDEX, { text: 'grass hills' }).length).toBeGreaterThan(0);
  });

  it('returns more than one result by default instead of a single best guess', () => {
    const hits = searchAssets(INDEX, { text: 'player' });
    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0]?.id).not.toBe(hits[1]?.id);
  });

  it('filters by category', () => {
    const hits = searchAssets(INDEX, { category: '3d/environments' });
    expect(hits.map((h) => h.id)).toEqual(['kp_mdl_tower']);
  });

  it('returns nothing rather than everything when the words do not match', () => {
    expect(searchAssets(INDEX, { text: 'submarine' })).toEqual([]);
  });

  it('never offers an asset that forbids commercial use', () => {
    const restricted: AssetIndex = {
      version: 1,
      assets: [rec('nc_art', { licence: { ...rec('x').licence, commercialUse: false } })],
    };
    expect(searchAssets(restricted, { text: 'art' })).toEqual([]);
  });
});

describe('browse tree and contact sheets', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pl-browse-'));
    await mkdir(path.join(dir, 'tree'), { recursive: true });
    const img = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ff3355' } }).png().toBuffer();
    await writeFile(path.join(dir, `${'a'.repeat(16)}.webp`), await sharp(img).webp().toBuffer());
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mirrors the flat store into category folders', async () => {
    const index: AssetIndex = { version: 1, assets: [rec('hero', { category: '2d/characters', file: `${'a'.repeat(16)}.webp` })] };
    const result = await writeBrowseTree(index, dir);
    expect(result.files).toBe(1);
    expect(await readdir(path.join(dir, 'tree', '2d', 'characters'))).toEqual(['hero.webp']);
  });

  it('renders a numbered contact sheet the model can look at', async () => {
    const index: AssetIndex = { version: 1, assets: [rec('hero', { category: '2d/characters', file: `${'a'.repeat(16)}.webp` })] };
    const sheet = await buildContactSheet(index.assets, dir);
    const meta = await sharp(sheet.data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(4 * 132);
    expect(sheet.entries).toEqual([{ index: 1, id: 'hero', file: `${'a'.repeat(16)}.webp`, category: '2d/characters' }]);
  });
});
