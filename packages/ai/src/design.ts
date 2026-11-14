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

ART DIRECTION IS NOT A DEFAULT
The platform's feed already contains many dark, glowing, neon/synthwave cards. Do not
add another one unless the concept asks for it. Choose a specific visual identity that
comes from the CONCEPT — e.g. sun-baked paper cut-outs, clay/plasticine, 1970s print,
pastel sticker book, hospital-clean minimal, art-deco, chunky 8-bit, watercolour,
industrial hazard signage, toy-box primary. Name the style in visualIdentity, and give
the palette that style actually uses. Never title a game "Neon …" unless the brief says
neon: the model's own prior is not a design decision.

ASSETS
The platform serves a real catalogue on the frame's origin: sprites and tiles at /a/,
and 3D models (.glb) for 3D games. If an ASSET SHORTLIST is provided, build the
visual plan around it: say which sprite is the player, which is the enemy, and what
still has to be drawn procedurally. Never invent a file name.

Rules: anything not served by the catalogue is drawn procedurally with Canvas 2D (no
fonts, no network, no external images). Colours must be valid hex. Be specific with
numbers — px, ms, speed multipliers, particle counts.`;

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
  assetCatalogue?: Array<{ id: string; kind: string; file: string; category?: string }>,
): Promise<GameDesign> {
  // The art director is the only stage that can say "use the knight model for the
  // player and the castle wall for the ground" before the coder writes a line.
  const assetBlock =
    assetCatalogue && assetCatalogue.length > 0
      ? [
          'ASSET SHORTLIST (real files, served at /a/):',
          ...assetCatalogue
            .slice(0, 16)
            .map((a) => `- ${a.id} [${a.category ?? a.kind}] /a/${a.file}`),
        ].join('\n')
      : 'ASSET SHORTLIST: none for this brief — everything is drawn procedurally.';
  const fallback: GameDesign = {
    visualIdentity: `${spec.concept}. A named style chosen from the concept, not the default glow: flat shapes, one accent colour carrying the player.`,
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
      assetBlock,
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
