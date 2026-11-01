import { extractManifest } from '@playloop/gamekit';
import { METADATA_SYSTEM_PROMPT } from './prompts';
import type { AiProvider, GameMetadata, GameSpec } from './types';

export async function extractOrGenerateMetadata(
  code: string,
  spec: GameSpec,
  provider?: AiProvider
): Promise<GameMetadata> {
  // 1. Check embedded manifest
  const embedded = extractManifest(code);
  if (embedded && embedded.title) {
    return {
      title: embedded.title,
      description: embedded.description || spec.concept || `Play ${embedded.title} on PlayLoop.`,
      tags: embedded.tags && embedded.tags.length > 0 ? embedded.tags : [spec.genre || 'arcade', spec.templateId],
      controls: embedded.controls || spec.controls || 'Tap or drag to play',
      orientation: embedded.orientation || 'portrait',
    };
  }

  // 2. If provider is available, generate
  if (provider) {
    try {
      const prompt = `Generate metadata for this game titled "${spec.title}":\nConcept: ${spec.concept}\nGenre: ${spec.genre}\nControls: ${spec.controls}`;
      const resp = await provider.generateText(prompt, {
        systemPrompt: METADATA_SYSTEM_PROMPT,
        temperature: 0.5,
      });
      const cleaned = resp.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return {
        title: String(parsed.title || spec.title),
        description: String(parsed.description || spec.concept),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [spec.genre, spec.templateId],
        controls: String(parsed.controls || spec.controls),
        orientation: parsed.orientation === 'landscape' ? 'landscape' : 'portrait',
      };
    } catch {
      // Fall through
    }
  }

  // 3. Fallback to spec
  return {
    title: spec.title || 'PlayLoop Game',
    description: spec.concept || 'A fun mobile game created on PlayLoop.',
    tags: [spec.genre || 'arcade', spec.templateId || 'game'],
    controls: spec.controls || 'Tap or drag to play',
    orientation: 'portrait',
  };
}
