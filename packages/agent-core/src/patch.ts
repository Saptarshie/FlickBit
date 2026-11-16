/**
 * A unified-diff applier that refuses to guess.
 *
 * The point of a patch is that it is small and reviewable: the model proposes three
 * changed lines, not sixty kilobytes of rewritten file. The trade-off is that a patch
 * carries its own context, so it can only be applied where that context still exists —
 * every context and removed line must match the original exactly, in order.
 *
 * A mismatch is an error, never a fuzzy match. Silently applying a patch "near enough"
 * is how a refactor eats the function next door.
 */

export class PatchError extends Error {
  constructor(
    message: string,
    readonly hunk: number,
    readonly line: number,
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

type Body = { kind: ' ' | '-' | '+'; text: string };
type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; body: Body[] };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): Hunk[] {
  const lines = diff.split(/\r?\n/);
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let index = 0;

  for (const line of lines) {
    index += 1;
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }
    const header = HUNK_RE.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        body: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    if (line === '' || line === '\\ No newline at end of file') continue;
    const marker = line[0];
    if (marker !== ' ' && marker !== '-' && marker !== '+') {
      throw new PatchError(`unexpected line in hunk: ${JSON.stringify(line.slice(0, 40))}`, hunks.length, index);
    }
    current.body.push({ kind: marker, text: line.slice(1) });
  }

  if (hunks.length === 0) throw new PatchError('no hunks found — a diff needs at least one @@ header', 0, 0);
  return hunks;
}

/** Apply a unified diff to `original`. Throws PatchError on any context mismatch. */
export function applyUnifiedDiff(original: string, diff: string): string {
  const hunks = parseUnifiedDiff(diff);
  const source = original.split('\n');
  const out: string[] = [];
  let cursor = 0; // 0-based index into `source`

  hunks.forEach((hunk, hunkIndex) => {
    // A hunk whose old count is 0 is a pure insertion at oldStart (1-based, +1).
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor) throw new PatchError('hunks overlap or are out of order', hunkIndex, 0);
    if (start > source.length) throw new PatchError(`hunk starts past the end of the file (${start} > ${source.length})`, hunkIndex, 0);

    out.push(...source.slice(cursor, start));
    cursor = start;

    for (const entry of hunk.body) {
      if (entry.kind === '+') {
        out.push(entry.text);
        continue;
      }
      const actual = source[cursor];
      if (actual === undefined) {
        throw new PatchError(`hunk expects ${JSON.stringify(entry.text.slice(0, 40))} but the file ended`, hunkIndex, cursor + 1);
      }
      if (actual !== entry.text) {
        throw new PatchError(
          `line ${cursor + 1} does not match: expected ${JSON.stringify(entry.text.slice(0, 40))}, found ${JSON.stringify(actual.slice(0, 40))}`,
          hunkIndex,
          cursor + 1,
        );
      }
      if (entry.kind === ' ') out.push(actual);
      cursor += 1;
    }
  });

  out.push(...source.slice(cursor));
  return out.join('\n');
}
