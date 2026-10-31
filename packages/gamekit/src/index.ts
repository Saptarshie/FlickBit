import { readFileSync } from 'node:fs';

export {
  validateGame,
  extractManifest,
  shannonEntropy,
  stripHtmlComments,
  stripJsComments,
  HARD_LIMIT_BYTES,
  WARN_LIMIT_BYTES,
  ENTROPY_LIMIT,
  ENTROPY_MIN_LENGTH,
  FORBIDDEN_PATTERNS,
} from './validate';
export type {
  Manifest,
  ValidationResult,
  ControlKind,
  Orientation,
  Scoring,
  SdkVersion,
} from './validate';

export type Template = { id: string; file: string; code: string };

export const TEMPLATE_IDS = [
  'tap-runner',
  'flappy',
  'snake',
  'brick-breaker',
  'match-3',
  'memory',
  'shooter',
  'physics-toss',
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

function loadTemplate(id: string): string {
  return readFileSync(new URL(`../templates/${id}.html`, import.meta.url), 'utf8');
}

/** The 8 seed games, loaded synchronously from packages/gamekit/templates at import time. */
export const TEMPLATES: Array<{ id: string; file: string; code: string }> = TEMPLATE_IDS.map(
  (id) => ({ id, file: `templates/${id}.html`, code: loadTemplate(id) }),
);

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
