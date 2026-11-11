import type { ValidationResult } from '@playloop/gamekit';
import { REPAIR_SYSTEM_PROMPT } from './prompts';
import { extractHtmlArtifact } from './generator';
import type { AiProvider } from './types';

/** Keeps the prompt readable without embedding raw newlines in string literals. */
const NL = String.fromCharCode(10);

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
): Promise<string> {
  const errorsText = report.errors.join(NL + '- ');
  const runtimeText =
    runtimeDefects.length > 0
      ? NL + NL +
        'It also failed at runtime or review:' + NL + '- ' + runtimeDefects.join(NL + '- ') + NL +
        'Fix these too: a game that throws, freezes or never reacts is not shippable.'
      : '';

  const prompt =
    'The following HTML5 game artifact failed validation with these errors:' + NL + '- ' + errorsText +
    runtimeText + NL + NL +
    'Fix all of them while keeping the game playable and visually intact. Return the complete corrected document:' +
    NL + NL + currentCode;

  const response = await provider.generateText(prompt, {
    systemPrompt: REPAIR_SYSTEM_PROMPT,
    temperature: 0.2,
  });

  return extractHtmlArtifact(response);
}
