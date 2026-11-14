/**
 * Audit the model catalogue for self-containment.
 *
 * A .glb is one file only if its textures and buffers are embedded. Several Kenney
 * kits reference `Textures/colormap.png` from inside the model, which makes the
 * loader request `/a/Textures/colormap.png` — a path the platform never publishes.
 * The result is a model that loads in Blender and 404s in the frame.
 *
 * This flags every model with an external uri so the shortlist can skip it, instead
 * of discovering it during a playtest 20 minutes into a generation.
 *
 *   npx tsx scripts/audit-models.ts            # report
 *   npx tsx scripts/audit-models.ts --write    # write selfContained into index.json
 */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ASSETS = path.resolve(process.cwd(), 'apps/play-worker/assets');
const INDEX = path.join(ASSETS, 'index.json');

/** Parse the JSON chunk of a GLB and report any uri that is not a data: URL. */
function externalRefs(bytes: Buffer): string[] {
  if (bytes.subarray(0, 4).toString('latin1') !== 'glTF') return ['(not a glb)'];
  const jsonLength = bytes.readUInt32LE(12);
  const chunkType = bytes.subarray(16, 20).toString('latin1');
  if (chunkType !== 'JSON') return ['(no json chunk)'];
  let gltf: { images?: Array<{ uri?: string }>; buffers?: Array<{ uri?: string }> };
  try {
    gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  } catch {
    return ['(unreadable json)'];
  }
  const uris = [...(gltf.images ?? []), ...(gltf.buffers ?? [])]
    .map((entry) => entry.uri)
    .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0 && !uri.startsWith('data:'));
  return [...new Set(uris)];
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const index = JSON.parse(await readFile(INDEX, 'utf8')) as {
    version: 1;
    assets: Array<Record<string, unknown>>;
  };

  let checked = 0;
  let clean = 0;
  const dirty: Array<{ id: string; refs: string[] }> = [];

  for (const asset of index.assets) {
    if (asset['kind'] !== 'model' || typeof asset['file'] !== 'string') continue;
    checked += 1;
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(ASSETS, asset['file']));
    } catch {
      dirty.push({ id: String(asset['id']), refs: ['(file missing)'] });
      continue;
    }
    const refs = externalRefs(bytes);
    if (refs.length === 0) {
      clean += 1;
      asset['selfContained'] = true;
    } else {
      asset['selfContained'] = false;
      dirty.push({ id: String(asset['id']), refs });
    }
  }

  console.log(`models checked: ${checked} · self-contained: ${clean} · needs external files: ${dirty.length}`);
  const kinds = new Map<string, number>();
  for (const entry of dirty) {
    const key = entry.refs[0] ?? '?';
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  for (const [ref, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  ${String(count).padStart(4)} × ${ref}`);
  }

  if (write) {
    await writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    console.log('index.json updated with selfContained');
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
