import { describe, expect, it } from 'vitest';
import { designGame } from './design';
import type { AiProvider, GameSpec } from './types';

const SPEC: GameSpec = {
  title: 'Paper Fields',
  concept: 'a calm paper cut-out platformer',
  genre: 'platformer',
  templateId: 'tap-runner',
  coreMechanic: 'tap to hop',
  controls: 'tap',
  palette: [],
  loseCondition: 'fall',
};

function recorder() {
  let seen = '';
  const provider = {
    async generateText(prompt: string, options?: { systemPrompt?: string }) {
      seen = `${options?.systemPrompt ?? ''}
${prompt}`;
      return JSON.stringify({
        visualIdentity: 'Layered construction paper, hard shadows, no glow.',
        palette: ['#f5efe1', '#d94f3d', '#2f4858', '#8fbf9f', '#e8b04b'],
        hud: ['score top-centre'],
        assetPlan: ['player: hero_runner sprite', 'ground: kp_tile_grass'],
        juice: { small: 'a', medium: 'b', large: 'c' },
        difficulty: 'speed +10% per 100',
        performanceNotes: ['pool particles'],
        failureModes: ['no unfair start'],
      });
    },
    async generateJson<T>() {
      return {} as T;
    },
    async embed() {
      return [];
    },
  } as unknown as AiProvider;
  return { provider, seen: () => seen };
}

describe('art director knows about the catalogue and about its own defaults', () => {
  it('passes the real asset shortlist with file names', async () => {
    const { provider, seen } = recorder();
    await designGame('paper platformer', SPEC, provider, undefined, [
      { id: 'hero_runner', kind: 'sprite', file: 'aa11bb22cc33dd44.webp', category: '2d/characters' },
    ]);
    expect(seen()).toContain('ASSET SHORTLIST');
    expect(seen()).toContain('/a/aa11bb22cc33dd44.webp');
    expect(seen()).toContain('2d/characters');
  });

  it('tells the art director not to default to neon', async () => {
    const { provider, seen } = recorder();
    await designGame('paper platformer', SPEC, provider);
    const prompt = seen();
    expect(prompt).toMatch(/Do not\s+add another one/i);
    expect(prompt).toContain('Never title a game');
  });

  it('says so explicitly when there is no shortlist', async () => {
    const { provider, seen } = recorder();
    await designGame('paper platformer', SPEC, provider);
    expect(seen()).toContain('ASSET SHORTLIST: none for this brief');
  });
});
