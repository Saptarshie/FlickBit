import { createHash } from 'node:crypto';
import { validateGame, type ValidationResult } from '@playloop/gamekit';
import { generateCode } from './generator';
import { extractOrGenerateMetadata } from './metadata';
import { planGame } from './planner';
import { repairCode } from './repair';
import type {
  AiProvider,
  GeneratedGame,
  GenerationOptions,
  GenerationProgress,
} from './types';

export async function runGenerationPipeline(
  options: GenerationOptions,
  provider: AiProvider
): Promise<GeneratedGame> {
  const { prompt, templateId, baseCode, isRemix, onProgress, maxRepairs = 3 } = options;

  const reportProgress = (progress: GenerationProgress) => {
    onProgress?.(progress);
  };

  // Stage 1: Specification / Plan
  reportProgress({
    stage: 'spec',
    message: 'Formulating game concept and mechanics...',
    progressPercent: 15,
  });

  const spec = await planGame(prompt, provider, templateId);

  // Stage 2: Code Generation
  reportProgress({
    stage: 'generating',
    message: `Synthesizing game artifact (${spec.templateId} archetype)...`,
    progressPercent: 40,
  });

  let code = await generateCode(prompt, spec, provider, { baseCode, isRemix });

  // Stage 3: Validation & Repair Loop
  reportProgress({
    stage: 'validating',
    message: 'Verifying game sandbox security and compliance...',
    progressPercent: 70,
  });

  let validateReport: ValidationResult = validateGame(code);
  let repairsCount = 0;

  while (validateReport.errors.length > 0 && repairsCount < maxRepairs) {
    repairsCount++;
    reportProgress({
      stage: 'repairing',
      message: `Repairing validation issues (attempt ${repairsCount}/${maxRepairs})...`,
      progressPercent: 70 + repairsCount * 5,
    });

    code = await repairCode(code, validateReport, provider);
    validateReport = validateGame(code);
  }

  if (validateReport.errors.length > 0) {
    const errors = validateReport.errors.join('; ');
    const err = new Error(`Game artifact validation failed after ${repairsCount} repairs: ${errors}`);
    reportProgress({
      stage: 'failed',
      message: err.message,
      progressPercent: 100,
      error: err.message,
    });
    throw err;
  }

  // Stage 4: Metadata
  reportProgress({
    stage: 'metadata',
    message: 'Extracting title, tags, and controls guide...',
    progressPercent: 90,
  });

  const metadata = await extractOrGenerateMetadata(code, spec, provider);

  const bytes = Buffer.from(code, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Stage 5: Complete
  reportProgress({
    stage: 'done',
    message: 'Game generated and ready to play!',
    progressPercent: 100,
  });

  return {
    code,
    sha256,
    bytes: bytes.byteLength,
    spec,
    metadata,
    validateReport,
    repairsCount,
  };
}
