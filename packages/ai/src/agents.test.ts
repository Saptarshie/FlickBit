import { describe, expect, it } from 'vitest';
import { designGame } from './design';
import { reviewGame } from './review';
import type { AiProvider, GameSpec } from './types';

const spec: GameSpec = {
  title: 'Neon Dash',
  concept: 'A neon runner',
  genre: 'arcade',
  templateId: 'tap-runner',
  coreMechanic: 'Tap to jump',
  controls: 'tap',
  palette: ['#000000', '#ff00ff', '#00ffff'],
  loseCondition: 'Hit a wall',
};

function providerReturning(text: string): AiProvider {
  return {
    async generateText() {
      return text;
    },
  };
}

describe('designGame (art director stage)', () => {
  it('parses a design brief and keeps the important fields', async () => {
    const design = await designGame(
      'neon runner',
      spec,
      providerReturning(
        JSON.stringify({
          visualIdentity: 'Neon silhouettes on black, one accent for the player.',
          palette: ['#0a0a0a', '#ff2e97', '#00f0ff'],
          hud: ['score top-centre'],
          assetPlan: ['player: triangle'],
          juice: { small: 'tick', medium: 'hit', large: 'boom' },
          difficulty: 'speed +8% per 10 points',
          performanceNotes: ['pool particles'],
          failureModes: ['NaN radius'],
        }),
      ),
    );

    expect(design.palette).toEqual(['#0a0a0a', '#ff2e97', '#00f0ff']);
    expect(design.juice.large).toBe('boom');
    expect(design.difficulty).toContain('8%');
    expect(design.failureModes).toContain('NaN radius');
  });

  it('falls back to a usable brief when the model returns junk', async () => {
    const design = await designGame('neon runner', spec, providerReturning('not json at all'));
    expect(design.palette.length).toBeGreaterThanOrEqual(3);
    expect(design.juice.small.length).toBeGreaterThan(0);
    expect(design.hud.length).toBeGreaterThan(0);
  });

  it('falls back when the provider throws', async () => {
    const provider: AiProvider = {
      async generateText() {
        throw new Error('gateway down');
      },
    };
    const design = await designGame('neon runner', spec, provider);
    expect(design.visualIdentity).toContain('neon runner');
  });
});

describe('reviewGame (QA stage)', () => {
  it('marks a build with critical issues as revise', async () => {
    const report = await reviewGame({
      code: '<html></html>',
      spec,
      provider: providerReturning(
        JSON.stringify({
          verdict: 'ship',
          summary: 'mostly fine',
          issues: [{ severity: 'critical', issue: 'game throws on start', fix: 'guard the radius' }],
        }),
      ),
      smoke: { pass: false, fps: 0, blankScreen: true, interactive: false, consoleErrors: ['boom'], uncaught: ['TypeError'] },
    });

    expect(report.verdict).toBe('revise');
    expect(report.issues[0]?.severity).toBe('critical');
    expect(report.issues[0]?.fix).toContain('radius');
  });

  it('never throws when the reviewer fails', async () => {
    const report = await reviewGame({
      code: '<html></html>',
      spec,
      provider: {
        async generateText() {
          throw new Error('timeout');
        },
      },
    });
    expect(report.verdict).toBe('ship');
    expect(report.summary).toContain('review unavailable');
  });
});
