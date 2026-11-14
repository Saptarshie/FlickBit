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
import { extractPlan, sectionIndex, type RepairNote } from './plan';
import { searchAssets, type AssetRecord } from '@playloop/assets';
import type {
  AiProvider,
  GameSpec,
  GeneratedGame,
  GenerationOptions,
  GenerationProgress,
  ReviewReport,
  PlaytestSummary,
  SmokeSummary,
} from './types';

/**
 * A build can be repaired by five different gates (static, smoke, catalogue,
 * playtest, visual, QA). Each repair rewrites the whole document, the document
 * grows, and past ~6 rewrites the model runs out of output budget mid-file and
 * the build is lost. Cap the total, and keep the last build that passed.
 */
const MAX_TOTAL_REPAIRS = 6;

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
/**
 * Pick the 24 assets a coder should see.
 *
 * The catalogue is real now (158 items after the Kenney import) but a prompt can
 * only carry a couple of dozen. Sending the 24 smallest files would send empty
 * tiles; sending the first 24 would send whatever the filesystem returns first.
 * Rank by what the game actually needs: kind, then tag overlap with the spec, then
 * smaller files (cheaper cards).
 */
function rankCatalogue<T extends { id: string; kind: string; tags: string[]; bytes?: number; category?: string }>(
  catalogue: T[],
  spec: GameSpec,
  limit = 24,
): T[] {
  // Ask the registry, not a hand-rolled sort: it scores name/tag/category matches
  // against the brief and returns the top-k instead of "the first 24 files".
  const query = [spec.title, spec.genre, spec.coreMechanic, spec.concept].filter(Boolean).join(' ');
  // The registry expects name + tags; a caller that only has ids still works.
  const indexed = catalogue.map((a) => ({ name: a.id, ...a })) as unknown as AssetRecord[];
  const ranked = searchAssets({ version: 1, assets: indexed }, { text: query, limit }) as unknown as T[];

  // A 3D brief that only ever sees sprites will draw boxes. Models reach the
  // shortlist by kind, not by matching words the author never wrote.
  if (spec.runtime === 'babylon') {
    const models = catalogue.filter((a) => a.kind === 'model' && !ranked.includes(a)).slice(0, Math.min(8, limit));
    if (models.length > 0) return [...models, ...ranked].slice(0, limit);
  }

  if (ranked.length >= Math.min(limit, catalogue.length)) return ranked;

  // Nothing matched the brief by text: fall back to what the game needs most.
  const weight: Record<string, number> = { sprite: 4, tileset: 3, ui: 2, icon: 2, background: 1, model: 3 };
  const rest = catalogue.filter((a) => !ranked.includes(a));
  rest.sort((a, b) => (weight[b.kind] ?? 0) - (weight[a.kind] ?? 0) || (a.bytes ?? 0) - (b.bytes ?? 0));
  return [...ranked, ...rest].slice(0, limit);
}

