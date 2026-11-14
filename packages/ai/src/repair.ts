import type { ValidationResult } from '@playloop/gamekit';
import { REPAIR_SYSTEM_PROMPT } from './prompts';
import { extractHtmlArtifact } from './generator';
import { journalSummary, planSummary, sectionIndex, type GamePlan, type RepairNote } from './plan';
import type { AiProvider } from './types';

/** Keeps the prompt readable without embedding raw newlines in string literals. */
const NL = String.fromCharCode(10);

export interface RepairContext {
  /** The plan block the coder wrote on the first pass. */
  plan?: GamePlan | null;
  /** What every earlier repair already changed, so this one does not undo it. */
  journal?: RepairNote[];
  /** Where in the file things are, so the model edits rather than rewrites. */
  sections?: string[];
}

/**
 * Repair a game from either static validation errors or runtime/QA defects.
 *
 * `runtimeDefects` matters: a build can pass static validation and still throw on
 * the first hold (the Magma Hop freeze), so the same repair call has to accept
 * "it crashed at runtime" as a defect list.
 */
export async function repairCode(
  currentCode: string,
  report: ValidationResult,
  provider: AiProvider,
  runtimeDefects: string[] = [],
  context: RepairContext = {},
): Promise<string> {
  const errorsText = report.errors.join(NL + '- ');
  const runtimeText =
    runtimeDefects.length > 0
      ? NL + NL +
        'It also failed at runtime or review:' + NL + '- ' + runtimeDefects.join(NL + '- ') + NL +
        'Fix these too: a game that throws, freezes or never reacts is not shippable.'
      : '';

  // The memory the model does not have: the plan it wrote four turns ago, the
  // fixes already applied, and the file's section layout.
  const planText = planSummary(context.plan ?? null);
  const planBlock =
    planText.length > 0
      ? NL + NL + 'The plan this artifact was written against (keep it true):' + NL + planText
      : NL + NL + 'This artifact has no <script id="pl-plan"> block. Add one that matches the code you return.';

  const journalText = journalSummary(context.journal ?? []);
  const journalBlock =
    journalText.length > 0 ? NL + NL + 'Already fixed in earlier passes — do not undo these:' + NL + journalText : '';

  const sections = context.sections ?? sectionIndex(currentCode);
  const sectionBlock =
    sections.length > 0
      ? NL + NL + 'Sections present in the file (edit in place; do not drop one):' + NL + '- ' + sections.join(NL + '- ')
      : '';

  // Rules are repeated immediately before the document on purpose: after reading
  // 40 KB of code, the rules at the top of the window are far away.
  const tail =
    NL + NL + 'Before you answer, re-check against these, in this order:' + NL +
    '- the pl-plan block is still present, valid JSON, and matches the code' + NL +
    '- every section marker from the plan still exists' + NL +
    '- PlayLoop.ready() is called, and the first input starts the simulation' + NL +
    '- score/HUD stays inside PlayLoop.safeArea' + NL +
    '- no fetch, XHR, localStorage, alert, window.open; only /a/ and /r/ references' + NL +
    '- the defects above are gone and nothing already fixed is back';

  const prompt =
    'The following HTML5 game artifact failed validation with these errors:' + NL + '- ' + errorsText +
    runtimeText + planBlock + journalBlock + sectionBlock + tail +
    NL + NL + 'Return the complete corrected document:' + NL + NL + currentCode;

  const response = await provider.generateText(prompt, {
    systemPrompt: REPAIR_SYSTEM_PROMPT,
    temperature: 0.2,
  });

  return extractHtmlArtifact(response);
}
