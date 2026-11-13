import { createHash } from 'node:crypto';
import { RUNTIMES, resolveRuntime } from '@playloop/sdk';
import { stampRuntime, validateGame, type ValidationResult } from '@playloop/gamekit';
import { designGame } from './design';
import { generateCode, type GenerateOptions } from './generator';
import { extractOrGenerateMetadata } from './metadata';
import { planGame } from './planner';
import { repairCode } from './repair';
import { reviewGame } from './review';
import type {
  AiProvider,
  GeneratedGame,
  GenerationOptions,
  GenerationProgress,
  ReviewReport,
  PlaytestSummary,
  SmokeSummary,
} from './types';

/**
 * Multi-agent generation pipeline.
 *
 *  1. planner      -> GameSpec   (what to build)
 *  2. art director -> GameDesign (how it should look and feel; writes no code)
 *  3. coder        -> self-contained HTML built to the brief
 *  4. static gate  -> sandbox/security/manifest validation, repaired until clean
 *  5. runtime gate -> the caller's smoke runner plays it; defects feed a repair
 *  6. QA critic    -> reviews code + runtime report; critical issues feed a repair
 *  7. metadata     -> title/tags/controls
 *
 * Each stage is a separate completion with its own system prompt: that is the
 * "one specialist per role" model the studio exposes. Every stage degrades
 * gracefully — a missing brief or a failed review never blocks the artifact.
 */
