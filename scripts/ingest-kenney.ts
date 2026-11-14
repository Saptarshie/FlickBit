/**
 * Import a Kenney pack into the catalogue.
 *
 * Kenney's zips are organised by folder, and the files are named `tile_0042.png`
 * — useful to a human browsing a folder, useless to a model. This maps folders to
 * ids and tags, keeps the licence record honest (CC0, no attribution required but
 * credited anyway), and lets the optimiser decide pixel-art vs photo.
 *
 *   npx tsx scripts/fetch-kenney.ts pixel-platformer
 *   npx tsx scripts/ingest-kenney.ts pixel-platformer
 *   npx tsx scripts/ingest-kenney.ts ui-pack --kind ui
 */
import 'dotenv/config';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ingest, CC0, type IngestEntry, type AssetKind } from '@playloop/assets';

const OUT = path.resolve(process.cwd(), 'apps/play-worker/assets');

type Rule = { match: RegExp; kind: AssetKind; tags: string[]; prefix: string };

/** Folder → what it is. Order matters: the first match wins. */
const RULES: Rule[] = [
  { match: /characters?/i, kind: 'sprite', tags: ['character', 'player', 'enemy', 'platformer', 'pixel'], prefix: 'kp_char' },
  { match: /backgrounds?/i, kind: 'background', tags: ['background', 'sky', 'scenery', 'pixel'], prefix: 'kp_bg' },
  { match: /tiles|tilemap/i, kind: 'tileset', tags: ['tile', 'level', 'platform', 'platformer', 'pixel'], prefix: 'kp_tile' },
  { match: /ui|gui|buttons?|icons?/i, kind: 'ui', tags: ['ui', 'button', 'panel', 'hud'], prefix: 'kp_ui' },
  { match: /glb format/i, kind: 'model', tags: ['model', '3d', 'prop', 'lowpoly'], prefix: 'kp_mdl' },
];
const DEFAULT_RULE: Rule = { match: /./, kind: 'sprite', tags: ['sprite', 'kenney'], prefix: 'kp' };

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(png|glb)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const pack = args[0];
  if (!pack) {
    console.error('usage: npx tsx scripts/ingest-kenney.ts <pack-dir-name> [--max 120]');
    process.exitCode = 1;
    return;
  }
  const maxIndex = process.argv.indexOf('--max');
  const max = maxIndex > 0 ? Number(process.argv[maxIndex + 1]) : Number.POSITIVE_INFINITY;

  const packDir = path.resolve('.artifacts/kenney', pack);
  const licenseFile = path.join(packDir, 'License.txt');
  const license = await readFile(licenseFile, 'utf8').catch(() => '');
  const isCC0 = /CC0|Creative Commons Zero/i.test(license);
  if (!isCC0) {
    // A pack with an unclear or restricted licence is not imported silently.
    console.error(`[kenney] ${pack}: licence is not clearly CC0 — refusing to import`);
    process.exitCode = 1;
    return;
  }

  const files = (await walk(packDir)).filter((f) => !/preview|sample/i.test(path.basename(f)));
  const entries: IngestEntry[] = [];
  const seen = new Map<string, number>();

  for (const file of files.slice(0, max)) {
    const rel = path.relative(packDir, file);
    const rule = RULES.find((r) => r.match.test(rel)) ?? DEFAULT_RULE;
    const info = await stat(file);
    if (info.size === 0) continue;
    const base = path.basename(file).replace(/\.(png|glb)$/i, '');
    const stem = base.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const id = `${rule.prefix}_${stem}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);

    entries.push({
      id: n === 1 ? id : `${id}_${n}`,
      name: `${rule.tags[0]} ${base}`,
      kind: rule.kind,
      tags: [...rule.tags, 'kenney', pack],
      buffer: await readFile(file),
      licence: { ...CC0, attribution: 'Kenney (www.kenney.nl) — CC0, attribution appreciated' },
      source: `Kenney · ${pack}`,
      sourceUrl: `https://kenney.nl/assets/${pack}`,
    });
  }

  const result = await ingest(entries, { outDir: OUT, prune: true });
  const added = result.records.reduce((sum, r) => sum + r.bytes, 0);
  console.log(
    `${pack}: ${entries.length} files → ${result.written} new, ${result.skipped} already present · ` +
      `${(added / 1024).toFixed(1)} KB this batch · catalogue now ${result.index.assets.length} assets / ` +
      `${(result.totalBytes / 1024).toFixed(1)} KB`,
  );
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
