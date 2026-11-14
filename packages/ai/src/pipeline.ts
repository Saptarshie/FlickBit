import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RUNTIMES, resolveRuntime } from '@playloop/sdk';
import { stampRuntime, validateGame, type ValidationResult } from '@playloop/gamekit';
import { designGame } from './design';
import { generateCode, type GenerateOptions } from './generator';
import { reviewVisual, visualDefects, type VisualReview } from './visual';
import { extractManifest } from '@playloop/gamekit';
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
/**
 * The asset vocabulary, read from the play origin's index (or the local copy).
 * Deliberately small: the coder sees a list it can hold in its head, not a
 * catalogue of 50,000 files.
 */
async function loadAssetCatalogue(): Promise<
  Array<{ id: string; kind: string; width?: number; height?: number; file: string; tags: string[] }>
> {
  // The Next server runs with its own cwd (apps/web), the worker with another,
  // and tests with a third. Walk up from wherever we are instead of guessing.
  const roots: string[] = [process.cwd()];
  for (let dir = process.cwd(), i = 0; i < 5; i += 1) {
    dir = path.resolve(dir, '..');
    roots.push(dir);
  }
  const candidates = [
    process.env.ASSETS_INDEX,
    ...roots.flatMap((root) => [path.join(root, 'apps', 'play-worker', 'assets', 'index.json'), path.join(root, 'assets', 'index.json')]),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { assets?: Array<Record<string, unknown>> };
      return (parsed.assets ?? [])
        .filter((a) => typeof a['file'] === 'string' && typeof a['id'] === 'string')
        .map((a) => ({
          id: String(a['id']),
          kind: String(a['kind'] ?? 'sprite'),
          ...(typeof a['width'] === 'number' ? { width: a['width'] } : {}),
          ...(typeof a['height'] === 'number' ? { height: a['height'] } : {}),
          file: String(a['file']),
          tags: Array.isArray(a['tags']) ? (a['tags'] as string[]) : [],
        }));
    } catch {
      // try the next location
    }
  }
  return [];
}

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

  // The catalogue is read once per build: the coder needs a fixed vocabulary it
  // can hold in its head, not a catalogue of 50,000 files.
  const catalogue = await loadAssetCatalogue();
  const codeOptions: GenerateOptions = {
    baseCode,
    isRemix,
    isEdit,
    design,
    history,
    imageDataUrl,
    ...(catalogue.length > 0 ? { assetCatalogue: catalogue } : {}),
  };
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

  // Stage 5b: the catalogue exists to be used. A model that ignores it ships the
  // same dark-green dot we were trying to get rid of, so ask once, narrowly.
  if (catalogue.length > 0 && !/\/a\/[0-9a-f]{16}\.(?:webp|png|ogg)/.test(code)) {
    reportProgress({ stage: 'repairing', message: 'Adding sprites from the catalogue...', progressPercent: 80 });
    const pick = catalogue.slice(0, 6).map((a) => `${a.id} (${a.kind}, /a/${a.file})`).join(', ');
    code = await repairCode(
      code,
      { ok: false, errors: [`[assets] the game draws no catalogue asset; use at least one of: ${pick}`], warnings: [] } as unknown as ValidationResult,
      provider,
      [`Use at least one catalogue sprite as the player or a gameplay object. Candidates: ${pick}.`,
       'Load it with const img = new Image(); img.src = "/a/<file>"; draw only after onload, and declare it in the manifest assets array.'],
    );
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

  // Stage 5c: visual review — the only gate that looks at the game.
  // Screenshots go to the multimodal model; critical findings (unreadable
  // player, HUD under the app chrome, screen contradicting the description) get
  // one repair pass. A missing opinion never blocks a build.
  let visual: VisualReview | null = null;
  if (options.capture) {
    reportProgress({ stage: 'visual', message: 'Looking at the game the way a player will...', progressPercent: 84 });
    try {
      const shots = await options.capture(code);
      const manifest = extractManifest(code);
      visual = await reviewVisual({
        shots,
        spec,
        description: manifest?.description,
        provider,
      });
      const blocking = visual?.issues.filter((issue) => issue.severity === 'critical') ?? [];
      if (visual && blocking.length > 0) {
        repairsCount += 1;
        reportProgress({
          stage: 'repairing',
          message: `Fixing what the screenshot shows: ${blocking[0]?.issue ?? ''}`.slice(0, 120),
          progressPercent: 86,
        });
        const feedback = visualDefects(visual);
        code = await repairCode(
          code,
          { ok: false, errors: feedback, warnings: [] } as unknown as ValidationResult,
          provider,
          feedback,
        );
        validateReport = validateGame(code);
      }
    } catch (err) {
      reportProgress({
        stage: 'visual',
        message: `Visual review skipped: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120),
        progressPercent: 86,
      });
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

  // A build that still does not boot after every repair is not shippable. The
  // feed would show a dead card and the player would blame the app, so fail
  // loudly and let the studio offer Retry.
  if (smoke !== null && !smoke.pass) {
    const why = [
      ...smoke.uncaught.slice(0, 2),
      smoke.blankScreen ? 'the first frame renders blank' : '',
      !smoke.interactive ? 'the game does not react to taps' : '',
    ].filter(Boolean).join('; ');
    const err = new Error(`The game does not run after ${repairsCount} repair(s): ${why || 'runtime gate failed'}`);
    reportProgress({ stage: 'failed', message: err.message, progressPercent: 100, error: err.message });
    throw err;
  }

  // Re-stamp the runtime last.
  //
  // Every repair rewrites the whole document, and a QA repair that drops the
  // manifest's runtime block leaves an artifact that never loads its engine — a
  // served page with no Phaser and no Babylon, which looks like a blank game.
  // Stamping after the final repair is the only ordering that survives them.
  code = stampRuntime(code, {
    runtime: runtime.id,
    ...(runtime.id === 'micro' ? {} : { runtimeVersion: RUNTIMES[runtime.id].version }),
  });
  validateReport = validateGame(code);
  if (validateReport.errors.length > 0) {
    const err = new Error(`Artifact became invalid after the final repair: ${validateReport.errors.join('; ')}`);
    reportProgress({ stage: 'failed', message: err.message, progressPercent: 100, error: err.message });
    throw err;
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
    visual,
    timingsMs: timings,
  };
}
