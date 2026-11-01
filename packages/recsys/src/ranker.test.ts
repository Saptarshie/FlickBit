import { describe, it, expect } from 'vitest';
import { rankCandidates, mmrRerank } from './ranker';
import type { Candidate, GameCard } from './types';

function cand(gameId: string, score: number, extra: Partial<Candidate> = {}): Candidate {
  return { gameId, source: 'trending', score, ...extra };
}

describe('rankCandidates', () => {
  it('orders a high-cosine-similarity game above a low one when all else is equal', () => {
    const cands = [cand('low-sim', 0.5), cand('high-sim', 0.5)];
    const out = rankCandidates(cands, {
      userVec: [1, 0],
      contentVecs: new Map([
        ['high-sim', [1, 0]],
        ['low-sim', [0, 1]],
      ]),
    });
    expect(out.map((c) => c.gameId)).toEqual(['high-sim', 'low-sim']);
  });

  it('decays freshness with a 72h half-life (newer beats older when all else is equal)', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    const cands = [
      cand('old', 0.5, { createdAt: new Date('2026-01-04T00:00:00Z') }),
      cand('new', 0.5, { createdAt: new Date('2026-01-09T12:00:00Z') }),
    ];
    const out = rankCandidates(cands, { now });
    expect(out.map((c) => c.gameId)).toEqual(['new', 'old']);
  });

  it('breaks score ties deterministically by gameId', () => {
    const out = rankCandidates([cand('b', 0.5), cand('a', 0.5)], {});
    expect(out.map((c) => c.gameId)).toEqual(['a', 'b']);
    expect(out[0]?.score).toBeCloseTo(out[1]?.score ?? NaN, 10);
  });

  it('does not mutate the input array', () => {
    const cands = [cand('x', 0.1), cand('y', 0.9)];
    rankCandidates(cands, {});
    expect(cands.map((c) => c.gameId)).toEqual(['x', 'y']);
  });
});

function card(id: string, tags: string[], vec: number[]): GameCard & { vec: number[] } {
  return {
    id,
    versionId: `${id}-v1`,
    title: id,
    description: '',
    tags,
    creator: { id: 'u1', handle: 'u1', avatar: null },
    artifactUrl: `https://play.example.com/v/${id}.html`,
    posterUrl: null,
    counts: { likes: 0, saves: 0, comments: 0, plays: 0 },
    viewer: { liked: false, saved: false, followsCreator: false },
    forkedFrom: null,
    vec,
  };
}

describe('mmrRerank', () => {
  it('does not put two same-tag games adjacent when a different-tag option exists', () => {
    const items = [card('g1', ['a'], [1, 0]), card('g2', ['a'], [1, 0]), card('g3', ['b'], [0, 1])];
    const vecs = new Map<string, number[]>(items.map((it) => [it.id, it.vec]));
    const out = mmrRerank(items, vecs);
    expect(out).toHaveLength(3);
    for (let i = 1; i < out.length; i += 1) {
      const prev = out[i - 1]!;
      const cur = out[i]!;
      const shared = cur.tags.filter((t) => prev.tags.includes(t));
      expect(shared, `${cur.id} shares tag with ${prev.id}`).toHaveLength(0);
    }
  });

  it('keeps all items and is stable for empty vectors', () => {
    const items = [card('a', ['x'], [1]), card('b', ['y'], [0])];
    const out = mmrRerank(items, new Map());
    expect(out.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty input', () => {
    expect(mmrRerank([], new Map())).toEqual([]);
  });
});
