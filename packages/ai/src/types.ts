import type { ValidationResult } from '@playloop/gamekit';
import type { VisualReview } from './visual';

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
  | 'playtesting'
  | 'visual'
  | 'reviewing'
  | 'metadata'
  | 'done'
  | 'failed';

export type GameSpec = {
  title: string;
  /**
   * Engine the planner asked for. Absent means `micro` (gameplay only, no
   * engine download); `phaser4` is for games that need real physics, tweens,
   * tilemaps or thousands of entities.
   */
  runtime?: string;
  /** One line from the planner explaining the choice (shown in the studio). */
  runtimeReason?: string;
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

/**
 * Structural subset of gamekit's PlaytestReport, so this package stays free of
 * a Playwright dependency.
 */
export type PlaytestSummary = {
  pass: boolean;
  ready: boolean;
  changes: number;
  taps: number;
  scoreStart: number | null;
  scoreEnd: number | null;
  finalScore: number | null;
  scoreMoved: boolean;
  progress: boolean;
  gameOverSeen: boolean;
  restartWorked: boolean | null;
  errors: string[];
  defects: string[];
  durationMs: number;
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
  /** Playtest result: did taps actually do something, and can the player restart? */
  playtest?: PlaytestSummary | null;
  /** What a multimodal reviewer saw in the screenshots (null when unreviewed). */
  visual?: VisualReview | null;
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
  /**
   * Playtest gate owned by the caller: send real input envelopes and check the
   * game responds, scores and can be restarted. Runs after `smoke`.
   */
  playtest?: (html: string) => Promise<PlaytestSummary>;
  /**
   * Screenshot provider owned by the caller: captures the opening, mid-run and
   * end frames as PNG data URLs for the visual reviewer.
   */
  capture?: (html: string) => Promise<{
    start: string | null;
    play: string | null;
    over: string | null;
    notes?: string[];
  }>;
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
