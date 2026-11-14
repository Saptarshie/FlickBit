/**
 * The compressor. Deterministic, inspectable, and boring on purpose.
 *
 * What we refuse to invent: our own codec. sharp (libvips) already does WebP,
 * palette reduction and Lanczos; the only opinions this module adds are the
 * ones that change the result on a phone screen — downscale to the rendered
 * size, keep pixel art crisp, and never trust a "quality" number without
 * measuring the bytes it produced.
 */
import sharp from 'sharp';
import { assetFileName, sha256, type AssetKind } from './registry';

export type OptimizeOptions = {
  kind: AssetKind;
  /** Longest side, in pixels. The card is 390x844 at up to 3x dpr; a sprite is never bigger. */
  maxSide?: number;
  /** Override the pixel-art detection (the ingest sidecar knows when it is sure). */
  pixelArt?: boolean;
  /** WebP quality for non-pixel art. */
  quality?: number;
};

export type OptimizedImage = {
  data: Buffer;
  ext: 'webp' | 'png';
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  file: string;
  pixelArt: boolean;
  /** What this costs if it were inlined as a data URL instead (+33% and no caching). */
  inlineBytes: number;
};

const DEFAULTS: Record<AssetKind, { maxSide: number; quality: number }> = {
  sprite: { maxSide: 512, quality: 88 },
  tileset: { maxSide: 1024, quality: 88 },
  background: { maxSide: 1170, quality: 76 },
  ui: { maxSide: 512, quality: 90 },
  icon: { maxSide: 256, quality: 90 },
  sfx: { maxSide: 0, quality: 0 },
  music: { maxSide: 0, quality: 0 },
};

/**
 * Pixel art has few colours and hard edges; lossy WebP turns those edges into
 * mush. The test is the actual number of distinct colours in a downscaled copy,
 * which is cheap and does not depend on the file name.
 */
export async function distinctColours(input: Buffer): Promise<number> {
  const { data, info } = await sharp(input)
    .resize({ width: 64, height: 64, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const seen = new Set<number>();
  for (let i = 0; i < data.length; i += info.channels) {
    const key = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    seen.add(key);
    if (seen.size > 256) return seen.size;
  }
  return seen.size;
}

/**
 * Pixel art is few colours AND small. A 512px UI panel of flat vector shapes has
 * few colours but is not pixel art, and treating it as such forces a lossless
 * encode that costs twice the bytes for no visible benefit.
 */
export async function looksLikePixelArt(input: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(input).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (longest > 256) return false;
    return (await distinctColours(input)) <= 64;
  } catch {
    return false;
  }
}

export async function optimizeImage(input: Buffer, options: OptimizeOptions): Promise<OptimizedImage> {
  const kind = options.kind;
  const preset = DEFAULTS[kind];
  const pixelArt = options.pixelArt ?? (await looksLikePixelArt(input));
  const quality = options.quality ?? preset.quality;
  const maxSide = options.maxSide ?? preset.maxSide;

  let pipeline = sharp(input, { failOn: 'error', limitInputPixels: 80_000_000 }).rotate();
  const meta = await pipeline.metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (maxSide > 0 && longest > maxSide) {
    pipeline = pipeline.resize({
      width: maxSide,
      height: maxSide,
      fit: 'inside',
      withoutEnlargement: true,
      // Nearest keeps pixel art's hard edges; Lanczos is correct for everything else.
      kernel: pixelArt ? sharp.kernel.nearest : sharp.kernel.lanczos3,
    });
  }

  // Encode and compare, do not guess.
  //
  // Kenney's pixel art is already palette-optimised PNG: lossless WebP of a
  // 16x16 sprite is frequently *larger* than the source (measured: 55 KB of PNG
  // became 89 KB). So every asset gets both candidates and the smaller one wins.
  // Encoders are independent: run them together, the slowest one sets the cost.
  const jobs: Array<Promise<{ data: Buffer; ext: 'webp' | 'png' }>> = [
    // sharp pipelines are single-use: each candidate needs its own clone, or the
    // second encoder silently reuses the first one's output.
    pipeline
      .clone()
      .webp({ lossless: true, effort: 5 })
      .toBuffer()
      .then((data) => ({ data, ext: 'webp' as const })),
  ];
  // Palette PNG is the reference encoder for pixel art (Kenney ships it and it is
  // very good at 16x16 with 16 colours).
  if (pixelArt) {
    jobs.push(
      sharp(input)
        .png({ palette: true, colours: 64, compressionLevel: 9, effort: 7 })
        .toBuffer()
        .then((data) => ({ data, ext: 'png' as const })),
    );
  }
  // Lossy WebP is always a candidate: a "background" that happens to have few
  // colours still compresses far better lossily, and a photo has no business
  // being stored losslessly.
  jobs.push(
    pipeline
      .clone()
      .webp({ quality, alphaQuality: quality + 8, effort: 5 })
      .toBuffer()
      .then((data) => ({ data, ext: 'webp' as const })),
  );

  const results = await Promise.all(jobs);
  const smallest = (list: typeof results) => list.reduce((a, b) => (b.data.byteLength < a.data.byteLength ? b : a));

  // Quality policy, not just size:
  //  - pixel art: lossless wins unless lossy is drastically smaller (<60%). A
  //    few hundred bytes is not worth smearing sprite edges at 4x scale.
  //  - everything else: smallest wins, because lossy WebP at q82-90 is the
  //    correct format for illustrations and backgrounds.
  const lossless = results.filter((r) => r.ext === 'png' || r.data.subarray(0, 4).toString('latin1') !== 'RIFF');
  const lossy = results.filter((r) => !lossless.includes(r));
  const best = pixelArt
    ? (() => {
        const safe = smallest(lossless.length > 0 ? lossless : results);
        const risky = lossy.length > 0 ? smallest(lossy) : null;
        return risky && risky.data.byteLength < safe.data.byteLength * 0.6 ? risky : safe;
      })()
    : smallest(results);
  const data = best.data;
  const out = await sharp(data).metadata();
  const sha = sha256(data);
  const ext = best.ext;
  return {
    data,
    ext,
    width: out.width ?? 0,
    height: out.height ?? 0,
    bytes: data.byteLength,
    sha256: sha,
    file: assetFileName(sha, ext),
    pixelArt,
    // base64 inflates by 4/3 and cannot be cached across games.
    inlineBytes: Math.ceil((data.byteLength * 4) / 3) + 32,
  };
}
