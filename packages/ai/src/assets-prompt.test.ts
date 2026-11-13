import { describe, expect, it } from 'vitest';
import { generateCode } from './generator';
import type { AiProvider, GameSpec } from './types';

const SPEC: GameSpec = {
  title: 'Coin Rush',
  concept: 'collect coins',
  genre: 'arcade',
  templateId: 'tap-runner',
  coreMechanic: 'tap to jump',
  controls: 'tap',
  palette: ['#fff'],
  loseCondition: 'hit',
};

function recorder(answer = '<!doctype html><html><head></head><body></body></html>') {
  const prompts: string[] = [];
  const provider = {
    async generateText(prompt: string) {
      prompts.push(prompt);
      return answer;
    },
    async generateJson<T>() {
      return {} as T;
    },
    async embed() {
      return [];
    },
  } as unknown as AiProvider;
  return { provider, prompts };
}

describe('asset catalogue in the coder prompt', () => {
  it('lists the catalogue with file names and the loading rules', async () => {
    const { provider, prompts } = recorder();
    await generateCode('make a coin game', SPEC, provider, {
      assetCatalogue: [
        { id: 'coin', kind: 'icon', width: 64, height: 64, file: 'df22c812ddd664fa.webp', tags: ['currency'] },
        { id: 'hero_runner', kind: 'sprite', width: 128, height: 128, file: 'aa11bb22cc33dd44.webp', tags: ['player'] },
      ],
    });
    const prompt = prompts.join('\n');
    expect(prompt).toContain('/a/');
    expect(prompt).toContain('df22c812ddd664fa.webp');
    expect(prompt).toContain('hero_runner');
    expect(prompt).toMatch(/imageSmoothingEnabled/);
    expect(prompt).toMatch(/manifest/);
  });

  it('says nothing about assets when the catalogue is empty', async () => {
    const { provider, prompts } = recorder();
    await generateCode('make a coin game', SPEC, provider, {});
    expect(prompts.join('\n')).not.toContain('ASSETS —');
  });
});
