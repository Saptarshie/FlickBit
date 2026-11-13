import { PLANNER_SYSTEM_PROMPT } from './prompts';
import type { AiProvider, GameSpec } from './types';

const KNOWN_TEMPLATES = [
  'tap-runner',
  'flappy',
  'snake',
  'brick-breaker',
  'match-3',
  'memory',
  'shooter',
  'physics-toss',
] as const;

export async function planGame(
  prompt: string,
  provider: AiProvider,
  preferredTemplateId?: string
): Promise<GameSpec> {
  try {
    const userPrompt = `Create a specification for this game idea:
"${prompt}"
${preferredTemplateId ? `Preferred base archetype: ${preferredTemplateId}` : ''}`;
    const responseText = await provider.generateText(userPrompt, {
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      temperature: 0.7,
    });

    const cleaned = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const templateId =
      preferredTemplateId ||
      (KNOWN_TEMPLATES.includes(parsed.templateId) ? parsed.templateId : pickTemplateFromPrompt(prompt));

    // Phaser is the default: its warm-started cost is paid once per session
    // and it lifts the ceiling on what a generated game can be. The planner may
    // wave it for games where an engine adds nothing (grid puzzles, memory,
    // turn-based, tap-timing), and invalid answers fall back to the default.
    // micro and babylon are explicit choices; anything else (including a typo or
    // a model that invents an engine) falls back to the default.
    const runtime =
      parsed.runtime === 'micro' ? 'micro' : parsed.runtime === 'babylon' ? 'babylon' : 'phaser4';

    return {
      title: String(parsed.title || 'PlayLoop Game'),
      runtime,
      runtimeReason: parsed.runtimeReason ? String(parsed.runtimeReason) : undefined,
      concept: String(parsed.concept || prompt),
      genre: String(parsed.genre || 'arcade'),
      templateId,
      coreMechanic: String(parsed.coreMechanic || 'Tap or drag to interact'),
      controls: String(parsed.controls || 'Tap to play'),
      palette: Array.isArray(parsed.palette) ? parsed.palette.map(String) : ['#6366f1', '#ec4899', '#3b82f6', '#10b981', '#f59e0b'],
      winCondition: parsed.winCondition ? String(parsed.winCondition) : undefined,
      loseCondition: String(parsed.loseCondition || 'Game over on collision'),
      audioNotes: parsed.audioNotes ? String(parsed.audioNotes) : undefined,
    };
  } catch {
    // Fallback on JSON parse error
    const templateId = preferredTemplateId || pickTemplateFromPrompt(prompt);
    return {
      title: prompt.slice(0, 30).trim() || 'Custom Game',
      runtime: 'phaser4',
      concept: prompt,
      genre: 'arcade',
      templateId,
      coreMechanic: 'Interact to survive and earn points',
      controls: 'Tap or drag',
      palette: ['#0f172a', '#38bdf8', '#fb7185', '#34d399', '#fde047'],
      loseCondition: 'Game over when lives reach 0',
    };
  }
}

function pickTemplateFromPrompt(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes('flap') || p.includes('bird')) return 'flappy';
  if (p.includes('snake') || p.includes('worm')) return 'snake';
  if (p.includes('brick') || p.includes('break') || p.includes('pong')) return 'brick-breaker';
  if (p.includes('match') || p.includes('candy') || p.includes('gem')) return 'match-3';
  if (p.includes('memory') || p.includes('card') || p.includes('flip')) return 'memory';
  if (p.includes('shoot') || p.includes('space') || p.includes('laser')) return 'shooter';
  if (p.includes('toss') || p.includes('throw') || p.includes('sling') || p.includes('angry')) return 'physics-toss';
  return 'tap-runner';
}
