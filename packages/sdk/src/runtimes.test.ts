import { describe, expect, it } from 'vitest';
import {
  RUNTIMES,
  isRuntimeId,
  planPrefetch,
  resolveRuntime,
  runtimeFileName,
  runtimeUrl,
} from './runtimes';

const SRI = `sha384-${'A'.repeat(64)}`;

describe('runtime registry', () => {
  it('defaults an artifact with no runtime to the inlined micro shim', () => {
    expect(resolveRuntime(undefined).id).toBe('micro');
    expect(resolveRuntime(null).id).toBe('micro');
    expect(resolveRuntime('nope').id).toBe('micro');
  });

  it('only accepts ids from the allowlist — a manifest can never name a URL', () => {
    expect(isRuntimeId('phaser4')).toBe(true);
    expect(isRuntimeId('https://evil.example/x.js')).toBe(false);
    expect(isRuntimeId('Phaser4')).toBe(false);
  });

  it('builds a content-addressed file name from the SRI digest', () => {
    expect(runtimeFileName('phaser4', '4.2.1', SRI)).toBe('phaser4@4.2.1-AAAAAAAAAAAAAAAA.js');
    expect(runtimeUrl('http://localhost:3001/', 'phaser4', '4.2.1', SRI)).toBe(
      'http://localhost:3001/r/phaser4@4.2.1-AAAAAAAAAAAAAAAA.js',
    );
  });
});

describe('planPrefetch', () => {
  it('skips engines that are not installed yet and never fetches micro', () => {
    expect(planPrefetch(['micro', 'phaser4', 'babylon'])).toEqual([]);
  });

  it('dedupes, skips already-loaded engines, and keeps the byte budget', () => {
    // Pretend phaser4 is installed; babylon is far too big to ride along.
    const saved = { ...RUNTIMES };
    try {
      RUNTIMES.phaser4 = { ...RUNTIMES.phaser4, available: true };
      RUNTIMES.babylon = { ...RUNTIMES.babylon, available: true };

      const chosen = planPrefetch(['phaser4', 'phaser4', null, 'micro', 'babylon'], {
        budgetBytes: 500 * 1024,
      });
      expect(chosen.map((r) => r.id)).toEqual(['phaser4']);

      expect(planPrefetch(['phaser4'], { loaded: new Set(['phaser4']) })).toEqual([]);
    } finally {
      Object.assign(RUNTIMES, saved);
    }
  });
});
