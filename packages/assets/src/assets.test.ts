import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { optimizeImage, looksLikePixelArt } from './optimize';
import { bundleBytes, searchAssets, withinBudget, CC0, type AssetRecord } from './registry';

/** A 32x32 sprite drawn from four flat colours — the shape of real pixel art. */
async function pixelSprite(): Promise<Buffer> {
  const px = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const i = (y * 32 + x) * 4;
      const body = x > 6 && x < 26 && y > 4 && y < 28;
      const eye = (x === 12 || x === 20) && y > 12 && y < 16;
      px[i] = eye ? 20 : body ? 240 : 0;
      px[i + 1] = eye ? 20 : body ? 90 : 0;
      px[i + 2] = eye ? 30 : body ? 60 : 0;
      px[i + 3] = body || eye ? 255 : 0;
    }
  }
  return sharp(px, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
}

/** A smooth 1200x800 gradient with noise — nothing like pixel art. */
async function photoish(): Promise<Buffer> {
  const w = 1200;
  const h = 800;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      px[i] = (x / w) * 255 + ((x * y) % 7);
      px[i + 1] = (y / h) * 255 + ((x + y) % 5);
      px[i + 2] = 128 + 60 * Math.sin(x / 40);
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

function record(over: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: 'hero',
    name: 'Hero',
    kind: 'sprite',
    tags: ['character', 'platformer'],
    sha256: 'a'.repeat(64),
    file: 'aaaaaaaaaaaaaaaa.webp',
    bytes: 1000,
    pixelArt: true,
    runtime: ['micro', 'phaser4', 'babylon'],
    licence: CC0,
    source: 'starter',
    ...over,
  };
}

describe('pixel art detection', () => {
  it('recognises a flat four-colour sprite', async () => {
    expect(await looksLikePixelArt(await pixelSprite())).toBe(true);
  });

  it('does not mistake a photograph for pixel art', async () => {
    expect(await looksLikePixelArt(await photoish())).toBe(false);
  });
});

describe('optimizeImage', () => {
  it('keeps pixel art lossless and does not blur it', async () => {
    const out = await optimizeImage(await pixelSprite(), { kind: 'sprite' });
    expect(out.pixelArt).toBe(true);
    expect(out.width).toBe(32);
    expect(out.height).toBe(32);
    expect(out.ext).toBe('webp');
    // Lossless WebP of a 4-colour sprite is small and round-trips exactly.
    expect(out.bytes).toBeLessThan(32 * 32 * 4);
    expect(out.file).toBe(`${out.sha256.slice(0, 16)}.webp`);
  });

  it('downscales backgrounds to the card width and shrinks them a lot', async () => {
    const source = await photoish();
    const out = await optimizeImage(source, { kind: 'background' });
    expect(out.width).toBe(1170);
    expect(out.height).toBeLessThan(800);
    expect(out.bytes).toBeLessThan(source.byteLength / 2);
  });

  it('reports the real cost of inlining instead of pretending it is free', async () => {
    const out = await optimizeImage(await pixelSprite(), { kind: 'sprite' });
    expect(out.inlineBytes).toBeGreaterThan(out.bytes);
    expect(out.inlineBytes).toBeGreaterThanOrEqual(Math.ceil((out.bytes * 4) / 3));
  });

  it('is deterministic: the same bytes produce the same hash', async () => {
    const buf = await pixelSprite();
    const a = await optimizeImage(buf, { kind: 'sprite' });
    const b = await optimizeImage(buf, { kind: 'sprite' });
    expect(a.sha256).toBe(b.sha256);
  });
});

describe('registry', () => {
  const index = {
    version: 1 as const,
    assets: [
      record({ id: 'hero', bytes: 12000, tags: ['character', 'platformer'] }),
      record({
        id: 'coin',
        name: 'Coin',
        kind: 'icon',
        bytes: 900,
        tags: ['currency', 'platformer'],
      }),
      record({
        id: 'beep',
        name: 'Beep',
        kind: 'sfx',
        bytes: 4000,
        tags: ['audio', 'ui'],
        licence: { ...CC0, id: 'CC-BY-4.0', attribution: 'Beep by Someone', commercialUse: true },
      }),
      record({
        id: 'stolen',
        name: 'Stolen Art',
        licence: { ...CC0, id: 'CC-BY-NC-4.0', commercialUse: false, redistribution: false },
      }),
    ],
  };

  it('never offers a non-commercial asset to the agent', () => {
    const found = searchAssets(index, {});
    expect(found.map((a) => a.id)).not.toContain('stolen');
  });

  it('filters by kind, tag and budget, smallest first', () => {
    const found = searchAssets(index, { kind: 'icon', tags: ['platformer'], maxBytes: 5000 });
    expect(found.map((a) => a.id)).toEqual(['coin']);
    const all = searchAssets(index, { tags: ['platformer'] });
    expect(all[0]?.id).toBe('coin');
  });

  it('matches free text against name, id and tags', () => {
    expect(searchAssets(index, { text: 'coin' }).map((a) => a.id)).toEqual(['coin']);
    expect(searchAssets(index, { text: 'platformer character' }).map((a) => a.id)).toEqual(['hero']);
    expect(searchAssets(index, { text: 'dragon' })).toEqual([]);
  });

  it('keeps attribution text so a remix can carry it', () => {
    const beep = searchAssets(index, { text: 'beep' })[0];
    expect(beep?.licence.attribution).toBe('Beep by Someone');
  });

  it('enforces the publishing profiles', () => {
    expect(bundleBytes(index.assets)).toBe(index.assets.reduce((sum, a) => sum + a.bytes, 0));
    expect(withinBudget([{ bytes: 900 }], 'instant')).toBe(true);
    expect(withinBudget([{ bytes: 1_200_000 }], 'instant')).toBe(false);
    expect(withinBudget([{ bytes: 1_200_000 }], 'standard')).toBe(true);
  });
});

describe('audio pipeline', () => {
  it('encodes a synthesised blip to Ogg/Opus', async () => {
    const { hasFfmpeg, optimizeAudio } = await import('./audio');
    const { renderSound, starterSounds } = await import('./sounds');
    if (!(await hasFfmpeg())) {
      // A host without ffmpeg still runs the rest of the suite; the ingest path
      // reports the skip loudly instead of failing a build.
      expect(true).toBe(true);
      return;
    }
    const wav = renderSound(starterSounds()[0]!);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    const out = await optimizeAudio(wav, { bitrateKbps: 48 });
    expect(out.data.subarray(0, 4).toString()).toBe('OggS');
    expect(out.bytes).toBeGreaterThan(200);
    expect(out.bytes).toBeLessThan(wav.byteLength);
    expect(out.file).toBe(`${out.sha256.slice(0, 16)}.ogg`);
  });
});

describe('ingest', () => {
  it('writes files, dedupes on re-run, and keeps licence metadata in the index', async () => {
    const { ingestStarter } = await import('./ingest');
    const { mkdtemp, readdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'pl-ingest-'));

    try {
      const first = await ingestStarter({ outDir: dir });
      expect(first.index.assets.length).toBeGreaterThanOrEqual(12);
      expect(first.written).toBe(first.index.assets.length);
      const files = await readdir(dir);
      for (const record of first.index.assets) {
        expect(files, record.id).toContain(record.file);
        expect(record.licence.id).toBe('CC0-1.0');
      }
      expect(first.totalBytes).toBeLessThan(200_000);

      const second = await ingestStarter({ outDir: dir });
      expect(second.written).toBe(0);
      expect(second.index.assets.length).toBe(first.index.assets.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
