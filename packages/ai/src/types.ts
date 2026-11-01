import type { ValidateReport } from '@playloop/gamekit';

export type PipelineStage =
  | 'idle'
  | 'spec'
  | 'generating'
  | 'validating'
  | 'repairing'
  | 'testing'
  | 'metadata'
  | 'done'
  | 'failed';

export type GameSpec = {
  title: string;
  concept: string;
  genre: string;
  templateId: string;
  coreMechanic: string;
  controls: string;
  palette: string[];
  winCondition?: string;
  loseCondition: string;
  audioNotes?: string;
};

export type GameMetadata = {
  title: string;
  description: string;
  tags: string[];
  controls: string;
  orientation: 'portrait' | 'landscape' | 'any';
};

export type GenerationProgress = {
  stage: PipelineStage;
  message: string;
  progressPercent: number;
  error?: string;
};

export type ProgressCallback = (progress: GenerationProgress) => void;

export type GeneratedGame = {
  code: string;
  sha256: string;
  bytes: number;
  spec: GameSpec;
  metadata: GameMetadata;
  validateReport: ValidateReport;
  repairsCount: number;
};

export type GenerationOptions = {
  prompt: string;
  templateId?: string;
  baseCode?: string;
  isRemix?: boolean;
  onProgress?: ProgressCallback;
  maxRepairs?: number;
};

export interface AiProvider {
  generateText(prompt: string, options?: { systemPrompt?: string; temperature?: number }): Promise<string>;
}
