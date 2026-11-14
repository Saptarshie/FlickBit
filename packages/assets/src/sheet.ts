/**
 * Contact sheets: let the model *look* at the catalogue instead of reading names.
 *
 * "kp_char_skater_female_a" is a string. Sixteen of them in one image is a
 * decision a multimodal reviewer can actually make — which one is the player, does
 * this background match that sprite, is this set consistent. Text descriptions of
 * art are guesses; a thumbnails grid is evidence.
 *
 * Layout: 4 columns, numbered cells with a caption strip, ≤16 per sheet. The
 * numbers are what the prompt refers to ("asset 7"), so the model never has to
 * transcribe a 16-character hash.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';
import type { AssetRecord } from './registry';

export const SHEET_COLS = 4;
export const SHEET_MAX = 16;
const CELL = 132;
const PAD = 10;
const CAPTION = 18;

export type SheetEntry = { index: number; id: string; file: string; category?: string };

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function caption(index: number, label: string): Buffer {
  const text = `${index}. ${label}`.slice(0, 22);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL - PAD}" height="${CAPTION}">
    <text x="2" y="13" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="#e8e8ef">${esc(text)}</text>
  </svg>`;
  return Buffer.from(svg);
}

/**
 * Render ≤16 assets into one image. Anything unreadable is skipped rather than
 * failing the whole sheet — a catalogue with one corrupt file should still be
 * browsable.
 */
export async function buildContactSheet(
  assets: AssetRecord[],
  assetsDir: string,
): Promise<{ data: Buffer; entries: SheetEntry[]; skipped: string[] }> {
  const picked = assets.slice(0, SHEET_MAX);
  const rows = Math.max(1, Math.ceil(picked.length / SHEET_COLS));
  const composites: OverlayOptions[] = [];
  const entries: SheetEntry[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < picked.length; i += 1) {
    const asset = picked[i]!;
    try {
      const src = await readFile(path.join(assetsDir, asset.file));
      const thumb = await sharp(src)
        .resize(CELL - PAD * 2, CELL - PAD * 2 - CAPTION, {
          fit: 'inside',
          kernel: asset.pixelArt ? sharp.kernel.nearest : sharp.kernel.lanczos3,
          // A 16x16 sprite rendered at native size in a 132px cell is a dot on a
          // black square: the reviewer cannot judge it. Fill the cell instead.
          withoutEnlargement: false,
        })
        .png()
        .toBuffer();
      const col = i % SHEET_COLS;
      const row = Math.floor(i / SHEET_COLS);
      composites.push({ input: thumb, left: col * CELL + PAD, top: row * CELL + PAD });
      composites.push({ input: caption(i + 1, asset.id), left: col * CELL + PAD, top: row * CELL + CELL - CAPTION - 2 });
      entries.push({ index: i + 1, id: asset.id, file: asset.file, category: asset.category });
    } catch {
      skipped.push(asset.id);
    }
  }

  const data = await sharp({
    create: {
      width: SHEET_COLS * CELL,
      height: rows * CELL,
      channels: 4,
      background: { r: 16, g: 16, b: 20, alpha: 1 },
    },
  })
    .composite(composites)
    .webp({ quality: 88 })
    .toBuffer();

  return { data, entries, skipped };
}

/** One sheet per category, written as `sheet-<a>-<b>.webp` next to the index. */
export async function buildCategorySheets(
  assets: AssetRecord[],
  assetsDir: string,
  outDir: string,
): Promise<Array<{ category: string; file: string; entries: SheetEntry[] }>> {
  const groups = new Map<string, AssetRecord[]>();
  for (const a of assets) {
    const key = a.category ?? 'uncategorised';
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }

  await mkdir(outDir, { recursive: true });
  const out: Array<{ category: string; file: string; entries: SheetEntry[] }> = [];
  for (const [category, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.every((a) => a.kind === 'sfx' || a.kind === 'music' || a.kind === 'model')) continue;
    const sheet = await buildContactSheet(list, assetsDir);
    const file = `sheet-${category.replace(/\//g, '-')}.webp`;
    await writeFile(path.join(outDir, file), sheet.data);
    out.push({ category, file, entries: sheet.entries });
  }
  return out;
}
