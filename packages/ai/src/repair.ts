import type { ValidationResult } from '@playloop/gamekit';
import { REPAIR_SYSTEM_PROMPT } from './prompts';
import { extractHtmlArtifact } from './generator';
import type { AiProvider } from './types';

export async function repairCode(
  currentCode: string,
  report: ValidationResult,
  provider: AiProvider
): Promise<string> {
  const errorsText = report.errors.join('\n- ');
  const prompt = `The following HTML5 game artifact failed validation rules with these errors:\n- ${errorsText}\n\nFix all security and validation issues so it complies with sandbox requirements:\n\n${currentCode}`;

  const response = await provider.generateText(prompt, {
    systemPrompt: REPAIR_SYSTEM_PROMPT,
    temperature: 0.2,
  });

  return extractHtmlArtifact(response);
}
