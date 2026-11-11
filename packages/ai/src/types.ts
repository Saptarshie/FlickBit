import type { ValidationResult } from '@playloop/gamekit';

export type SmokeSummary = {
  pass: boolean;
  fps: number;
  blankScreen: boolean;
  interactive: boolean;
  consoleErrors: string[];
  uncaught: string[];
};

export type ReviewIssue = {
  severity: 'critical' | 'major' | 'minor';
  issue: string;
  fix: string;
};

export type ReviewReport = {
  verdict: 'ship' | 'revise';
  issues: ReviewIssue[];
  summary: string;
};

/** Output of the art-director stage: the brief the coder builds to. */
export type GameDesign = {
  visualIdentity: string;
  palette: string[];
  hud: string[];
  assetPlan: string[];
  juice: { small: string; medium: string; large: string };
  difficulty: string;
  performanceNotes: string[];
  failureModes: string[];
};

export type PipelineStage =
  | 'idle'
  | 'spec'
  | 'design'
  | 'generating'
  | 'validating'
  | 'repairing'
  | 'testing'
  | 'reviewing'
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
  validateReport: ValidationResult;
  repairsCount: number;
  /** Milliseconds spent per pipeline stage, keyed by stage name. */
  timingsMs?: Record<string, number>;
  /** Art-direction brief produced before coding (multi-agent pipeline). */
  design?: GameDesign;
  /** Runtime result, when a smoke runner was supplied by the caller. */
  smoke?: SmokeSummary | null;
  /** QA critique produced after the game runs. */
  review?: ReviewReport | null;
};

export type GenerationOptions = {
  prompt: string;
  templateId?: string;
  /** Existing artifact to edit (follow-up turn or remix). */
  baseCode?: string;
  isRemix?: boolean;
  /** True when this is a follow-up turn in a session (edit, not remix). */
  isEdit?: boolean;
  /** Prior turns, oldest first: prompt text the player already asked for. */
  history?: string[];
  /** A user-supplied concept image as a data URL (theme/concept reference). */
  imageDataUrl?: string;
  onProgress?: ProgressCallback;
  maxRepairs?: number;
  /** Runtime gate owned by the caller (the app injects Playwright). */
  smoke?: (html: string) => Promise<SmokeSummary>;
  /** Disable the QA critique pass (costs one extra completion). */
  skipReview?: boolean;
  /** Disable the art-director stage (tests and quick iterations). */
  skipDesign?: boolean;
  /**
   * Reuse an existing spec instead of planning again. Follow-up turns pass the
   * spec the game was built from: re-planning from "add a shield" made the model
   * reinvent the genre, which then needed a QA repair.
   */
  spec?: GameSpec;
};

export interface AiProvider {
  generateText(
    prompt: string,
    options?: { systemPrompt?: string; temperature?: number; images?: string[] },
  ): Promise<string>;
}