export async function runGenerationPipeline(
  options: GenerationOptions,
  provider: AiProvider,
): Promise<GeneratedGame> {
  const {
    prompt,
    templateId,
    baseCode,
    isRemix,
    isEdit,
    history,
    imageDataUrl,
    onProgress,
    maxRepairs = 3,
  } = options;

  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  let stageStart = startedAt;

  const reportProgress = (progress: GenerationProgress) => {
    const now = Date.now();
    const previous = (progress as GenerationProgress & { stage?: string }).stage;
    if (previous) {
      // Attribute the time since the last transition to the stage we just left.
      timings[lastStage] = (timings[lastStage] ?? 0) + (now - stageStart);
      stageStart = now;
      lastStage = previous;
    }
    onProgress?.(progress);
  };
  let lastStage = 'start';

  // Stage 1: plan. A follow-up reuses the existing spec (see GenerationOptions.spec).
  let spec = options.spec;
  if (!spec) {
    reportProgress({ stage: 'spec', message: 'Planning mechanics and win/lose conditions...', progressPercent: 8 });
    spec = await planGame(prompt, provider, templateId);
  }

  // Stage 2: art direction. Skipped for follow-up edits: the design exists.
  let design: GeneratedGame['design'];
  // A remix gets a fresh visual identity even though it starts from a build;
  // a plain follow-up keeps the brief it was made with.
  if ((!baseCode || isRemix) && !options.skipDesign) {
    reportProgress({
      stage: 'design',
      message: 'Art director is writing the visual and juice brief...',
      progressPercent: 18,
    });
    design = await designGame(prompt, spec, provider, imageDataUrl);
  }

  // Stage 3: code
  reportProgress({
    stage: 'generating',
    message: baseCode ? 'Applying your change to the current build...' : `Synthesizing game (${spec.templateId})...`,
    progressPercent: 30,
  });

  const codeOptions: GenerateOptions = { baseCode, isRemix, isEdit, design, history, imageDataUrl };
  let code = await generateCode(prompt, spec, provider, codeOptions);

  // The engine is chosen by the planner and stamped by the platform: the
  // manifest is rewritten, never dictated by the model, and `micro` (the
  // default) stays implicit so older artifacts stay byte-comparable.
  const runtime = resolveRuntime(spec.runtime);
  code = stampRuntime(code, {
    runtime: runtime.id,
    ...(runtime.id === 'micro' ? {} : { runtimeVersion: RUNTIMES[runtime.id].version }),
  });

  // Stage 4: static validation + repair
  reportProgress({ stage: 'validating', message: 'Checking sandbox safety and completeness...', progressPercent: 55 });
  let validateReport: ValidationResult = validateGame(code);
  let repairsCount = 0;

  while (validateReport.errors.length > 0 && repairsCount < maxRepairs) {
    repairsCount += 1;
    reportProgress({
      stage: 'repairing',
      message: `Fixing structural problems (attempt ${repairsCount}/${maxRepairs})...`,
      progressPercent: 55 + repairsCount * 4,
    });
    code = await repairCode(code, validateReport, provider);
    validateReport = validateGame(code);
  }

  if (validateReport.errors.length > 0) {
    const errors = validateReport.errors.join('; ');
    const err = new Error(`Game artifact validation failed after ${repairsCount} repairs: ${errors}`);
    reportProgress({ stage: 'failed', message: err.message, progressPercent: 100, error: err.message });
    throw err;
  }

  // Stage 5: runtime gate — play it in a real browser.
  let smoke: SmokeSummary | null = null;
  if (options.smoke) {
    const smokeRunner = options.smoke;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      reportProgress({
        stage: 'testing',
        message: attempt === 0 ? 'Playing the build in a headless browser...' : 'Re-testing the fixed build...',
        progressPercent: 70 + attempt * 5,
      });
      smoke = await smokeRunner(code);
      if (smoke.pass) break;

      const defects = [
        ...smoke.uncaught.slice(0, 3),
        ...smoke.consoleErrors.slice(0, 3),
        smoke.blankScreen ? 'the first frame renders blank (nothing visible on screen)' : '',
        smoke.fps < 30 ? `frame rate is only ${smoke.fps} fps` : '',
        !smoke.interactive ? 'the game does not react to taps (frames never change)' : '',
      ].filter(Boolean);

      repairsCount += 1;
      reportProgress({
        stage: 'repairing',
        message: `Fixing runtime defects: ${defects[0] ?? 'unknown'}`.slice(0, 120),
        progressPercent: 76,
      });
      code = await repairCode(code, { ok: false, errors: defects, warnings: [] } as unknown as ValidationResult, provider, defects);
      validateReport = validateGame(code);
      if (validateReport.errors.length > 0) break;
    }
  }

  // Stage 5b: playtest — the difference between "a game" and "a video of a game".
  // The smoke gate proves it renders and reacts; this proves a player can get
  // somewhere: the score moves or the run ends, and a tap after the end starts
  // a new run instead of leaving a dead screen.
  let playtest: PlaytestSummary | null = null;
  if (options.playtest) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      reportProgress({
        stage: 'playtesting',
        message: attempt === 0 ? 'Playing it the way a player would...' : 'Re-playing the fixed build...',
        progressPercent: 80 + attempt * 3,
      });
      playtest = await options.playtest(code);
      if (playtest.pass) break;

      repairsCount += 1;
      reportProgress({
        stage: 'repairing',
        message: `Fixing play defects: ${playtest.defects[0] ?? 'unknown'}`.slice(0, 120),
        progressPercent: 83,
      });
      code = await repairCode(
        code,
        { ok: false, errors: playtest.defects, warnings: [] } as unknown as ValidationResult,
        provider,
        playtest.defects,
      );
      validateReport = validateGame(code);
      if (validateReport.errors.length > 0) break;
    }
  }

  // Stage 6: QA critique — one focused pass on what a player would feel.
  let review: ReviewReport | null = null;
  if (!options.skipReview) {
    reportProgress({
      stage: 'reviewing',
      message: 'QA is reviewing the build against the quality bar...',
      progressPercent: 85,
    });
    review = await reviewGame({ code, spec, design, smoke, provider });

    const critical = review.issues.filter((issue) => issue.severity === 'critical');
    if (critical.length > 0) {
      repairsCount += 1;
      reportProgress({
        stage: 'repairing',
        message: `QA found ${critical.length} blocking issue(s) — fixing: ${critical[0]?.issue ?? ''}`.slice(0, 120),
        progressPercent: 88,
      });
      const feedback = review.issues
        .slice(0, 6)
        .map((issue) => `[${issue.severity}] ${issue.issue} -> ${issue.fix}`);
      code = await repairCode(code, { ok: false, errors: feedback, warnings: [] } as unknown as ValidationResult, provider, feedback);
      validateReport = validateGame(code);
      if (validateReport.errors.length === 0 && options.smoke) {
        try {
          smoke = await options.smoke(code);
        } catch {
          /* keep the last known runtime report */
        }
      }
    }
  }

  // Stage 7: metadata
  reportProgress({ stage: 'metadata', message: 'Naming the game and extracting tags...', progressPercent: 92 });
  const metadata = await extractOrGenerateMetadata(code, spec, provider);

  const bytes = Buffer.from(code, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  reportProgress({ stage: 'done', message: 'Game generated and ready to play!', progressPercent: 100 });

  return {
    code,
    sha256,
    bytes: bytes.byteLength,
    spec,
    metadata,
    validateReport,
    repairsCount,
    design,
    smoke,
    review,
    playtest,
    timingsMs: timings,
  };
}
