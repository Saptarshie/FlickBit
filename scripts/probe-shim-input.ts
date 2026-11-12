/**
 * Does a game react to the host's replayed input?
 *
 *   npx tsx scripts/probe-shim-input.ts                    # memory (default)
 *   npx tsx scripts/probe-shim-input.ts --all              # every template
 *   npx tsx scripts/probe-shim-input.ts <path.html>
 *
 * Loads the artifact with the guest shim injected (exactly like the play-worker
 * serves it), then posts the same `input` envelope the host sends on a tap and
 * compares the canvas before/after. Identical frames mean the game never
 * reacted — the failure players reported for Memory, Shooter, Physics Toss and
 * Magma Hop.
 *
 * The runtime gate presses real mouse buttons inside the page, which reaches
 * listeners that the shim-replayed path never touched, so those games passed it.
 */
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { SHIM_SOURCE } from '../packages/sdk/src/shim-source';
import { injectShim } from '../packages/gamekit/src/inject';

const VIEWPORT = { width: 390, height: 844 };

type Result = {
  file: string;
  reacted: boolean;
  hasCanvas: boolean;
  canvasSize: number[] | null;
  hit: string | null;
  errors: string[];
};

async function probe(file: string): Promise<Result> {
  const html = await readFile(file, 'utf8');
  const source = injectShim(html, SHIM_SOURCE);

  const server = createServer((req, res) => {
    if (req.url === '/harness') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">' +
          '<iframe id="f" sandbox="allow-scripts" style="width:390px;height:844px;border:0" src="/game"></iframe>',
      );
    } else if (req.url === '/game') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(source);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`http://127.0.0.1:${port}/harness`);
  const frame = page.frames().find((f) => f.url().endsWith('/game'));
  if (!frame) throw new Error('game frame never loaded');

  await page.waitForTimeout(2600);

  const snapshot = () =>
    frame.evaluate(() => {
      const c = document.querySelector('canvas');
      return c ? c.toDataURL() : 'no-canvas';
    });

  const before = await snapshot();

  // Tap the middle of the frame exactly like the host does, then a few points
  // around it so grid/card games get a hit.
  for (const [x, y] of [
    [195, 420],
    [195, 520],
    [110, 430],
    [280, 430],
  ]) {
    await page.evaluate(
      ([tx, ty]) =>
        new Promise<void>((resolve) => {
          const f = document.getElementById('f') as HTMLIFrameElement;
          f.contentWindow?.postMessage(
            { v: 1, src: 'playloop', type: 'input', payload: { kind: 'tap', x: tx, y: ty, pointerId: 1 } },
            '*',
          );
          setTimeout(() => resolve(), 400);
        }),
      [x, y],
    );
  }
  await page.waitForTimeout(700);
  const after = await snapshot();

  const meta = await frame.evaluate(() => {
    const c = document.querySelector('canvas');
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return {
      hasCanvas: Boolean(c),
      canvasSize: c ? [c.width, c.height] : null,
      hit: el ? el.tagName : null,
    };
  });

  await browser.close();
  server.close();
  return { file: path.relative(process.cwd(), file), reacted: before !== after, ...meta, errors: errors.slice(0, 3) };
}

async function main() {
const args = process.argv.slice(2);
let targets: string[];
if (args.includes('--all')) {
  const names = await readdir('packages/gamekit/templates');
  targets = names.filter((n) => n.endsWith('.html')).map((n) => path.join('packages/gamekit/templates', n));
} else {
  targets = [args[0] ?? 'packages/gamekit/templates/memory.html'];
}

let dead = 0;
for (const file of targets) {
  const r = await probe(file);
  if (!r.reacted) dead += 1;
  console.log(
    `${r.reacted ? 'REACTS' : 'DEAD  '} ${r.file.padEnd(44)} canvas=${r.canvasSize ? r.canvasSize.join('x') : 'none'} hit=${r.hit}`,
  );
  for (const err of r.errors) console.log(`        ! ${err}`);
}
if (dead > 0) {
  console.log(`\n${dead}/${targets.length} games ignore replayed input`);
  process.exitCode = 1;
}

}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
