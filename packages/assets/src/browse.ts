/**
 * Browse structure for a content-addressed store.
 *
 * Delivery wants flat hash names (`a83f9c....webp`) because the URL must never
 * change. Retrieval wants folders a human browses and a model can be told about
 * (`2d/characters`, `3d/environments`). Both are served by the same bytes: the
 * flat store is the truth, and `<assets>/tree/<category>/<id>.<ext>` is a hardlink
 * mirror of it. Hardlinks cost no extra disk and cannot go stale.
 */
import { copyFile, link, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AssetCategory, AssetIndex, AssetRecord } from './registry';

type Rule = { match: RegExp; category: AssetCategory };

/**
 * Folder and file-name heuristics. Deliberately short and legible: a wrong
 * category is a browse inconvenience, not a broken game, so a missed rule falls
 * back to the asset's kind rather than guessing something exotic.
 */
const RULES: Rule[] = [
  { match: /\b(enem|monster|zombie|slime|bat|ghost|spike)\b/i, category: '2d/enemies' },
  { match: /\b(char|character|player|hero|skin|skater|cyborg|criminal|protagonist|reindeer|gingerbread|snowman|nutcracker)\b/i, category: '2d/characters' },
  { match: /\b(tile|tileset|platform|block|brick|ground)\b/i, category: '2d/tilesets' },
  { match: /\b(background|bg|sky|backdrop|hills)\b/i, category: '2d/environments' },
  { match: /\b(button|btn|press)\b/i, category: 'ui/buttons' },
  { match: /\b(panel|window|popup|frame|dialog)\b/i, category: 'ui/panels' },
  { match: /\b(icon|star|heart|coin|gem|badge)\b/i, category: 'ui/icons' },
  { match: /\b(hud|bar|meter|gauge)\b/i, category: 'ui/hud' },
];

/** Model-specific folders, which are about the scene role rather than the drawing. */
const MODEL_RULES: Rule[] = [
  { match: /\b(char|character|player|hero|skin|reindeer|gingerbread|snowman|nutcracker|skater|cyborg)\b/i, category: '3d/characters' },
  { match: /\b(car|vehicle|truck|train|boat|sled|plane)\b/i, category: '3d/vehicles' },
  { match: /\b(sword|axe|spear|weapon|bow|cannon|catapult|ballista|ram|trebuchet|siege)\b/i, category: '3d/weapons' },
  { match: /\b(wall|tower|floor|ground|rocks|bridge|gate|stairs|cabin|tree|fence|door|candy|lamp)\b/i, category: '3d/environments' },
];

export function classify(record: Pick<AssetRecord, 'id' | 'name' | 'kind' | 'tags' | 'file'>, sourcePath = ''): AssetCategory {
  const hay = [record.id, record.name, sourcePath, ...record.tags].join(' ').toLowerCase();

  if (record.kind === 'model' || /\.glb$/.test(record.file)) {
    for (const rule of MODEL_RULES) if (rule.match.test(hay)) return rule.category;
    return '3d/props';
  }
  if (record.kind === 'sfx') return 'audio/sfx';
  if (record.kind === 'music') return 'audio/music';

  for (const rule of RULES) if (rule.match.test(hay)) return rule.category;

  switch (record.kind) {
    case 'background':
      return '2d/environments';
    case 'tileset':
      return '2d/tilesets';
    case 'ui':
      return 'ui/panels';
    case 'icon':
      return 'ui/icons';
    default:
      return '2d/objects';
  }
}

/**
 * Mirror the index into `<dir>/tree/<category>/<id>.<ext>`.
 *
 * Hardlink first (same bytes, two names, zero extra disk), copy as the fallback
 * for filesystems that refuse links. Stale links are removed so the tree always
 * describes the current index.
 */
export async function writeBrowseTree(index: AssetIndex, dir: string): Promise<{ dirs: number; files: number }> {
  const root = path.join(dir, 'tree');
  await rm(root, { recursive: true, force: true });

  const wanted = new Map<string, Set<string>>();
  for (const asset of index.assets) {
    if (!asset.category) continue;
    const names = wanted.get(asset.category) ?? new Set<string>();
    names.add(`${asset.id}${path.extname(asset.file)}`);
    wanted.set(asset.category, names);
  }

  let files = 0;
  for (const [category, names] of wanted) {
    const target = path.join(root, category);
    await mkdir(target, { recursive: true });
    for (const name of names) {
      const asset = index.assets.find((a) => `${a.id}${path.extname(a.file)}` === name && a.category === category);
      if (!asset) continue;
      const from = path.join(dir, asset.file);
      const to = path.join(target, name);
      try {
        await link(from, to);
      } catch {
        await copyFile(from, to);
      }
      files += 1;
    }
  }
  return { dirs: wanted.size, files };
}

/** Every file in the flat store, for the tree's sibling listing. */
export async function storeFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => /^[0-9a-f]{16}\./.test(f));
}
