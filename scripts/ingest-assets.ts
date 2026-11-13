/**
 * Ingest assets into the play origin.
 *
 *   npx tsx scripts/ingest-assets.ts                     # the bundled starter pack
 *   npx tsx scripts/ingest-assets.ts --dir ./kenney/ui --kind ui --licence CC0 --source Kenney
 *
 * Output: apps/play-worker/assets/<sha16>.webp plus index.json, both served
 * immutable at /a/. Re-running is a no-op unless the bytes changed.
 */
import 'dotenv/config';
import path from 'node:path';
import { ingest, ingestStarter, entriesFromDirectory } from '@playloop/assets';
import { CC0 } from '@playloop/assets';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const outDir = arg('out') ?? path.join(process.cwd(), 'apps/play-worker/assets');
  const dir = arg('dir');
  const kind = (arg('kind') ?? 'sprite') as Parameters<typeof entriesFromDirectory>[1]['kind'];
  const source = arg('source') ?? 'imported';

  const result = dir
    ? await ingest(
        await entriesFromDirectory(dir, { kind, licence: CC0, source, tags: [source.toLowerCase()] }),
        { outDir },
      )
    : await ingestStarter({ outDir });

  console.log(`\n${'id'.padEnd(20)}${'kind'.padEnd(12)}${'bytes'.padEnd(9)}${'size'.padEnd(12)}pixel art`);
  console.log('-'.repeat(78));
  for (const record of result.records) {
    const size = `${record.width ?? 0}x${record.height ?? 0}`;
    console.log(
      `${record.id.slice(0, 19).padEnd(20)}${record.kind.padEnd(12)}${String(record.bytes).padEnd(9)}${size.padEnd(12)}${record.pixelArt ? 'yes' : 'no'}`,
    );
  }
  const inlined = Math.ceil((result.totalBytes * 4) / 3);
  console.log(
    `\n${result.index.assets.length} assets · ${(result.totalBytes / 1024).toFixed(1)} KB on disk · ` +
      `+${result.written} written, ${result.skipped} already present · ` +
      `inlining the same data would cost ${(inlined / 1024).toFixed(1)} KB`,
  );
  console.log(`index: ${path.join(outDir, 'index.json')}`);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
