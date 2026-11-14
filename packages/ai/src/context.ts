/**
 * Context budget.
 *
 * A single generation is stateless: system prompt → brief → code → answer. Nothing
 * accumulates between stages, so the pipeline does not need chat-style compaction —
 * what it needs is a guard that says *this prompt is about to be too big* and a rule
 * for what to drop first.
 *
 * The window on deepseek-v4.1-flash is 384k tokens, so the working ceiling here is
 * 300k: below it, nothing is touched; above it, history is compressed first, then
 * the asset catalogue, and the artifact itself is never trimmed — a repair without
 * the real code is worse than no repair.
 */

/** Rough and deliberately pessimistic: 1 token ≈ 3.5 characters for code + prose. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export interface PromptPart {
  label: string;
  text: string;
  /** Lower priority is dropped first. The code is 100 and must outlive everything. */
  priority: number;
}

export interface CompactResult {
  text: string;
  dropped: string[];
  tokens: number;
}

/**
 * Fit parts into a token budget by dropping the least important until it fits.
 * A dropped part is replaced by a one-line note, not silently removed: a model told
 * "history omitted (budget)" behaves better than one that believes there was none.
 */
export function compactPrompt(parts: PromptPart[], budgetTokens: number): CompactResult {
  const dropped = new Set<string>();
  const kept: PromptPart[] = [...parts];

  const total = () => kept.reduce((sum, p) => sum + estimateTokens(p.text), 0);
  const nextVictim = (): PromptPart | null => {
    const droppable = kept.filter((p) => p.priority < 100 && !dropped.has(p.label));
    if (droppable.length === 0) return null;
    return droppable.reduce((worst, p) =>
      p.priority < worst.priority || (p.priority === worst.priority && p.text.length > worst.text.length) ? p : worst,
    );
  };

  while (total() > budgetTokens) {
    const victim = nextVictim();
    if (!victim) break; // only the artifact is left: keep it, even if oversized
    kept.splice(kept.indexOf(victim), 1, {
      label: victim.label,
      priority: victim.priority,
      text: `[${victim.label} omitted: prompt budget reached]`,
    });
    dropped.add(victim.label);
  }

  return {
    text: kept.map((p) => p.text).join('\n\n'),
    dropped: [...dropped],
    tokens: total(),
  };
}

/** Keep the newest `maxEntries` history turns verbatim and label the rest. */
export function compactHistory<T>(history: T[], maxEntries: number): { kept: T[]; omitted: number } {
  if (history.length <= maxEntries) return { kept: history, omitted: 0 };
  return { kept: history.slice(-maxEntries), omitted: history.length - maxEntries };
}
