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
  'neon-run-3d',
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let cachedDir: string | null = null;

/**
 * Locate `packages/gamekit/templates` without trusting `import.meta.url`.
 *
 * Turbopack/webpack rewrite `new URL('...', import.meta.url)` into a static
 * asset reference ("Module not found: Can't resolve '../templates'"), and the
 * rewritten form still points at the wrong directory at runtime. So walk up from
 * the working directory until the templates are found. `PLAYLOOP_TEMPLATES_DIR`
 * overrides the search for unusual deployments.
 */
/** Directory holding the archetype templates (walked up from cwd). */
export function templatesDir(): string {
  if (cachedDir) return cachedDir;
  const override = process.env.PLAYLOOP_TEMPLATES_DIR;
  if (override && existsSync(join(override, 'tap-runner.html'))) {
    cachedDir = override;
    return override;
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'packages', 'gamekit', 'templates');
    if (existsSync(join(candidate, 'tap-runner.html'))) {
      cachedDir = candidate;
      return candidate;
    }
    const self = join(dir, 'templates');
    if (existsSync(join(self, 'tap-runner.html'))) {
      cachedDir = self;
      return self;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('gamekit: cannot locate packages/gamekit/templates (set PLAYLOOP_TEMPLATES_DIR)');
}

function loadTemplate(id: string): string {
  return readFileSync(join(templatesDir(), `${id}.html`), 'utf8');
}

let cachedTemplates: Template[] | null = null;

/**
 * The 8 seed games, read from packages/gamekit/templates on first use.
 *
 * Lazy on purpose: this module is imported by the web app (through the db
 * package), and a filesystem read at module-evaluation time makes the module
 * depend on a real path at import — Turbopack treats `new URL(..., import.meta.url)`
 * as a URL object, so the eager version threw "path must be a string" on every
 * server render.
 */
export function templates(): Template[] {
  if (!cachedTemplates) {
    cachedTemplates = TEMPLATE_IDS.map((id) => ({ id, file: `templates/${id}.html`, code: loadTemplate(id) }));
  }
  return cachedTemplates;
}

export function getTemplate(id: string): Template | undefined {
  return templates().find((t) => t.id === id);
}
export * from './stamp';
