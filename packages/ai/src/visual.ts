/**
 * Visual review — the part the other gates cannot see.
 *
 * The static gate reads code, the smoke gate reads frames-per-second, the
 * playtest reads events. None of them notices that the hero is an eight-pixel
 * stick figure on a black background, that the HUD sits under the app's top bar,
 * or that the description promises a muscle car and the screen shows a person
 * running. A multimodal model looking at one screenshot notices all three.
 *
 * This is a *review*: it never blocks on its own judgement of taste. It blocks
 * on specific, checkable defects — unreadable player, HUD in the safe-area,
 * text over the playfield, a game that does not match its own description.
 */
import type { AiProvider, GameSpec } from './types';

export type VisualIssue = {
  severity: 'critical' | 'major' | 'minor';
  /** Where on screen: 'hud' | 'player' | 'playfield' | 'controls' | 'palette' | 'match'. */
  area: string;
  issue: string;
  fix: string;
};

export type VisualReview = {
  /** 1–10, where 6 is "a stranger would post this". */
  score: number;
  verdict: 'ship' | 'fix';
  /** One sentence a human can read in the studio log. */
  summary: string;
  issues: VisualIssue[];
  /** What the model could actually see, so a wrong review is debuggable. */
  observed?: string;
};

export type VisualReviewInput = {
  /** PNG data URLs: opening screen, mid-run, end state (some may be null). */
  shots: { start: string | null; play: string | null; over: string | null };
  spec: GameSpec;
  /** The description the player will read on the card. */
  description?: string;
  provider: AiProvider;
};

const SYSTEM = `You are the art director of a mobile short-game feed, reviewing a screenshot of a game before it is published.

You are looking at a 390x844 portrait phone screen. The app draws its own chrome on top: a profile row at the very top (~72px), a status pill under it, and a vertical rail of icons on the right (~64px wide, from ~30% to ~75% of the height). Anything the game draws under those is effectively hidden.

Judge these, in order of how much they hurt:
1. PLAYER — can you find the player in under half a second, at phone size, on a busy background? Is it distinguishable from enemies, pickups and the floor?
2. HUD — score/timer/lives legible, not colliding with the top ~72px or the right rail, not drawn over the playfield's action.
3. PLAYFIELD — does it use the screen? A wide empty band with a tiny strip of action is a wasted card.
4. MATCH — does the screen show what the description promises (a car, a hero, a world)? A mismatch is a trust bug, not a taste issue.
5. AFFORDANCE — is it obvious what to touch? For a one-thumb game the whole lower area should look tappable, and any hint text must be readable.
6. PALETTE — coherent, sufficient contrast between the player and the background. Neon on black is fine; a dark green dot on black is not.
7. POLISH — obvious visual bugs: stray debug text, misaligned HUD, text overflowing, unlit black areas.

Severity:
- "critical": a player cannot tell what is happening, cannot find their character, or the screen contradicts the description. These block publishing.
- "major": visible quality problem a stranger would comment on (dead space, HUD collision, unreadable hint).
- "minor": polish a reviewer would note but ship anyway.

Be specific and actionable in "fix" — name the element, the position, the colour. "Make it better" is useless.

Respond ONLY with JSON:
{"score":1-10,"verdict":"ship"|"fix","summary":"one sentence","observed":"what you actually see, 1-2 sentences","issues":[{"severity":"critical|major|minor","area":"hud|player|playfield|controls|palette|match","issue":"...","fix":"..."}]}

Score honestly: 8–10 is publish-ready, 6–7 is decent with flaws, 4–5 is visibly unfinished, 1–3 is broken.`;

export async function reviewVisual(input: VisualReviewInput): Promise<VisualReview | null> {
  const images = [input.shots.start, input.shots.play, input.shots.over].filter(
    (shot): shot is string => typeof shot === 'string' && shot.length > 0,
  );
  if (images.length === 0) return null;

  // Number the images we actually sent, in order. Mis-numbering made the model
  // describe "shot 1" when only two images existed and report a defect that was
  // not on screen.
  const kinds = [
    input.shots.start ? 'the opening screen, before any input' : '',
    input.shots.play ? 'mid-run, after several taps' : '',
    input.shots.over ? 'the end state, after the game ended' : '',
  ].filter(Boolean);
  const labels = kinds.map((kind, i) => `Screenshot ${i + 1} of ${kinds.length}: ${kind}`);

  const prompt = [
    `The creator asked for: "${input.spec.concept}"`,
    `The card will say: "${input.description ?? input.spec.title}"`,
    `Core mechanic: ${input.spec.coreMechanic}`,
    `Controls: ${input.spec.controls}`,
    input.spec.runtime ? `Engine: ${input.spec.runtime}` : '',
    '',
    ...labels,
    'Only report what is visible in these exact images. If you cannot see a detail, do not call it a defect.',
    'The canvas is exactly 390x844 CSS pixels; estimate positions in that space (x=0 is the left edge, y=0 the top).',
    'A sprite is only "clipped" if its visible pixels are cut off by the canvas edge. Being near an edge is not clipping.',
    'Never describe a screenshot that was not sent: there are exactly ' + images.length + '.',
    'Review them as a whole — a game can look fine on the opening screen and collapse in play.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const raw = await input.provider.generateText(prompt, {
      systemPrompt: SYSTEM,
      temperature: 0.2,
      images,
    });
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as Partial<VisualReview>;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues
          .filter((i): i is VisualIssue => Boolean(i) && typeof i.issue === 'string')
          .map((i): VisualIssue => ({
            severity: i.severity === 'critical' || i.severity === 'major' ? i.severity : 'minor',
            area: typeof i.area === 'string' ? i.area : 'playfield',
            issue: String(i.issue),
            fix: String(i.fix ?? ''),
          }))
      : [];
    const score = Math.max(1, Math.min(10, Math.round(Number(parsed.score) || 5)));
    const critical = issues.some((i) => i.severity === 'critical');
    return {
      score,
      verdict: parsed.verdict === 'ship' && !critical ? 'ship' : 'fix',
      summary: String(parsed.summary ?? ''),
      issues,
      ...(typeof parsed.observed === 'string' ? { observed: parsed.observed } : {}),
    };
  } catch {
    // A failed visual review is not a failed build: it is a missing opinion.
    return null;
  }
}

/** Defect strings for the repair loop — same shape the other gates produce. */
export function visualDefects(review: VisualReview | null): string[] {
  if (!review) return [];
  return review.issues
    .filter((issue) => issue.severity === 'critical' || issue.severity === 'major')
    .slice(0, 5)
    .map((issue) => `[visual/${issue.area}] ${issue.issue} -> ${issue.fix}`);
}
