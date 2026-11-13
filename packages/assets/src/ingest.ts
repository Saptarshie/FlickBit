/**
 * Ingest: raw file -> optimised, content-addressed, licence-tagged asset.
 *
 * Idempotent by construction: the output file name is the hash of the optimised
 * bytes, so re-running over an unchanged source writes nothing and a changed
 * source writes a new file instead of overwriting a cached one.
 */
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { optimizeImage } from './optimize';
import { CC0, parseIndex, type AssetIndex, type AssetKind, type AssetRecord, type Licence } from './registry';
import { renderStarter, starterPack } from './starter';

export type IngestEntry = {
  id: string;
  name: string;
  kind: AssetKind;
  tags: string[];
  buffer: Buffer;
  licence?: Licence;
  source?: string;
  sourceUrl?: string;
};

export type IngestResult = {
  index: AssetIndex;
  written: number;
  skipped: number;
  totalBytes: number;
  records: AssetRecord[];
};

async function readIndexFile(indexPath: string): Promise<AssetIndex> {
  if (!existsSync(indexPath)) return { version: 1, assets: [] };
  try {
    return parseIndex(JSON.parse(await readFile(indexPath, 'utf8')));
  } catch {
    return { version: 1, assets: [] };
  }
}

export async function ingest(
  entries: IngestEntry[],
  options: { outDir: string; indexFile?: string },
): Promise<IngestResult> {
  const outDir = options.outDir;
  const indexFile = options.indexFile ?? path.join(outDir, 'index.json');
  await mkdir(outDir, { recursive: true });

  const existing = await readIndexFile(indexFile);
  const byId = new Map(existing.assets.map((a) => [a.id, a]));
  const records: AssetRecord[] = [];
  let written = 0;
  let skipped = 0;

  for (const entry of entries) {
    const optimised = await optimizeImage(entry.buffer, { kind: entry.kind });
    const target = path.join(outDir, optimised.file);
    const already = byId.get(entry.id);

    if (!existsSync(target)) {
      await writeFile(target, optimised.data);
      written += 1;
    } else {
      skipped += 1;
    }

    const record: AssetRecord = {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      tags: entry.tags,
      sha256: optimised.sha256,
      file: optimised.file,
      bytes: optimised.bytes,
      ...(optimised.width ? { width: optimised.width } : {}),
      ...(optimised.height ? { height: optimised.height } : {}),
      pixelArt: optimised.pixelArt,
      runtime: ['micro', 'phaser4', 'babylon'],
      licence: entry.licence ?? CC0,
      source: entry.source ?? 'starter',
      ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
    };
    records.push(record);
    byId.set(record.id, record);
    // Keep the old record's identity stable in the log; the hash is what matters.
    void already;
  }

  const assets = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const index: AssetIndex = { version: 1, assets };
  await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);

  return {
    index,
    written,
    skipped,
    totalBytes: assets.reduce((sum, a) => sum + a.bytes, 0),
    records,
  };
}

/** The bundled starter pack — the vocabulary every new install begins with. */
export async function ingestStarter(options: { outDir: string }): Promise<IngestResult> {
  const entries: IngestEntry[] = [];
  for (const item of starterPack()) {
    entries.push({
      id: item.id,
      name: item.name,
      kind: item.kind,
      tags: item.tags,
      buffer: await renderStarter(item),
      source: 'flickbit-starter',
      licence: CC0,
    });
  }
  return ingest(entries, options);
}

/** Walk a directory of files (a Kenney pack, creator uploads) into ingest entries. */
export async function entriesFromDirectory(
  dir: string,
  options: { kind: AssetKind; licence: Licence; source: string; tags?: string[] },
): Promise<IngestEntry[]> {
  const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp|svg)$/i.test(f));
  const entries: IngestEntry[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const info = await stat(full);
    if (!info.isFile()) continue;
    const id = file.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    entries.push({
      id,
      name: id.replace(/_/g, ' '),
      kind: options.kind,
      tags: [...(options.tags ?? []), 'imported'],
      buffer: await readFile(full),
      licence: options.licence,
      source: options.source,
    });
  }
  return entries;
}
