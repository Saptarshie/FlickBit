#!/usr/bin/env node
/**
 * Publish a pinned engine into apps/play-worker/runtimes/.
 *
 *   node scripts/install-runtime.mjs phaser4
 *   node scripts/install-runtime.mjs            # every pinned engine that is installed
 *
 * The engine comes from node_modules — never from a URL. That keeps the supply
 * chain the same one `pnpm-lock.yaml` already guarantees: nothing reaches the
 * play origin that the lockfile did not pin.
 *
 * The output name is `<id>@<version>-<sha384[0:16]>.js`, which is exactly what
 * the worker's `/r/:file` route validates and what an artifact's manifest pins.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'apps', 'play-worker', 'runtimes');

/** id → { pkg, dist } */
const ENGINES = {
  phaser4: { pkg: 'phaser', dist: 'dist/phaser.min.js' },
  // Babylon: the UMD build is 8.7 MB; a tree-shaken bundle built from
  // @babylonjs/core is the only sane input. Left unset until that build exists.
  babylon: { pkg: '@babylonjs/core', dist: null },
};

function fail(message) {
  console.error(`[runtime] ${message}`);
  process.exitCode = 1;
}

function version(pkg) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

mkdirSync(outDir, { recursive: true });

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = wanted.length > 0 ? wanted : Object.keys(ENGINES);

let installed = 0;
for (const id of ids) {
  const spec = ENGINES[id];
  if (!spec) {
    fail(`unknown engine "${id}" (known: ${Object.keys(ENGINES).join(', ')})`);
    continue;
  }
  if (!spec.dist) {
    fail(`${id}: no dist configured — build a tree-shaken bundle first`);
    continue;
  }
  const pkgDir = path.join(root, 'node_modules', spec.pkg);
  const pinned = version(spec.pkg);
  if (pinned === null) {
    fail(`${id}: ${spec.pkg} is not installed (run \`pnpm add -w ${spec.pkg}\` first)`);
    continue;
  }
  const src = path.join(pkgDir, spec.dist);
  if (!existsSync(src)) {
    fail(`${id}: ${spec.dist} not found in ${spec.pkg}@${pinned}`);
    continue;
  }

  const bytes = readFileSync(src);
  const hex = createHash('sha384').update(bytes).digest('hex');
  const file = `${id}@${pinned}-${hex.slice(0, 16)}.js`;
  writeFileSync(path.join(outDir, file), bytes);

  const gz = (await import('node:zlib')).gzipSync(bytes, { level: 9 }).byteLength;
  console.log(
    `[runtime] ${id}@${pinned} → runtimes/${file}  (${(bytes.byteLength / 1024).toFixed(0)} KB, ${(gz / 1024).toFixed(0)} KB gzip)`,
  );
  console.log(`[runtime]   pin in a manifest:  "runtime": "${id}", "runtimeVersion": "${pinned}"`);
  installed += 1;
}

if (installed === 0 && !process.exitCode) fail('nothing installed');
