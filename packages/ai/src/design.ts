import { GAME_FEEL_RULES, MOBILE_RULES, PERFORMANCE_RULES } from './playbook';
import type { AiProvider, GameDesign, GameSpec } from './types';

export const ART_DIRECTOR_SYSTEM_PROMPT = `You are the art director and systems designer on a small game team. You do not write code. You produce the brief the programmer builds to.

You are given a game concept and its mechanics. Return a design that a competent programmer can implement without further questions.

${GAME_FEEL_RULES}

${MOBILE_RULES}

${PERFORMANCE_RULES}

Respond ONLY with JSON:
{
  "visualIdentity": "two sentences: art direction, silhouette language, what makes the screen readable at a glance",
  "palette": ["#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB"],
  "hud": ["score top-centre", "best score under score", "lives as three dots bottom-left"],
  "assetPlan": ["player: rounded blob with 2 eyes, 40px", "obstacle: hexagon, 3 sizes", "background: parallax skyline, 2 layers, blitted from an offscreen canvas"],
  "juice": { "small": "...", "medium": "...", "large": "..." },
  "difficulty": "how speed/spawn scales with score, and the exact ramp numbers",
  "performanceNotes": ["pool 150 particles", "cache background offscreen", "no gradients per frame"],
  "failureModes": ["what must never happen: NaN radius, input blocked >150ms, unfair first second"]
}

Rules: every asset is drawn procedurally with Canvas 2D (no images, no fonts, no network). Colours must be valid hex. Be specific with numbers — px, ms, speed multipliers, particle counts.`;

/**
 * Art-director stage. Turns a spec into a buildable design brief.
 *
 * Failures are non-fatal: a game without a brief is still better than no game,
 * so the caller gets a sensible default instead of an exception.
 */
export async function designGame(
  prompt: string,
  spec: GameSpec,
  provider: AiProvider,
  imageDataUrl?: string,
): Promise<GameDesign> {
  const fallback: GameDesign = {
    visualIdentity: `${spec.concept}. Clean geometric shapes on a dark field, one accent colour for the player.`,
    palette: spec.palette.length >= 3 ? spec.palette.slice(0, 5) : ['#0b1020', '#7b5cff', '#ff3b8d', '#38bdf8', '#fbbf24'],
    hud: ['score top-centre', 'best score smaller under it'],
    assetPlan: ['player: layered shapes with a glow', 'hazards: simple polygons, 3 sizes', 'background: two parallax layers'],
    juice: {
      small: 'tick sound + 5 particles',
      medium: 'hit sound + 10 particles + 60ms hit-stop',
      large: 'boom + 30 particles + 120ms hit-stop + screen shake',
    },
    difficulty: 'speed and spawn rate increase with score, capped so a first-time player survives the first 10 seconds',
    performanceNotes: ['pool particles', 'cache background', 'no per-frame gradients'],
    failureModes: ['non-finite radius passed to a canvas API', 'input blocked during feedback'],
  };

  try {
    const user = [
      `Concept: ${spec.concept}`,
      `Mechanics: ${spec.coreMechanic}`,
      `Controls: ${spec.controls}`,
      `Genre: ${spec.genre} (archetype: ${spec.templateId})`,
      `Win: ${spec.winCondition ?? 'survive and score'}`,
      `Lose: ${spec.loseCondition}`,
      spec.audioNotes ? `Audio direction: ${spec.audioNotes}` : '',
      `Player's own words: "${prompt}"`,
      imageDataUrl ? 'A concept image is attached: match its palette, mood and subject.' : '',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await provider.generateText(user, {
      systemPrompt: ART_DIRECTOR_SYSTEM_PROMPT,
      temperature: 0.8,
      images: imageDataUrl ? [imageDataUrl] : undefined,
    });

    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as Partial<GameDesign>;

    return {
      visualIdentity: String(parsed.visualIdentity ?? fallback.visualIdentity),
      palette:
        Array.isArray(parsed.palette) && parsed.palette.length >= 3
          ? parsed.palette.map(String).slice(0, 6)
          : fallback.palette,
      hud: Array.isArray(parsed.hud) && parsed.hud.length ? parsed.hud.map(String) : fallback.hud,
      assetPlan: Array.isArray(parsed.assetPlan) && parsed.assetPlan.length ? parsed.assetPlan.map(String) : fallback.assetPlan,
      juice:
        parsed.juice && typeof parsed.juice === 'object'
          ? {
              small: String(parsed.juice.small ?? fallback.juice.small),
              medium: String(parsed.juice.medium ?? fallback.juice.medium),
              large: String(parsed.juice.large ?? fallback.juice.large),
            }
          : fallback.juice,
      difficulty: String(parsed.difficulty ?? fallback.difficulty),
      performanceNotes:
        Array.isArray(parsed.performanceNotes) && parsed.performanceNotes.length
          ? parsed.performanceNotes.map(String)
          : fallback.performanceNotes,
      failureModes:
        Array.isArray(parsed.failureModes) && parsed.failureModes.length
          ? parsed.failureModes.map(String)
          : fallback.failureModes,
    };
  } catch {
    return fallback;
  }
}
