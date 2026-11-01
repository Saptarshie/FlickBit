import { TEMPLATES } from '@playloop/gamekit';
import { CODER_SYSTEM_PROMPT } from './prompts';
import type { AiProvider, GameSpec } from './types';

export function extractHtmlArtifact(raw: string): string {
  const fenced = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  const htmlTagMatch = raw.match(/(<!DOCTYPE[\s\S]*<\/html>|<html[\s\S]*<\/html>)/i);
  if (htmlTagMatch && htmlTagMatch[1]) {
    return htmlTagMatch[1].trim();
  }
  return raw.trim();
}

export async function generateCode(
  userPrompt: string,
  spec: GameSpec,
  provider: AiProvider,
  options: { baseCode?: string; isRemix?: boolean } = {}
): Promise<string> {
  if (options.isRemix && options.baseCode) {
    const remixPrompt = `Remix and modify this existing HTML5 game:\n\nPrompt: ${userPrompt}\n\nBase Code:\n${options.baseCode}`;
    const response = await provider.generateText(remixPrompt, {
      systemPrompt: CODER_SYSTEM_PROMPT,
      temperature: 0.7,
    });
    return extractHtmlArtifact(response);
  }

  const template = TEMPLATES.find((t) => t.id === spec.templateId) || TEMPLATES[0];
  const promptWithSpec = `Create a complete mobile-first HTML5 game based on this specification:\n\nConcept: ${spec.concept}\nArchetype: ${spec.templateId}\nMechanics: ${spec.coreMechanic}\nControls: ${spec.controls}\nPalette: ${spec.palette.join(', ')}\nLoss Condition: ${spec.loseCondition}\n\nReference Archetype Code:\n${template?.code || ''}`;

  const response = await provider.generateText(promptWithSpec, {
    systemPrompt: CODER_SYSTEM_PROMPT,
    temperature: 0.7,
  });

  return extractHtmlArtifact(response);
}
