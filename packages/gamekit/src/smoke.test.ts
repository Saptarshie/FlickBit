import { describe, expect, it } from 'vitest';
import { injectShim } from './inject';
import { runSmokeTest } from './smoke';
import { templates } from './index';

const BLANK_FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body></body>
</html>`;

const THROWING_FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<script>throw new Error('fixture-boom');</script>
</body>
</html>`;

/** Never calls PlayLoop.ready() and never finishes loading (the hang route
 *  never responds), so the shim's window-load fallback ready never fires. */
const NEVER_READY_FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<img src="/__pl_hang/pending.png" alt="">
</body>
</html>`;

/** Starts animating only after a tap; keeps animating afterwards. */
const ANIMATES_ON_TAP_FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#222">
<canvas id="c"></canvas>
<script>
var cv = document.getElementById('c');
cv.width = window.innerWidth; cv.height = window.innerHeight;
var ctx = cv.getContext('2d');
var x = 20, running = false;
function loop() {
  x = (x + 4) % cv.width;
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#5cf'; ctx.fillRect(x, 80, 60, 60);
  requestAnimationFrame(loop);
}
window.addEventListener('pointerdown', function () {
  if (!running) { running = true; PlayLoop.ready(); requestAnimationFrame(loop); }
});
</script>
</body>
</html>`;

describe('injectShim', () => {
  it('injects the shim as the first child of <head>, before any game script', () => {
    const html =
      '<!doctype html><html><head><title>x</title><script src="game.js"></script></head><body></body></html>';
    const out = injectShim(html, '/*SHIM*/');
    const headAt = out.search(/<head[^>]*>/i);
    const shimAt = out.indexOf('<script>/*SHIM*/</script>');
    const gameScriptAt = out.indexOf('<script src="game.js">');
    expect(shimAt).toBeGreaterThan(headAt);
    expect(shimAt).toBeLessThan(gameScriptAt);
  });

  it('prepends the shim (after the doctype) when there is no <head> tag', () => {
    const html = '<!doctype html><html><body><script>PlayLoop.ready();</script></body></html>';
    const out = injectShim(html, '/*SHIM*/');
    expect(out.startsWith('<!doctype html><script>/*SHIM*/</script>')).toBe(true);
    expect(out.indexOf('/*SHIM*/')).toBeLessThan(out.indexOf('PlayLoop.ready'));
  });

  it('prepends the shim to documents with neither head nor doctype', () => {
    const out = injectShim('<div>hi</div>', '/*SHIM*/');
    expect(out.startsWith('<script>/*SHIM*/</script><div>hi</div>')).toBe(true);
  });
});

describe('runSmokeTest fixtures', () => {
  it('blank static page reports blankScreen true', async () => {
    const report = await runSmokeTest(BLANK_FIXTURE);
    expect(report.blankScreen, JSON.stringify(report)).toBe(true);
  }, 60_000);

  it('page that throws reports uncaught non-empty', async () => {
    const report = await runSmokeTest(THROWING_FIXTURE);
    expect(report.uncaught.length, JSON.stringify(report)).toBeGreaterThan(0);
  }, 60_000);

  it('page that never calls ready reports readyWithin3s false', async () => {
    const report = await runSmokeTest(NEVER_READY_FIXTURE);
    expect(report.readyWithin3s, JSON.stringify(report)).toBe(false);
  }, 60_000);

  it('page that animates on tap reports interactive true', async () => {
    const report = await runSmokeTest(ANIMATES_ON_TAP_FIXTURE);
    expect(report.interactive, JSON.stringify(report)).toBe(true);
  }, 60_000);
});

describe('templates smoke gate', () => {
  it.each(templates().map((t) => [t.id, t] as const))(
    '%s reports pass true, interactive true, fps >= 30',
    async (_id, template) => {
      const report = await runSmokeTest(template.code);
      expect(report.interactive, JSON.stringify(report)).toBe(true);
      expect(report.fps, JSON.stringify(report)).toBeGreaterThanOrEqual(30);
      expect(report.pass, JSON.stringify(report)).toBe(true);
    },
    120_000,
  );
});
