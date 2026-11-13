import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { templatesDir } from './index';
import { playtest } from './playtest';

/**
 * The playtest gate has to be able to fail, or it is decoration. These tests
 * score it on three known artifacts: a real game that plays, a game that draws
 * one frame and ignores input, and a game that never boots.
 */

function page(script: string): string {
  return [
    '<!doctype html><html><head>',
    '<script type="application/json" id="pl-manifest">',
    JSON.stringify({
      title: 'Probe',
      description: 'test fixture',
      controls: 'tap',
      orientation: 'portrait',
      sdkVersion: 1,
      tags: ['arcade'],
      scoring: 'higher',
    }),
    '</script></head><body><canvas id="c" style="width:100vw;height:100vh"></canvas><script>',
    script,
    '</script></body></html>',
  ].join('');
}

// Frozen: paints a frame, never reacts, reports ready honestly.
const FROZEN = page(`
  var c = document.getElementById('c'), x = c.getContext('2d');
  function draw() {
    x.fillStyle = '#101322'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#ffd166'; x.fillRect(40, 40, 30, 30);
  }
  c.width = 390; c.height = 844; draw();
  PlayLoop.ready();
`);

// A game that plays: score climbs on every tap, and it ends after five.
const PLAYABLE = page(`
  var c = document.getElementById('c'), x = c.getContext('2d');
  var score = 0, over = false, born = performance.now();
  c.width = 390; c.height = 844;
  function render() {
    x.fillStyle = '#0b1020'; x.fillRect(0, 0, 390, 844);
    x.fillStyle = '#38bdf8';
    x.fillRect(20 + (score * 37) % 300, 120 + (score * 53) % 400, 26, 26);
    x.fillStyle = '#e9f0ff'; x.font = '18px system-ui'; x.fillText('Score ' + score, 16, 40);
    if (over) { x.fillStyle = '#fb7185'; x.fillText('GAME OVER — TAP TO RESTART', 40, 430); }
  }
  function loop(now) {
    if (over && now - born > 400) { return; }
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  addEventListener('pointerdown', function () {
    if (over) { score = 0; over = false; born = performance.now(); requestAnimationFrame(loop); return; }
    score += 1;
    PlayLoop.submitScore(score);
    if (score >= 5) { over = true; born = performance.now(); PlayLoop.gameOver({ score: score }); }
  });
  PlayLoop.ready();
`);

// Never boots: no ready(), nothing on screen.
const DEAD = page(`var nothing = 1;`);

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

describe('playtest gate', () => {
  it('passes a real game: taps move it, score climbs, restart works', async () => {
    const report = await playtest(PLAYABLE, { browser, taps: 8 });
    expect(report.defects).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.changes).toBeGreaterThan(0);
    expect(report.scoreMoved).toBe(true);
    expect(report.gameOverSeen).toBe(true);
    expect(report.restartWorked).toBe(true);
  }, 60_000);

  it('fails a frozen game — the exact bug a screenshot cannot see', async () => {
    const report = await playtest(FROZEN, { browser, taps: 4 });
    expect(report.pass).toBe(false);
    expect(report.ready).toBe(true);
    expect(report.defects.join(' ')).toContain('frozen');
  }, 60_000);

  it('fails a game that draws nothing at all', async () => {
    // The shim posts `ready` on window load even when the game never calls it,
    // so a dead artifact is caught by what it does NOT do: paint or respond.
    const report = await playtest(DEAD, { browser, taps: 2 });
    expect(report.pass).toBe(false);
    expect(report.defects.join(' ')).toContain('frozen');
  }, 60_000);

  it('does not judge the score for a scoring:none game', async () => {
    const report = await playtest(FROZEN, { browser, taps: 2, scoring: 'none' });
    expect(report.defects.join(' ')).not.toContain('score never moved');
  }, 60_000);

  it('passes every shipped micro template', async () => {
    const dir = templatesDir();
    const ids = ['flappy', 'snake', 'tap-runner', 'shooter'];
    for (const id of ids) {
      const html = readFileSync(join(dir, `${id}.html`), 'utf8');
      const report = await playtest(html, { browser, taps: 20 });
      expect(report.defects, `${id}: ${report.defects.join('; ')}`).toEqual([]);
      // Every template must respond; progress is reported separately because a
      // snake can legitimately not eat in six seconds.
      expect(report.changes, `${id}: never changed a frame`).toBeGreaterThan(0);
    }
  }, 180_000);
});
