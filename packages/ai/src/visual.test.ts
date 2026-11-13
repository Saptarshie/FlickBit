import { describe, expect, it } from 'vitest';
import { reviewVisual, visualDefects, type VisualReview } from './visual';
import type { AiProvider } from './types';

/** A provider that answers with canned JSON — no network, no model. */
function fakeProvider(answer: string): AiProvider & { calls: Array<{ images?: string[] }> } {
  const calls: Array<{ images?: string[] }> = [];
  return {
    calls,
    async generateText(_prompt: string, opts?: { images?: string[] }) {
      calls.push({ images: opts?.images });
      return answer;
    },
    async generateJson<T>() {
      return {} as T;
    },
    async embed() {
      return [];
    },
  } as unknown as AiProvider & { calls: Array<{ images?: string[] }> };
}

const SPEC = {
  title: 'Neon Dead Highway',
  concept: 'Steer a muscle car across a neon highway, blasting zombies.',
  genre: 'arcade',
  templateId: 'tap-runner',
  coreMechanic: 'drive and shoot',
  controls: 'tap',
  palette: [],
  loseCondition: 'crash',
};

const SHOTS = {
  start: 'data:image/png;base64,AAA',
  play: 'data:image/png;base64,BBB',
  over: null,
};

describe('visual review', () => {
  it('passes the screenshots to the model and parses the verdict', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        score: 7,
        verdict: 'ship',
        summary: 'Solid but the HUD is close to the top bar.',
        observed: 'A magenta road with a yellow car.',
        issues: [
          { severity: 'major', area: 'hud', issue: 'Score sits under the profile row', fix: 'Move it to y=120' },
          { severity: 'minor', area: 'polish', issue: 'Stray glyphs', fix: 'Remove them' },
        ],
      }),
    );

    const review = await reviewVisual({ shots: SHOTS, spec: SPEC, description: 'drive', provider });
    expect(provider.calls[0]?.images).toHaveLength(2);
    expect(review).toMatchObject({ score: 7, verdict: 'ship' });
    expect(review?.issues).toHaveLength(2);
  });

  it('turns a critical finding into verdict "fix" even when the model says ship', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        score: 6,
        verdict: 'ship',
        summary: 'x',
        issues: [
          { severity: 'critical', area: 'match', issue: 'No zombies on screen', fix: 'Spawn them' },
        ],
      }),
    );
    const review = await reviewVisual({ shots: SHOTS, spec: SPEC, provider });
    expect(review?.verdict).toBe('fix');
  });

  it('clamps a nonsense score instead of trusting it', async () => {
    const provider = fakeProvider(JSON.stringify({ score: 99, verdict: 'ship', summary: '', issues: [] }));
    expect((await reviewVisual({ shots: SHOTS, spec: SPEC, provider }))?.score).toBe(10);
  });

  it('returns null when the model output is not JSON — a missing opinion never blocks a build', async () => {
    expect(await reviewVisual({ shots: SHOTS, spec: SPEC, provider: fakeProvider('looks fine to me') })).toBeNull();
  });

  it('returns null when there is nothing to look at', async () => {
    const provider = fakeProvider('{}');
    const review = await reviewVisual({
      shots: { start: null, play: null, over: null },
      spec: SPEC,
      provider,
    });
    expect(review).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it('turns major and critical findings into repair feedback, and drops minors', () => {
    const review: VisualReview = {
      score: 4,
      verdict: 'fix',
      summary: '',
      issues: [
        { severity: 'critical', area: 'match', issue: 'No zombies', fix: 'Spawn 3-5 silhouettes' },
        { severity: 'major', area: 'hud', issue: 'HUD under chrome', fix: 'Move below y=72' },
        { severity: 'minor', area: 'polish', issue: 'Stray glyph', fix: 'Remove' },
      ],
    };
    const defects = visualDefects(review);
    expect(defects).toHaveLength(2);
    expect(defects[0]).toContain('[visual/match] No zombies');
    expect(defects.join(' ')).not.toContain('Stray glyph');
  });
});