async function loadAssetCatalogue(): Promise<
  Array<{ id: string; kind: string; width?: number; height?: number; file: string; tags: string[]; category?: string }>
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
          category: typeof a['category'] === 'string' ? a['category'] : undefined,
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

  // The catalogue is read once per build: design brief and coder prompt share it.
  const catalogue = await loadAssetCatalogue();

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
    // The art director gets the same ranked shortlist the coder will, so its brief
    // can name a sprite instead of describing a shape to draw.
    design = await designGame(prompt, spec, provider, imageDataUrl, catalogue.length > 0 ? rankCatalogue(catalogue, spec, 16) : undefined);
  }

  // Stage 3: code
  reportProgress({
    stage: 'generating',
    message: baseCode ? 'Applying your change to the current build...' : `Synthesizing game (${spec.templateId})...`,
    progressPercent: 30,
  });

  const codeOptions: GenerateOptions = {
    baseCode,
    isRemix,
    isEdit,
    design,
    history,
    imageDataUrl,
    ...(catalogue.length > 0 ? { assetCatalogue: rankCatalogue(catalogue, spec) } : {}),
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
  // What every repair already changed. Passed back so the next repair cannot undo it.
  const journal: RepairNote[] = [];
  const planCtx = () => ({ plan: extractPlan(code), journal, sections: sectionIndex(code) });
  const note = (stage: string, issue: string) =>
    journal.push({ attempt: repairsCount, stage, issue: String(issue ?? '').slice(0, 160) });

  while (validateReport.errors.length > 0 && repairsCount < maxRepairs) {
    repairsCount += 1;
    reportProgress({
      stage: 'repairing',
      message: `Fixing structural problems (attempt ${repairsCount}/${maxRepairs})...`,
      progressPercent: 55 + repairsCount * 4,
    });
    code = await repairCode(code, validateReport, provider, [], planCtx());
    note('static', validateReport.errors[0] ?? 'validation failed');
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
      code = await repairCode(code, { ok: false, errors: defects, warnings: [] } as unknown as ValidationResult, provider, defects, planCtx());
      note('smoke', defects[0] ?? 'runtime defect');
      validateReport = validateGame(code);
      if (validateReport.errors.length > 0) break;
    }
  }

  // Stage 5b: the catalogue exists to be used. A model that ignores it ships the
  // same dark-green dot we were trying to get rid of, so ask once, narrowly.
  // The catalogue exists to be used. Checking the whole document was not enough:
  // a model that merely *declares* four assets in pl-manifest satisfies a regex over
  // the raw file while drawing nothing but shapes. Look for a reference outside the
  // manifest, and prefer one that appears in a load/draw call.
  if (catalogue.length > 0) {
    const manifestBlock = /<script[^>]*id=["']pl-manifest["'][^>]*>[\s\S]*?<\/script>/i.exec(code)?.[0] ?? '';
    const bodyCode = code.replace(manifestBlock, '');
    const referenced = (bodyCode.match(/\/a\/[0-9a-f]{16}\.(?:webp|png|ogg|mp3|glb)/g) ?? []).length;
    const loaded = /(new\s+Image\s*\(|\.load\.(image|spritesheet|audio|atlas|glb)\s*\(|PlayLoop\.(loadImage|loadModel|playSfx)\s*\()/i.test(bodyCode);

    if (referenced === 0 || !loaded) {
      const pick = catalogue.slice(0, 6).map((a) => `${a.id} (${a.kind}, /a/${a.file})`).join(', ');
      reportProgress({ stage: 'repairing', message: 'Making the game actually use its sprites...', progressPercent: 80 });
      code = await repairCode(
        code,
        {
          ok: false,
          errors: [
            referenced === 0
              ? `[assets] the manifest declares assets but the game never references one outside pl-manifest (found ${referenced} /a/ paths in the code)`
              : '[assets] the game references catalogue files but never loads them through an image/texture/sound call',
          ],
          warnings: [],
        } as unknown as ValidationResult,
        provider,
        [
          `Draw at least one catalogue asset in the scene. Candidates: ${pick}.`,
          'Load it (new Image() + img.src = "/a/<file>", or this.load.image / PlayLoop.loadImage / PlayLoop.loadModel) and draw it every frame where the player or a hazard belongs.',
          'A manifest entry with no draw call is a broken promise: the reviewer counts it as an unused asset.',
        ],
        planCtx(),
      );
      repairsCount += 1;
      note('assets', 'assets declared but not drawn');
      validateReport = validateGame(code);
    }
  }

  // A score that only appears on the game-over screen is not a score. If the card
  // claims "higher is better", the HUD has to move while the player plays.
  {
    const manifest = extractManifest(code);
    const bodyCode = code.replace(/<script[^>]*id=["']pl-manifest["'][^>]*>[\s\S]*?<\/script>/i, '');
    if (manifest?.scoring === 'higher' && !/PlayLoop\.submitScore\s*\(/.test(bodyCode) && repairsCount < MAX_TOTAL_REPAIRS) {
      reportProgress({ stage: 'repairing', message: 'Making the score live...', progressPercent: 82 });
      code = await repairCode(
        code,
        {
          ok: false,
          errors: ['[score] scoring is "higher" but PlayLoop.submitScore() is never called: the number on the HUD never updates'],
          warnings: [],
        } as unknown as ValidationResult,
        provider,
        [
          'Call PlayLoop.submitScore(n) every time the score changes (guard with if (window.PlayLoop)).',
          'Keep drawing the score yourself as well: submitScore feeds the platform leaderboard, it does not paint the HUD.',
        ],
        planCtx(),
      );
      repairsCount += 1;
      note('score', 'submitScore never called');
      validateReport = validateGame(code);
    }
  }

  // A 3D card that ships without a model is boxes. If the catalogue has models and
  // the game targets babylon, one .glb must actually be loaded.
  if (spec.runtime === 'babylon') {
    const models = catalogue.filter((a) => a.kind === 'model');
    const bodyCode = code.replace(/<script[^>]*id=["']pl-manifest["'][^>]*>[\s\S]*?<\/script>/i, '');
    const usesModel = /\.glb/.test(bodyCode) && /(loadModel|SceneLoader|ImportMesh|loadAssetContainer)/i.test(bodyCode);
    if (models.length > 0 && !usesModel && repairsCount < MAX_TOTAL_REPAIRS) {
      const pick = models.slice(0, 6).map((a) => `${a.id} (/a/${a.file})`).join(', ');
      reportProgress({ stage: 'repairing', message: 'Placing a 3D model in the scene...', progressPercent: 81 });
      code = await repairCode(
        code,
        {
          ok: false,
          errors: [
            '[3d] the game targets babylon and the catalogue has ' +
              models.length +
              ' models, but no .glb is loaded: the scene is primitives only',
          ],
          warnings: [],
        } as unknown as ValidationResult,
        provider,
        [
          `Load one model with PlayLoop.loadModel(scene, "<file>") and use it as the player or the scenery. Candidates: ${pick}.`,
          'PlayLoop.loadModel resolves the /a/ path, imports through SceneLoader and returns { root, meshes, animationGroups }; position root, not each mesh.',
          'Keep the primitives for what they are good at (collision volumes, HUD-facing markers), but at least one visible object must be the model.',
        ],
        planCtx(),
      );
      repairsCount += 1;
      note('3d', 'no .glb model loaded');
      validateReport = validateGame(code);
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
        planCtx(),
      );
      note('playtest', playtest.defects[0] ?? 'play defect');
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
      // A 3D card is judged against a higher bar than "you can tell what is
      // happening": in a 3D space, a flat untextured plane with the action
      // squeezed into the bottom third is readable and still looks like a
      // prototype. Below 7 it gets one repair pass on its major findings too.
      const floor = spec.runtime === 'babylon' ? 7 : 0;
      const canRepair = repairsCount < MAX_TOTAL_REPAIRS;
      const blocking = visual
        ? visual.issues.filter(
            (issue) =>
              issue.severity === 'critical' || (floor > 0 && visual !== null && visual.score < floor && issue.severity === 'major'),
          )
        : [];
      if (visual && blocking.length > 0 && canRepair) {
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
          planCtx(),
        );
        note('visual', blocking[0]?.issue ?? 'visual defect');
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
    const majors = review.issues.filter((issue) => issue.severity === 'major');
    // 'revise' with several majors is the reviewer saying "this is not good enough",
    // not "this is broken". It earns one pass while the repair budget lasts; a
    // critical issue always earns one.
    const worthRevising = critical.length === 0 && review.verdict === 'revise' && majors.length >= 2 && repairsCount < MAX_TOTAL_REPAIRS;
    if (critical.length > 0 || worthRevising) {
      repairsCount += 1;
      reportProgress({
        stage: 'repairing',
        message: `QA found ${critical.length > 0 ? `${critical.length} blocking issue(s)` : `${majors.length} major issue(s), verdict revise`} — fixing: ${(critical[0] ?? majors[0])?.issue ?? ''}`.slice(0, 120),
        progressPercent: 88,
      });
      const feedback = review.issues
        .slice(0, 6)
        .map((issue) => `[${issue.severity}] ${issue.issue} -> ${issue.fix}`);
      code = await repairCode(code, { ok: false, errors: feedback, warnings: [] } as unknown as ValidationResult, provider, feedback, planCtx());
      note('qa', (critical[0] ?? majors[0])?.issue ?? 'review issue');
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
