/**
 * PlayLoop game artifact validator (static, defense-in-depth).
 * See docs/03-game-artifact-spec.md — "Validation rules".
 */
import { isRuntimeId, RUNTIME_IDS } from '@playloop/sdk';

/**
 * Control vocabulary. `joystick` and `buttons` are on-screen widgets the game draws
 * itself: a thumb-stick in the bottom-left, action buttons in the bottom-right.
 * `mixed` is one of those plus a tap/drag gesture. A phone can do all of this with
 * two thumbs, which is the only input budget a feed game has.
 */
export type ControlKind = 'tap' | 'drag' | 'swipe' | 'tilt' | 'keys' | 'joystick' | 'buttons' | 'mixed';
export type Orientation = 'portrait' | 'landscape' | 'any';
export type Scoring = 'higher' | 'lower' | 'none';
export type SdkVersion = 1;

export type Manifest = {
  title: string;
  description: string;
  controls: ControlKind;
  orientation: Orientation;
  sdkVersion: SdkVersion;
  tags: string[];
  scoring: Scoring;
  /**
   * Engine the artifact was authored against (see @playloop/sdk runtimes).
   * Absent or 'micro' means gameplay-only: no engine is loaded for this game.
   */
  runtime?: string;
  /** Exact engine version, pinned so an upgrade can never change an old game. */
  runtimeVersion?: string;
  /**
   * Content-addressed assets this game draws. The platform resolves them from
   * /a/<file>; a manifest may name a file, never a URL.
   */
  assets?: Array<{ id: string; file: string }>;
  /**
   * One line the player needs, shown over the first frame before they touch
   * anything — e.g. "Swipe left/right to change lane · tap to jump".
   *
   * `controls` names the input mechanism; this says what the input *does*. A card
   * that only says "tap" leaves the player to discover the rest by stabbing at it.
   */
  hint?: string;
};

export type ValidationResult = {
  manifest: Manifest | null;
  errors: string[];
  warnings: string[];
  bytes: number;
};

/** Hard size limit: artifacts above this are rejected. */
export const HARD_LIMIT_BYTES = 500 * 1024;
/** Soft size limit: artifacts above this get a warning. */
export const WARN_LIMIT_BYTES = 300 * 1024;
/** Shannon entropy (bits/char) above which a long string literal warns. */
export const ENTROPY_LIMIT = 4.5;
/** String literals must be longer than this (chars) before entropy applies. */
export const ENTROPY_MIN_LENGTH = 512;

/**
 * Forbidden literal substrings. Checked case-insensitively against the raw
 * artifact (comments included): a comment cannot smuggle a dangerous token.
 */
export const FORBIDDEN_PATTERNS: readonly string[] = [
  '<iframe',
  '<form',
  'fetch(',
  'XMLHttpRequest',
  'WebSocket',
  'sendBeacon',
  'importScripts',
  'document.cookie',
  'localStorage',
  'sessionStorage',
  'window.top',
  'window.parent',
  'parent.',
  'eval(',
  'new Function(',
  'alert(',
  'confirm(',
  'prompt(',
  'javascript:',
];

const CONTROLS: readonly string[] = ['tap', 'drag', 'swipe', 'tilt', 'keys', 'joystick', 'buttons', 'mixed'];
const ORIENTATIONS: readonly string[] = ['portrait', 'landscape', 'any'];
const SCORINGS: readonly string[] = ['higher', 'lower', 'none'];

// ---------------------------------------------------------------------------
// Comment stripping (for the "external URL outside a comment" rule)
// ---------------------------------------------------------------------------

/** Remove `<!-- ... -->` comments (non-greedy). */
export function stripHtmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Remove `// line` and `/* block *\/` comments from JavaScript source while
 * keeping string/template literals intact (so string contents survive).
 */
