/**
 * End-to-end input probe against the running app.
 *
 *   npx tsx scripts/probe-live-input.ts [--base http://localhost:3000] [--game <id>]
 *
 * Opens the feed, taps the first card to engage play, then taps the game area
 * and reports whether the game reacted. It reads inside the sandboxed frame with
 * Playwright (CDP ignores the sandbox origin), so this measures the real path a
 * phone takes: pointerdown -> host -> postMessage -> shim -> game.
 *
 * A card that shows "Playing" but never changes is exactly the bug that shipped
 * while the runtime gate was pressing real mouse buttons instead.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const baseFlag = args.indexOf('--base');
const BASE = baseFlag >= 0 ? args[baseFlag + 1] : 'http://localhost:3000';
const titleFlag = args.indexOf('--title');
/** Which game to probe; the feed is scrolled until this title is active. */
const TARGET_TITLE = titleFlag >= 0 ? args[titleFlag + 1] : null;
const START_URL = BASE;

const VIEWPORT = { width: 390, height: 844 };

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, hasTouch: true, isMobile: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.addInitScript(() => {
    (window as unknown as { __PLAYLOOP_DEBUG__?: boolean }).__PLAYLOOP_DEBUG__ = true;
  });
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const cards = page.locator('section[aria-label]');
  if ((await cards.count()) === 0) throw new Error('no game cards rendered — is the feed loading?');

  // Scroll the feed until the requested title owns the viewport.
  let title = await cards.first().getAttribute('aria-label');
  if (TARGET_TITLE) {
    let found = false;
    for (let i = 0; i < 24; i += 1) {
      const visible = await page.evaluate((want) => {
        const sections = [...document.querySelectorAll('section[aria-label]')];
        const hit = sections.find((s) => {
          const r = s.getBoundingClientRect();
          return s.getAttribute('aria-label') === want && r.top > -20 && r.top < window.innerHeight - 100;
        });
        return Boolean(hit);
      }, TARGET_TITLE);
      if (visible) {
        found = true;
        title = TARGET_TITLE;
        break;
      }
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(650);
    }
    if (!found) throw new Error(`never reached "${TARGET_TITLE}" in the feed`);
  }

  // 1. engage play mode: tap the middle of the card
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height * 0.45);
  await page.waitForTimeout(1500);
  // The chip reads "Playing" while the run is alive and "Game over" once it
  // ends, so the chip alone is not a reliable engagement signal — a short game
  // can finish inside the probe. A forwarded input with a live host is.
  const engaged = await page.evaluate(() => {
    const input = (window as { __plInput?: { host?: string } }).__plInput;
    if (input) return input.host === 'live';
    return [...document.querySelectorAll('*')].some((e) => e.textContent?.trim() === 'Playing');
  });

  // Pick the frame of the card that is actually on screen: matching any
  // /v/<sha> URL grabs whichever of the three live frames happens to be first.
  const frameFor = async () => {
    const src = await page.evaluate(() => {
      const visible = [...document.querySelectorAll('iframe')].find((f) => {
        const r = f.getBoundingClientRect();
        return r.top > -60 && r.top < window.innerHeight - 120;
      });
      return visible ? (visible as HTMLIFrameElement).src : null;
    });
    return src ? (page.frames().find((f) => f.url() === src) ?? null) : null;
  };
  let frame = await frameFor();
  if (!frame) throw new Error('game frame never mounted');

  // The feed mounts/unmounts iframes while scrolling, so a frame captured once
  // can detach mid-probe. Re-resolve it on every read.
  const snapshot = async () => {
    frame = (await frameFor()) ?? frame;
    try {
      return await readFrame(frame!);
    } catch (err) {
      if (!/detached|Target closed/i.test(String(err))) throw err;
      await page.waitForTimeout(400);
      frame = (await frameFor()) ?? frame;
      return readFrame(frame!);
    }
  };

  const readFrame = (f: NonNullable<typeof frame>) =>
    f.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const text = document.body.innerText.slice(0, 400);
      // Full data URL: a slice of the tail misses changes in the middle of the
      // canvas (cards, bricks, shooters all live there).
      return { canvas: canvas ? canvas.toDataURL() : 'no-canvas', text };
    });

  // Count what the guest actually receives while we tap.
  await frame.evaluate(() => {
    const w = window as unknown as { __probeHits?: { down: number; at: number[][] } };
    w.__probeHits = { down: 0, at: [] };
    window.addEventListener('pointerdown', (e) => {
      w.__probeHits!.down += 1;
      w.__probeHits!.at.push([Math.round(e.clientX), Math.round(e.clientY)]);
    });
  });

  frame = (await frameFor()) ?? frame;
  const before = await snapshot();

  // 2. tap the game like a player would: several points inside the frame
  for (const [x, y] of [
    [195, 430],
    [195, 360],
    [120, 430],
    [270, 430],
  ]) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(450);
  }
  await page.waitForTimeout(500);

  const after = await snapshot();
  const changed = before.canvas !== after.canvas || before.text !== after.text;

  const replayed = await page.evaluate(() => (window as { __plInput?: unknown }).__plInput ?? null);
  const hits = await frame!.evaluate(() => (window as unknown as { __probeHits?: unknown }).__probeHits ?? null);

  await browser.close();

  console.log(`game        ${title}`);
  console.log(`engaged     ${engaged}`);
  console.log(`reacted     ${changed}`);
  console.log(`last input  ${JSON.stringify(replayed)}`);
  console.log(`guest saw   ${JSON.stringify(hits)}`);
  if (errors.length) for (const e of errors.slice(0, 4)) console.log(`error       ${e}`);

  if (!engaged) {
    console.log('\nFAIL: tapping the card did not enter play mode');
    process.exitCode = 1;
  } else if (!changed) {
    console.log('\nFAIL: the game is engaged but ignores taps');
    process.exitCode = 1;
  } else {
    console.log('\nPASS: the card engages and the game responds to taps');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
