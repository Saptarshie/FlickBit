import { PERFORMANCE_RULES, QUALITY_BAR } from './playbook';
import type { AiProvider, GameDesign, GameSpec, ReviewIssue, ReviewReport, SmokeSummary } from './types';

export const REVIEW_SYSTEM_PROMPT = `You are a senior QA engineer and game designer reviewing a generated HTML5 game before it ships to players on a phone. You do not rewrite the game; you find what is wrong and say exactly how to fix it.

${QUALITY_BAR}

${PERFORMANCE_RULES}

Judge it as a consumer would, on a 390x844 phone, with one thumb:
- Can you tell what to do within 2 seconds of the start screen?
- Does the first input respond immediately?
- Is the playfield readable (player vs hazards vs background)?
- Is there a difficulty ramp, or is it flat / unfair at t=0?
- Does dying feel fair, and does restart work without a reload?
- Any console errors, frozen frames, NaN-prone maths, or per-frame allocations?

Respond ONLY with JSON:
{
  "verdict": "ship" | "revise",
  "summary": "one sentence",
  "issues": [
    { "severity": "critical" | "major" | "minor", "issue": "what is wrong, concretely", "fix": "the exact change, with numbers where relevant" }
  ]
}

Severity guide: critical = the game is broken or unplayable (throw, freeze, input dead, no restart). major = it works but feels bad or is unfair (no feedback, no ramp, unreadable). minor = polish. If you find nothing that matters, return "ship" with an empty list.`;

/**
 * QA critique pass: reads the code plus the runtime report (fps, blank screen,
 * console errors) and returns ordered defects.
 *
 * The runtime report is the objective half of the review — the model cannot see
 * the pixels unless the caller enables vision, so the numbers are always given.
 */
export async function reviewGame(input: {
  code: string;
  spec: GameSpec;
  design?: GameDesign;
  smoke?: SmokeSummary | null;
  provider: AiProvider;
  screenshotDataUrl?: string;
}): Promise<ReviewReport> {
  const { code, spec, design, smoke, provider, screenshotDataUrl } = input;

  const runtime = smoke
    ? [
        `Smoke test: ${smoke.pass ? 'PASS' : 'FAIL'} at ${smoke.fps} fps`,
        `blank screen: ${smoke.blankScreen}`,
        `interactive: ${smoke.interactive}`,
        smoke.consoleErrors.length ? `console errors: ${smoke.consoleErrors.slice(0, 5).join(' | ')}` : 'console errors: none',
        smoke.uncaught.length ? `uncaught: ${smoke.uncaught.slice(0, 3).join(' | ')}` : 'uncaught: none',
      ].join('\n')
    : 'Smoke test: not run';

  const brief = design
    ? [
        `Visual identity: ${design.visualIdentity}`,
        `Palette: ${design.palette.join(', ')}`,
        `HUD: ${design.hud.join('; ')}`,
        `Juice: small=${design.juice.small}; medium=${design.juice.medium}; large=${design.juice.large}`,
        `Difficulty: ${design.difficulty}`,
      ].join('\n')
    : 'No design brief.';

  const user = [
    `Concept: ${spec.concept}`,
    `Mechanics: ${spec.coreMechanic}`,
    `Controls: ${spec.controls}`,
    brief,
    runtime,
    screenshotDataUrl ? 'A screenshot of the running game is attached.' : '',
    'The complete game source follows between the fences.',
    '```html',
    code,
    '```',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const raw = await provider.generateText(user, {
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      temperature: 0.3,
      images: screenshotDataUrl ? [screenshotDataUrl] : undefined,
    });
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as Partial<ReviewReport>;

    const rawIssues: unknown[] = Array.isArray(parsed.issues) ? (parsed.issues as unknown[]) : [];
    const issues: ReviewIssue[] = rawIssues
      .map((rawIssue) => {
        const item = rawIssue as { severity?: unknown; issue?: unknown; fix?: unknown };
        if (typeof item?.issue !== 'string') return null;
        const candidate = String(item.severity);
        const severity: ReviewIssue['severity'] =
          candidate === 'critical' || candidate === 'major' || candidate === 'minor' ? candidate : 'minor';
        return { severity, issue: item.issue, fix: typeof item.fix === 'string' ? item.fix : '' };
      })
      .filter((issue): issue is ReviewIssue => issue !== null)
      .slice(0, 12);

    return {
      verdict: parsed.verdict === 'revise' || issues.some((i) => i.severity === 'critical') ? 'revise' : 'ship',
      issues,
      summary: String(parsed.summary ?? ''),
    };
  } catch (err) {
    // A failed review must not fail the generation.
    return {
      verdict: 'ship',
      issues: [],
      summary: `review unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
