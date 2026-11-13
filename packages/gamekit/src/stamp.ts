/**
 * Stamp the runtime into an artifact's manifest.
 *
 * The engine is a platform decision, not a creative one, so it is written here
 * rather than asked of the model: a model that omits or misspells `runtime`
 * would silently ship a game that never gets its engine, and a model that names
 * a URL would ship a supply-chain hole. The artifact's own JSON block is
 * rewritten in place; everything else is untouched, so the bytes on disk still
 * hash to the same artifact the studio produced (the hash is taken after this).
 */

export type RuntimeStamp = {
  /** Allowlisted id (`micro`, `phaser4`, …). */
  runtime: string;
  /** Exact engine build; omitted for `micro`, which has no file. */
  runtimeVersion?: string;
};

const MANIFEST_RE = /(<script[^>]*id=["']pl-manifest["'][^>]*>)([\s\S]*?)(<\/script>)/i;

/**
 * Rewrite `runtime`/`runtimeVersion` inside the pl-manifest block.
 * Returns the html unchanged when there is no manifest (the validator will
 * report that separately, with a better message than this function could).
 */
export function stampRuntime(html: string, stamp: RuntimeStamp): string {
  const match = MANIFEST_RE.exec(html);
  if (match === null) return html;

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(match[2] ?? '');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return html;
    data = parsed as Record<string, unknown>;
  } catch {
    // Invalid JSON is the validator's problem; do not make it worse.
    return html;
  }

  if (stamp.runtime === 'micro') {
    // `micro` is the default; leaving it out keeps the artifact identical to
    // what the templates and older games carry.
    delete data['runtime'];
    delete data['runtimeVersion'];
  } else {
    data['runtime'] = stamp.runtime;
    if (stamp.runtimeVersion) data['runtimeVersion'] = stamp.runtimeVersion;
  }

  const next = JSON.stringify(data).replace(/</g, '\\u003c');
  return html.slice(0, match.index) + match[1] + next + match[3] + html.slice(match.index + match[0].length);
}
