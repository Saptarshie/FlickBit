/**
 * Fetch a Kenney CC0 pack and unzip it.
 *
 * kenney.nl does not publish plain links: each asset page carries
 * `data-download-id="<hex of "assets/<slug>">"`, and the real URL comes from
 * `/download-link/<id>`, which answers `{"error":"forbidden"}` unless the request
 * looks like the page's own XHR (Referer + X-Requested-With).
 *
 * That is a download gate, not a paywall: every pack on those pages is CC0. This
 * reproduces what the button does, once, at build time.
 *
 *   npx tsx scripts/fetch-kenney.ts pixel-platformer
 *   npx tsx scripts/fetch-kenney.ts ui-pack game-icons
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const OUT = path.resolve(process.env.KENNEY_DIR ?? '.artifacts/kenney');

async function signedUrl(slug: string): Promise<string> {
  const pageUrl = `https://kenney.nl/assets/${slug}`;
  const page = await fetch(pageUrl, { headers: { 'user-agent': UA } });
  if (!page.ok) throw new Error(`${slug}: page ${page.status}`);
  const html = await page.text();
  const id = /data-download-id=['"]([0-9a-f]+)['"]/.exec(html)?.[1];
  if (!id) throw new Error(`${slug}: no data-download-id on the page`);

  const link = await fetch(`https://kenney.nl/download-link/${id}`, {
    headers: {
      'user-agent': UA,
      referer: pageUrl,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
    },
  });
  if (!link.ok) throw new Error(`${slug}: download-link ${link.status}`);
  const body = (await link.json()) as { url?: string; error?: string };
  if (!body.url) throw new Error(`${slug}: ${body.error ?? 'no url'}`);
  return body.url;
}

async function fetchPack(slug: string): Promise<{ slug: string; dir: string; bytes: number; files: number }> {
  const url = await signedUrl(slug);
  mkdirSync(OUT, { recursive: true });
  const zip = path.join(OUT, `${slug}.zip`);
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok || !res.body) throw new Error(`${slug}: zip ${res.status}`);

  const chunks: Buffer[] = [];
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  await writeFile(zip, bytes);

  const dir = path.join(OUT, slug);
  mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir], { stdio: 'pipe' });

  return { slug, dir, bytes: bytes.byteLength, files: readdirSync(dir).length };
}

async function main(): Promise<void> {
  const slugs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (slugs.length === 0) {
    console.error('usage: npx tsx scripts/fetch-kenney.ts <pack-slug> [more]');
    process.exitCode = 1;
    return;
  }
  for (const slug of slugs) {
    const { dir, bytes, files } = await fetchPack(slug);
    console.log(
      `${slug.padEnd(26)} ${(bytes / 1024 / 1024).toFixed(1).padStart(5)} MB · ${String(files).padStart(3)} entries · ${dir}`,
    );
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
