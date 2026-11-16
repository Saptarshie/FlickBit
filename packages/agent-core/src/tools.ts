/**
 * The agent's tool surface, defined structurally rather than by importing Pi.
 *
 * `AgentTool` here matches what Pi Agent Core expects (name, label, description,
 * parameters, execute) without depending on it: the same objects can be registered with
 * the Pi agent in a Worker, or exercised directly in a test, or run server-side by the
 * legacy pipeline while the migration finishes.
 *
 * Every tool is bounded. A retrieval tool that can return a whole repository is a
 * context leak with extra steps; these return ranges, snippets and counts.
 */
import { applyUnifiedDiff, PatchError } from './patch';
import { isIgnored, normalizePath, type ProjectStore } from './store';

export const LIMITS = {
  /** Lines one read may return. More than this is a browse, not a read. */
  readLines: 200,
  /** Files one listing may name. */
  listFiles: 400,
  /** Matches one search may return. */
  matches: 24,
  /** Characters of context around a match. */
  snippet: 160,
} as const;

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

export type ProjectTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text }], details };
}

function fail(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text }], details, isError: true };
}

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing "${key}"`);
  return value;
}

/** Compact architecture summary: what exists, where the entry point is, how big. */
export function projectMap(files: Array<{ path: string; bytes: number }>): string {
  const dirs = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '(root)';
    const entry = dirs.get(dir) ?? { files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += file.bytes;
    dirs.set(dir, entry);
  }
  const lines = [...dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, stat]) => `  ${dir}/  ${stat.files} file(s), ${(stat.bytes / 1024).toFixed(1)} KB`);

  const entry = files.find((f) => /(^|\/)index\.html$/.test(f.path)) ?? files.find((f) => /\.html$/.test(f.path));
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  return [
    `project: ${files.length} file(s), ${(total / 1024).toFixed(1)} KB`,
    entry ? `entry: ${entry.path}` : 'entry: none yet',
    ...lines,
  ].join('\n');
}

export function buildProjectTools(store: ProjectStore): ProjectTool[] {
  const listFiles: ProjectTool = {
    name: 'list_project_files',
    label: 'List project files',
    description: 'List every text file in the project with its size and hash. Ignored: node_modules, dist, build, .git, .next.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const files = await store.list();
      const shown = files.slice(0, LIMITS.listFiles);
      const lines = shown.map((f) => `${f.path}  ${f.bytes} B  ${f.hash}`);
      const more = files.length > shown.length ? `\n… ${files.length - shown.length} more (not shown)` : '';
      return ok(`${files.length} file(s)\n${lines.join('\n')}${more}`, { count: files.length, files: shown });
    },
  };

  const projectMapTool: ProjectTool = {
    name: 'get_project_map',
    label: 'Project map',
    description: 'A compact summary of the project: directories, sizes and the entry point. Start here instead of listing everything.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const files = (await store.list()).filter((f) => !isIgnored(f.path));
      return ok(projectMap(files), { count: files.length });
    },
  };

  const readRange: ProjectTool = {
    name: 'read_file_range',
    label: 'Read file range',
    description: `Read a line range of one file (1-based, inclusive). Returns at most ${LIMITS.readLines} lines, numbered, plus the file hash needed to patch it.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number', description: '1-based; defaults to 1' },
        endLine: { type: 'number', description: 'inclusive; defaults to startLine + 199' },
      },
      required: ['path'],
    },
    async execute(_id, params) {
      const path = normalizePath(str(params, 'path'));
      const content = await store.read(path);
      if (content === null) return fail(`no such file: ${path}`);
      const lines = content.split('\n');
      const start = Math.max(1, Number(params['startLine'] ?? 1) || 1);
      const wanted = Number(params['endLine'] ?? start + LIMITS.readLines - 1) || start + LIMITS.readLines - 1;
      const end = Math.min(lines.length, Math.max(start, Math.min(wanted, start + LIMITS.readLines - 1)));

      const body = lines
        .slice(start - 1, end)
        .map((line, i) => `${String(start + i).padStart(4)}| ${line}`)
        .join('\n');
      const hash = await store.hash(path);
      return ok(`${path} lines ${start}-${end} of ${lines.length} · hash ${hash}\n${body}`, {
        path,
        start,
        end,
        totalLines: lines.length,
        hash,
      });
    },
  };

  const search: ProjectTool = {
    name: 'search_project_text',
    label: 'Search project text',
    description: `Search every text file for a literal string or simple regular expression. Returns at most ${LIMITS.matches} matches with file, line number and a short snippet.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        regex: { type: 'boolean', description: 'treat query as a regular expression' },
      },
      required: ['query'],
    },
    async execute(_id, params) {
      const query = str(params, 'query');
      const asRegex = params['regex'] === true;
      let matcher: (line: string) => boolean;
      try {
        const re = asRegex ? new RegExp(query) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        matcher = (line) => re.test(line);
      } catch (err) {
        return fail(`bad pattern: ${err instanceof Error ? err.message : String(err)}`);
      }

      const hits: Array<{ path: string; line: number; text: string }> = [];
      for (const file of await store.list()) {
        if (isIgnored(file.path)) continue;
        const content = await store.read(file.path);
        if (content === null) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          if (!matcher(line)) continue;
          hits.push({ path: file.path, line: i + 1, text: line.slice(0, LIMITS.snippet) });
          if (hits.length >= LIMITS.matches) break;
        }
        if (hits.length >= LIMITS.matches) break;
      }

      if (hits.length === 0) return ok(`no matches for ${JSON.stringify(query)}`, { count: 0 });
      const text = hits.map((h) => `${h.path}:${h.line}  ${h.text}`).join('\n');
      return ok(`${hits.length} match(es)\n${text}`, { count: hits.length, hits });
    },
  };

  const write: ProjectTool = {
    name: 'write_project_file',
    label: 'Write project file',
    description: 'Create or replace a project file. Pass expectedHash when editing an existing file so a stale write is rejected.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        expectedHash: { type: 'string', description: 'hash from read_file_range; omit only for a new file' },
      },
      required: ['path', 'content'],
    },
    async execute(_id, params) {
      const path = normalizePath(str(params, 'path'));
      const expected = typeof params['expectedHash'] === 'string' ? params['expectedHash'] : null;
      const current = await store.hash(path);

      if (expected !== null && current !== null && expected !== current) {
        return fail(`stale write rejected: ${path} was ${current}, patch was written against ${expected}. Re-read the file.`, {
          path,
          current,
          expected,
        });
      }
      if (expected === null && current !== null) {
        return fail(`refusing to overwrite existing file ${path} without expectedHash — read it first.`, { path, current });
      }
      const result = await store.write(path, str(params, 'content'));
      return ok(`wrote ${path}: ${result.bytes} bytes, hash ${result.hash}`, result);
    },
  };

  const patch: ProjectTool = {
    name: 'apply_unified_diff',
    label: 'Apply patch',
    description:
      'Apply a unified diff to one file. Every context and removed line must match exactly; a mismatch is rejected and nothing is written. Include @@ hunk headers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        diff: { type: 'string' },
        expectedHash: { type: 'string', description: 'hash the patch was written against' },
      },
      required: ['path', 'diff'],
    },
    async execute(_id, params) {
      const path = normalizePath(str(params, 'path'));
      const diff = str(params, 'diff');
      const original = await store.read(path);
      if (original === null) return fail(`no such file: ${path}`);

      const expected = typeof params['expectedHash'] === 'string' ? params['expectedHash'] : null;
      const current = await store.hash(path);
      if (expected !== null && current !== expected) {
        return fail(`stale patch rejected: ${path} is ${current}, patch was written against ${expected}. Re-read the file.`, {
          path,
          current,
          expected,
        });
      }

      let patched: string;
      try {
        patched = applyUnifiedDiff(original, diff);
      } catch (err) {
        if (err instanceof PatchError) {
          return fail(`patch rejected at hunk ${err.hunk + 1}, line ${err.line}: ${err.message}. Nothing was written.`, {
            path,
            hunk: err.hunk,
            line: err.line,
          });
        }
        return fail(`patch failed: ${err instanceof Error ? err.message : String(err)}`, { path });
      }

      const result = await store.write(path, patched);
      const delta = patched.length - original.length;
      return ok(`patched ${path}: ${result.bytes} bytes (${delta >= 0 ? '+' : ''}${delta}), hash ${result.hash}`, result);
    },
  };

  return [projectMapTool, listFiles, readRange, search, patch, write];
}
