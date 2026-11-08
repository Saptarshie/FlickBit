import { TEMPLATES } from '@playloop/gamekit';
import { CODER_SYSTEM_PROMPT } from './prompts';
import type { AiProvider, GameSpec } from './types';

/**
 * Pull the HTML document out of a model response.
 *
 * Models wrap the artifact inconsistently: a ```html fence, a bare ``` fence, a
 * `<!DOCTYPE>` with chatter before it, or a fence that never closes because the
 * completion was cut short. Strategy, most specific first:
 *   1. a complete fenced block
 *   2. an unterminated fence -> everything after it
 *   3. <!DOCTYPE ... </html> / <html ... </html>
 *   4. from <!DOCTYPE (or <html) to end of string (truncated output)
 * Anything else is returned trimmed so validation (not this function) decides.
 */
export function extractHtmlArtifact(raw: string): string {
  const completeFence = raw.match(/```(?:html|HTML)?\s*([\s\S]*?)```/);
  if (completeFence?.[1]?.trim()) return completeFence[1].trim();

  const openFence = raw.match(/```(?:html|HTML)?\s*([\s\S]*)$/);
  if (openFence?.[1]?.trim() && /<!doctype|<html/i.test(openFence[1])) {
    return openFence[1].trim();
  }

  const htmlTagMatch = raw.match(/(<!DOCTYPE[\s\S]*<\/html>|<html[\s\S]*<\/html>)/i);
  if (htmlTagMatch?.[1]) return htmlTagMatch[1].trim();

  const doctypeStart = raw.search(/<!doctype\s+html/i);
  if (doctypeStart !== -1) return raw.slice(doctypeStart).trim();
  const htmlStart = raw.search(/<html[\s>]/i);
  if (htmlStart !== -1) return raw.slice(htmlStart).trim();

  return raw.trim();
}

/** Strip a duplicate DOCTYPE that a truncated fence may leave behind. */
function normalizeDocument(html: string): string {
  const doctype = html.search(/<!doctype\s+html/i);
  if (doctype > 0) return html.slice(doctype);
  return html;
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
    return normalizeDocument(extractHtmlArtifact(response));
  }

  const template = TEMPLATES.find((t) => t.id === spec.templateId) || TEMPLATES[0];
  const promptWithSpec = `Create a complete mobile-first HTML5 game based on this specification:\n\nConcept: ${spec.concept}\nArchetype: ${spec.templateId}\nMechanics: ${spec.coreMechanic}\nControls: ${spec.controls}\nPalette: ${spec.palette.join(', ')}\nLoss Condition: ${spec.loseCondition}\n\nRules:\n- Start your reply with <!doctype html> — no preamble, no explanation, no markdown fences.\n- One self-contained file under 30 KB (~700 lines). No external URLs, fonts, images or libraries.\n- Keep it DRY: no comments, no duplicated blocks, no placeholder code.\n- Always close every script tag and end with </html>.\n- Show a start screen and wait for the player's first input before the simulation begins; never start moving on load.

Reference Archetype Code:\n${template?.code || ''}`;

  const response = await provider.generateText(promptWithSpec, {
    systemPrompt: CODER_SYSTEM_PROMPT,
    temperature: 0.7,
  });

  return normalizeDocument(extractHtmlArtifact(response));
}