export function stripJsComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inStr: string | null = null;
  while (i < n) {
    const c = src[i] as string;
    const next = i + 1 < n ? (src[i + 1] as string) : '';
    if (inStr !== null) {
      if (c === '\\') {
        out += c + next;
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i + 1 < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Text used for the external-URL scan: HTML comments removed; inside <script>
 * bodies JS comments removed too; string literals kept so URLs in strings are
 * still caught.
 */
function codeForUrlScan(code: string): string {
  const withoutHtmlComments = stripHtmlComments(code);
  return withoutHtmlComments.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
    (_full: string, open: string, body: string, close: string) =>
      open + stripJsComments(body) + close,
  );
}

// ---------------------------------------------------------------------------
// Manifest extraction
// ---------------------------------------------------------------------------

type ManifestSource = { kind: 'script' | 'comment'; raw: string };

function findManifestSource(html: string): ManifestSource | null {
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null = scriptRe.exec(html);
  while (m !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const hasId = /\bid\s*=\s*(['"])pl-manifest\1/i.test(attrs);
    const hasType = /\btype\s*=\s*(['"]?)application\/json\1/i.test(attrs);
    if (hasId && hasType) return { kind: 'script', raw: body };
    m = scriptRe.exec(html);
  }
  const commentRe = /<!--\s*pl-manifest:\s*([\s\S]*?)-->/;
  const cm = commentRe.exec(html);
  if (cm) return { kind: 'comment', raw: cm[1] ?? '' };
  return null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Strict JSON.parse + structural validation. */
function parseManifestRaw(raw: string): { manifest: Manifest | null; error: string | null } {
  let data: unknown;
  try {
    // Strict JSON: no trailing commas, no comments, no eval-based parsing.
    data = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { manifest: null, error: `invalid pl-manifest: strict JSON parse failed (${msg})` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { manifest: null, error: 'invalid pl-manifest: must be a JSON object' };
  }
  const rec = data as Record<string, unknown>;
  const problems: string[] = [];
  if (!isNonEmptyString(rec['title'])) problems.push('"title" must be a non-empty string');
  if (!isNonEmptyString(rec['description'])) problems.push('"description" must be a non-empty string');
  if (typeof rec['controls'] !== 'string' || !CONTROLS.includes(rec['controls'])) {
    problems.push('"controls" must be one of tap|drag|swipe|tilt|keys|joystick|buttons|mixed');
  }
  if (typeof rec['orientation'] !== 'string' || !ORIENTATIONS.includes(rec['orientation'])) {
    problems.push('"orientation" must be one of portrait|landscape|any');
  }
  if (rec['sdkVersion'] !== 1) problems.push('"sdkVersion" must be 1');
  // A manifest may only name a runtime from the platform allowlist; a URL here
  // would let a creator load arbitrary code under our origin.
  if (rec['runtime'] !== undefined && !isRuntimeId(rec['runtime'])) {
    problems.push(`"runtime" must be one of ${RUNTIME_IDS.join('|')}`);
  }
  if (rec['runtimeVersion'] !== undefined && typeof rec['runtimeVersion'] !== 'string') {
    problems.push('"runtimeVersion" must be a string');
  }
  if (rec['assets'] !== undefined) {
    if (!Array.isArray(rec['assets'])) {
      problems.push('"assets" must be an array');
    } else {
      for (const asset of rec['assets']) {
        const file = (asset as { file?: unknown })?.file;
        if (typeof file !== 'string' || !/^[0-9a-f]{16}\.(webp|png|ogg|mp3|glb)$/.test(file)) {
          // A URL here would be an unchecked network dependency inside a frame
          // with connect-src 'none'; only our own content-addressed names pass.
          problems.push('each asset needs { id, file } where file matches <sha16>.(webp|png|ogg|mp3)');
          break;
        }
      }
    }
  }
  const tags = rec['tags'];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    problems.push('"tags" must be an array of strings');
  }
  if (typeof rec['scoring'] !== 'string' || !SCORINGS.includes(rec['scoring'])) {
    problems.push('"scoring" must be one of higher|lower|none');
  }
  // A blank hint is a hint the author did not get round to: treat it as absent
  // rather than failing a game over whitespace.
  const hint = typeof rec['hint'] === 'string' ? rec['hint'].trim() : '';
  if (rec['hint'] !== undefined && typeof rec['hint'] !== 'string') problems.push('"hint" must be a string when present');
  else if (hint.length > 120) problems.push('"hint" must be 120 characters or fewer');
  if (problems.length > 0) {
    return { manifest: null, error: `invalid pl-manifest: ${problems.join('; ')}` };
  }
  return {
    manifest: {
      title: rec['title'] as string,
      description: rec['description'] as string,
      controls: rec['controls'] as ControlKind,
      orientation: rec['orientation'] as Orientation,
      sdkVersion: 1,
      tags: tags as string[],
      scoring: rec['scoring'] as Scoring,
      ...(hint.length > 0 ? { hint } : {}),
      ...(rec['runtime'] !== undefined ? { runtime: rec['runtime'] as string } : {}),
      ...(rec['runtimeVersion'] !== undefined ? { runtimeVersion: rec['runtimeVersion'] as string } : {}),
      ...(Array.isArray(rec['assets'])
        ? {
            assets: (rec['assets'] as Array<{ id: string; file: string }>).map((a) => ({ id: String(a.id), file: String(a.file) })),
          }
        : {}),
    },
    error: null,
  };
}

/**
 * Extract the game manifest from an artifact. Accepts either
 *   <script type="application/json" id="pl-manifest">{ ... }</script>
 * or
 *   <!-- pl-manifest: { ... } -->
 * Returns null when missing, unparseable, or structurally invalid.
 */
export function extractManifest(html: string): Manifest | null {
  const src = findManifestSource(html);
  if (src === null) return null;
  return parseManifestRaw(src.raw).manifest;
}

// ---------------------------------------------------------------------------
// String literals + Shannon entropy (embedded-blob heuristic)
// ---------------------------------------------------------------------------

function extractStringLiterals(code: string): string[] {
  const bodies: string[] = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null = scriptRe.exec(code);
  while (m !== null) {
    bodies.push(m[1] ?? '');
    m = scriptRe.exec(code);
  }
  const source = bodies.length > 0 ? bodies.join('\n') : stripJsComments(stripHtmlComments(code));
  const out: string[] = [];
  const literalRes: RegExp[] = [
    /'(?:\\.|[^'\\\n])*'/g,
    /"(?:\\.|[^"\\\n])*"/g,
    /`(?:\\.|[^`\\])*`/g,
  ];
  for (const re of literalRes) {
    let lm: RegExpExecArray | null = re.exec(source);
    while (lm !== null) {
      const inner = lm[0].slice(1, -1);
      if (inner.length > 0) out.push(inner);
      lm = re.exec(source);
    }
  }
  return out;
}

/** Shannon entropy in bits per character over the literal's characters. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ---------------------------------------------------------------------------
// validateGame
// ---------------------------------------------------------------------------

/**
 * Parse every inline script and report a syntax error as a *static* defect.
 *
 * A missing bracket used to survive validation, fail the smoke gate 90 seconds
 * later, and then burn a full repair pass on "Script error." — a message that tells
 * the model nothing. `new Function` parses without executing, so this costs
 * microseconds and says exactly which line broke.
 */
export function syntaxErrorCheck(code: string): string[] {
  const problems: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = re.exec(code)) !== null) {
    index += 1;
    const attrs = (m[1] ?? '').toLowerCase();
    const body = m[2] ?? '';
    if (/src=/.test(attrs)) continue;
    if (/type=["']?(application\/json|module)["']?/.test(attrs)) continue;
    if (body.trim().length === 0) continue;
    // Top-level import/export is not expressible in Function(); skip rather than lie.
    if (/^\s*(import|export)/m.test(body)) continue;
    try {
      // eslint-disable-next-line no-new-func
      new Function(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push(`script #${index} has a syntax error: ${message}`);
    }
  }
  return problems;
}

