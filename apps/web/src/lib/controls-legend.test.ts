import { describe, expect, it } from 'vitest';
import { controlsLegend } from './controls-legend';

describe('controlsLegend', () => {
  it('says what the thumb does, not what the scheme is called', () => {
    expect(controlsLegend('mixed')).toContain('Left thumb');
    expect(controlsLegend('swipe')).toBe('Swipe to steer');
  });

  it('falls back to a playable instruction for an unknown or missing scheme', () => {
    expect(controlsLegend(undefined)).toBe('Tap anywhere to play');
    expect(controlsLegend('telepathy')).toBe('Tap anywhere to play');
  });

  it('is case-insensitive, because manifests are written by a model', () => {
    expect(controlsLegend('MIXED')).toBe(controlsLegend('mixed'));
  });
});
