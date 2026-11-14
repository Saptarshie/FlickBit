/**
 * The authoring plan a game carries with itself.
 *
 * A single 60 KB file is written in one pass and then repaired up to six times.
 * The failure mode is not "the model cannot code" — it is "the model forgets what
 * it decided three repairs ago": the section that held the HUD gets dropped, an
 * asset declared in the manifest is no longer referenced, the state machine loses
 * its `over` branch. Those are all state that lives only in an earlier message
 * window.
 *
 * So the artifact carries its own state: a small `pl-plan` block the coder writes
 * FIRST, that repair passes receive, and that the review gate can check against
 * the code. It is deliberately small (a few hundred bytes) and human-readable.
 */

export interface GamePlan {
  /** Ordered list of what the file contains, e.g. "1 CONFIG", "5 LOOP". */
  sections?: string[];
  /** "start -> playing -> over -> start" */
  stateMachine?: string;
  /** "tap anywhere: flap; hold: rise" */
  input?: string;
  entities?: string[];
  /** How score moves, in one line. */
  score?: string;
  /** Where the HUD elements sit, in one line. */
  hud?: string;
  /** What is deliberately not built yet. Repairs must not invent scope. */
  todo?: string[];
}

export interface RepairNote {
  attempt: number;
  stage: string;
  /** One line: what was wrong. */
  issue: string;
}

const PLAN_RE = /<script[^>]*id=["']pl-plan["'][^>]*>([\s\S]*?)<\/script>/i;

/** Read the plan block. Returns null when the coder did not write one. */
export function extractPlan(html: string): GamePlan | null {
  const m = PLAN_RE.exec(html);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1] ?? '') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as GamePlan;
  } catch {
    return null;
  }
}

/** Section markers the coder is asked to leave in the code: `// == 3. ENTITIES ==` */
export function sectionIndex(html: string): string[] {
  const out: string[] = [];
  const re = /^[ \t]*(?:\/\/|#)\s*==+\s*(.+?)\s*==+\s*$/gm;
  for (const m of html.matchAll(re)) {
    const label = (m[1] ?? '').trim();
    if (label.length > 0 && label.length <= 48) out.push(label);
  }
  return out;
}

/**
 * A compact text form for prompts. JSON in a prompt is read as data; a short
 * labelled list is read as instructions, and survives being 4,000 tokens back in
 * the context window much better.
 */
export function planSummary(plan: GamePlan | null): string {
  if (!plan) return '';
  const lines: string[] = [];
  if (plan.stateMachine) lines.push(`state machine: ${plan.stateMachine}`);
  if (plan.input) lines.push(`input: ${plan.input}`);
  if (plan.entities?.length) lines.push(`entities: ${plan.entities.join(', ')}`);
  if (plan.score) lines.push(`scoring: ${plan.score}`);
  if (plan.hud) lines.push(`hud: ${plan.hud}`);
  if (plan.sections?.length) lines.push(`sections: ${plan.sections.join(' | ')}`);
  if (plan.todo?.length) lines.push(`still to do (do not invent more): ${plan.todo.join('; ')}`);
  return lines.join('\n');
}

/** What previous repairs changed. Passed back so a repair cannot undo them. */
export function journalSummary(journal: RepairNote[]): string {
  if (journal.length === 0) return '';
  return journal.map((n) => `- [${n.stage} #${n.attempt}] ${n.issue}`).join('\n');
}
