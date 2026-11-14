import { describe, expect, it } from 'vitest';
import { compactHistory, compactPrompt, estimateTokens } from './context';

describe('context budget', () => {
  it('estimates tokens conservatively from characters', () => {
    expect(estimateTokens('abcd'.repeat(100))).toBeGreaterThan(100);
    expect(estimateTokens('')).toBe(0);
  });

  it('leaves a prompt alone when it fits', () => {
    const result = compactPrompt(
      [
        { label: 'rules', text: 'short rules', priority: 40 },
        { label: 'source', text: 'const a = 1;', priority: 100 },
      ],
      10_000,
    );
    expect(result.dropped).toEqual([]);
    expect(result.text).toContain('const a = 1;');
  });

  it('drops the lowest priority first and never the artifact', () => {
    const big = 'x'.repeat(4000); // ~1143 tokens each
    const result = compactPrompt(
      [
        { label: 'history', text: big, priority: 10 },
        { label: 'catalogue', text: big, priority: 30 },
        { label: 'source', text: big, priority: 100 },
      ],
      1_500,
    );
    expect(result.dropped).toContain('history');
    // The code survives even when it alone is over budget: a repair without the
    // real file is worse than an oversized prompt.
    expect(result.text).toContain('x'.repeat(100));
  });

  it('says a section was omitted instead of pretending it never existed', () => {
    const big = 'y'.repeat(8000);
    const result = compactPrompt(
      [
        { label: 'history', text: big, priority: 10 },
        { label: 'source', text: 'code', priority: 100 },
      ],
      100,
    );
    expect(result.text).toContain('[history omitted: prompt budget reached]');
  });

  it('compacts history to the newest turns and counts what it dropped', () => {
    const history = Array.from({ length: 20 }, (_, i) => `turn ${i + 1}`);
    const { kept, omitted } = compactHistory(history, 8);
    expect(kept).toHaveLength(8);
    expect(kept[7]).toBe('turn 20');
    expect(omitted).toBe(12);
  });
});
