import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { probeReplayedInput } from './input-probe';
import { templates } from './index';

/**
 * Every shipped template must react to the host's replayed input.
 *
 * The host never lets a finger touch the frame (`pointer-events: none`): it
 * captures the gesture and posts `{ type: 'input' }` into the sandbox. If a shim
 * change breaks that path, the game still renders and still passes a test that
 * presses real mouse buttons — which is how Memory, Shooter, Physics Toss and
 * Magma Hop shipped looking frozen. This test uses the real envelope.
 */
describe('templates respond to host input', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each(templates().map((t) => [t.id, t] as const))('%s reacts to a replayed tap or hold', async (id, template) => {
    const result = await probeReplayedInput(template.code, { browser });
    if (!result.reacted) {
      throw new Error(
        `${id} ignored every replayed input (${result.taps} taps, 0 canvas changes). ` +
          `shim debug: ${JSON.stringify(result.debug)} errors: ${result.errors.join(' | ')}`,
      );
    }
    expect(result.reacted).toBe(true);
  }, 40_000);
});