export function validateGame(code: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const bytes = new TextEncoder().encode(code).length;

  // Size: hard reject above 500KB, warn above 300KB.
  if (bytes > HARD_LIMIT_BYTES) {
    errors.push(`artifact too large: ${bytes} bytes (hard limit ${HARD_LIMIT_BYTES} bytes / 500KB)`);
  }
  if (bytes > WARN_LIMIT_BYTES) {
    warnings.push(`artifact is large: ${bytes} bytes (soft limit ${WARN_LIMIT_BYTES} bytes / 300KB)`);
  }

  // Static syntax first: it is the cheapest defect to find and the most expensive
  // one to discover at runtime.
  errors.push(...syntaxErrorCheck(code));

  // Forbidden literal substrings (case-insensitive over raw code).
  const lower = code.toLowerCase();
  for (const needle of FORBIDDEN_PATTERNS) {
    if (lower.includes(needle.toLowerCase())) {
      errors.push(`forbidden pattern: ${needle}`);
    }
  }

  // External http(s) URLs outside comments are hard errors.
  const scanText = codeForUrlScan(code);
  const urlRe = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi;
  const seenUrls = new Set<string>();
  let um: RegExpExecArray | null = urlRe.exec(scanText);
  while (um !== null) {
    const url = um[0];
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      errors.push(`external URL not allowed: ${url}`);
    }
    um = urlRe.exec(scanText);
  }

  // Structural completeness: a truncated completion must never be published.
  // (Models sometimes stop mid-file; the artifact is then unplayable.)
  if (!/<html[\s>]/i.test(code)) {
    errors.push('truncated/invalid artifact: missing <html> root element');
  }
  if (!/<\/html\s*>/i.test(code)) {
    errors.push('truncated artifact: missing closing </html> (the file was cut off)');
  }
  // Compare counts, not presence: an artifact can contain a closed manifest
  // script and still have its main script cut off.
  const openTags = (code.match(/<script\b/gi) ?? []).length;
  const closeTags = (code.match(/<\/script\s*>/gi) ?? []).length;
  if (openTags > closeTags) {
    errors.push(`truncated artifact: ${openTags - closeTags} unclosed <script> tag(s)`);
  }

  // Manifest: must exist and parse (strict JSON + structure).
  let manifest: Manifest | null = null;
  const src = findManifestSource(code);
  if (src === null) {
    errors.push('missing pl-manifest (expected <script id="pl-manifest" type="application/json"> or <!-- pl-manifest: {...} -->)');
  } else {
    const parsed = parseManifestRaw(src.raw);
    manifest = parsed.manifest;
    if (manifest === null) {
      errors.push(parsed.error ?? 'invalid pl-manifest: unknown parse failure');
    }
  }

  // Warning: missing meta viewport.
  if (!/<meta\b[^>]*\bname\s*=\s*["']?viewport["']?/i.test(code)) {
    warnings.push('missing <meta name="viewport"> (artifact will not be responsive)');
  }
  // Warning: missing SDK lifecycle calls.
  if (!/PlayLoop\.ready\s*\(/.test(code)) {
    warnings.push('missing PlayLoop.ready() call');
  }
  if (!/PlayLoop\.gameOver\s*\(/.test(code)) {
    warnings.push('missing PlayLoop.gameOver() call');
  }
  // Warning: high-entropy string literals suggest an embedded blob.
  for (const lit of extractStringLiterals(code)) {
    if (lit.length > ENTROPY_MIN_LENGTH) {
      const h = shannonEntropy(lit);
      if (h > ENTROPY_LIMIT) {
        warnings.push(
          `high-entropy string literal (${lit.length} chars, ${h.toFixed(2)} bits/char) suggests an embedded blob`,
        );
      }
    }
  }

  return { manifest, errors, warnings, bytes };
}
