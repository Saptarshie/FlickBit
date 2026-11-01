import type { Candidate, GameCard } from './types';

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

const HALF_LIFE_MS = 72 * 60 * 60 * 1000;

export function calculateFreshness(createdAt?: Date, now: Date = new Date()): number {
  if (!createdAt) return 1.0;
  const ageMs = Math.max(0, now.getTime() - createdAt.getTime());
  return Math.pow(0.5, ageMs / HALF_LIFE_MS);
}

export type RankOptions = {
  userVec?: number[];
  contentVecs?: Map<string, number[]>;
  now?: Date;
};

/**
 * Phase-1 heuristic candidate ranker:
 * score = 0.40 * sim(user_vec, content_vec) + 0.25 * cf (0 for now) + 0.20 * engagement + 0.10 * quality + 0.05 * freshness
 */
export function rankCandidates(cands: Candidate[], opts: RankOptions = {}): Candidate[] {
  const now = opts.now ?? new Date();
  const userVec = opts.userVec;
  const contentVecs = opts.contentVecs;

  const scored = cands.map((c) => {
    let sim = 0;
    if (userVec && contentVecs?.has(c.gameId)) {
      const cVec = contentVecs.get(c.gameId)!;
      const rawCos = cosineSimilarity(userVec, cVec);
      sim = Math.max(0, Math.min(1, rawCos));
    }

    const cf = 0; // Collaborative filtering reserved for Phase 2
    const engagement = Math.max(0, Math.min(1, c.score ?? 0));
    const quality = Math.max(0, Math.min(1, c.qualityScore ?? 0.5));
    const freshness = calculateFreshness(c.createdAt, now);

    const finalScore =
      0.40 * sim +
      0.25 * cf +
      0.20 * engagement +
      0.10 * quality +
      0.05 * freshness;

    return {
      candidate: c,
      finalScore,
    };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored.map((s) => s.candidate);
}

/**
 * Maximal Marginal Relevance (MMR) re-ranking for diversity:
 * Balances relevance with diversity across content embeddings and enforces a rule that
 * no more than 2 consecutive items share the primary tag.
 */
export function mmrRerank(
  items: GameCard[],
  vecs: Map<string, number[]>,
  lambda: number = 0.7
): GameCard[] {
  if (items.length <= 1) return [...items];

  const remaining = [...items];
  const selected: GameCard[] = [];

  // Compute base relevance from ranking position: 1.0 down to 0.5
  const baseRelevance = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const score = 1.0 - (i / Math.max(1, items.length)) * 0.5;
    baseRelevance.set(items[i].id, score);
  }

  while (remaining.length > 0) {
    if (selected.length === 0) {
      // First item is the top ranked item
      const first = remaining.shift()!;
      selected.push(first);
      continue;
    }

    // Check if the last two selected items share the same primary tag
    const last1Tag = selected[selected.length - 1]?.tags?.[0];
    const last2Tag = selected[selected.length - 2]?.tags?.[0];
    const consecutiveTagLimitReached =
      selected.length >= 2 && Boolean(last1Tag) && last1Tag === last2Tag;

    const hasTagAlternative =
      consecutiveTagLimitReached &&
      remaining.some((item) => item.tags?.[0] !== last1Tag);

    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const rel = baseRelevance.get(cand.id) ?? 0.5;

      // Calculate max similarity to items in selected
      let maxSim = 0;
      const candVec = vecs.get(cand.id);

      for (const sel of selected) {
        const selVec = vecs.get(sel.id);
        if (candVec && selVec) {
          const sim = Math.max(0, cosineSimilarity(candVec, selVec));
          if (sim > maxSim) maxSim = sim;
        } else if (cand.tags?.[0] && cand.tags[0] === sel.tags?.[0]) {
          // Tag overlap fallback if vectors missing
          if (0.5 > maxSim) maxSim = 0.5;
        }
      }

      let mmr = lambda * rel - (1 - lambda) * maxSim;

      // Apply hard rule: no more than 2 consecutive items share the primary tag
      if (hasTagAlternative && cand.tags?.[0] === last1Tag) {
        mmr -= 1000;
      }

      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const [chosen] = remaining.splice(bestIdx, 1);
      selected.push(chosen);
    } else {
      // Fallback in case of edge case
      selected.push(remaining.shift()!);
    }
  }

  return selected;
}
