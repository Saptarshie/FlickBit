import { describe, expect, it } from 'vitest';
import { applyUnifiedDiff, PatchError, parseUnifiedDiff } from './patch';
import { contentHash, MemoryProjectStore, normalizePath } from './store';
import { buildProjectTools, LIMITS, projectMap } from './tools';

const GAME = [
  '<!doctype html>',
  '<html><head><title>Hop</title></head>',
  '<body>',
  '<canvas id="c"></canvas>',
  '<script>',
  'var score = 0;',
  'function jump() { score += 1; }',
  'canvas.addEventListener("pointerdown", jump);',
  '</script>',
  '</body></html>',
].join('\n');

async function tools(initial: Record<string, string> = { 'index.html': GAME }) {
  const store = new MemoryProjectStore(initial);
  const list = buildProjectTools(store);
  const tool = (name: string): (typeof list)[number] => {
    const found = list.find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { store, tool };
}

/** The model-facing text of a tool result. */
function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('patch: applyUnifiedDiff', () => {
  it('replaces exactly the lines the hunk names', () => {
    const diff = ['@@ -6,3 +6,3 @@', ' var score = 0;', '-function jump() { score += 1; }', '+function jump() { score += 2; PlayLoop.haptic("light"); }', ' canvas.addEventListener("pointerdown", jump);'].join('\n');
    const out = applyUnifiedDiff(GAME, diff);
    expect(out).toContain('score += 2');
    expect(out).toContain('PlayLoop.haptic');
    expect(out.split('\n').length).toBe(GAME.split('\n').length);
  });

  it('rejects a hunk whose context does not match, and says which line', () => {
    const diff = ['@@ -6,3 +6,3 @@', ' var score = 0;', '-function jump() { score += 99; }', '+function jump() {}', ' canvas.addEventListener("pointerdown", jump);'].join('\n');
    expect(() => applyUnifiedDiff(GAME, diff)).toThrow(PatchError);
    try {
      applyUnifiedDiff(GAME, diff);
    } catch (err) {
      expect((err as PatchError).line).toBe(7);
      expect((err as PatchError).message).toContain('does not match');
    }
  });

  it('supports a pure insertion (old count 0)', () => {
    const diff = ['@@ -3,0 +4,1 @@', '+<h1>Score</h1>'].join('\n');
    const out = applyUnifiedDiff(GAME, diff);
    expect(out.split('\n')[3]).toBe('<h1>Score</h1>');
  });

  it('applies several hunks in order', () => {
    const diff = ['@@ -2,1 +2,1 @@', '-<html><head><title>Hop</title></head>', '+<html><head><title>Hop 2</title></head>', '@@ -6,1 +6,1 @@', '-var score = 0;', '+var score = 10;'].join('\n');
    const out = applyUnifiedDiff(GAME, diff);
    expect(out).toContain('<title>Hop 2</title>');
    expect(out).toContain('var score = 10;');
  });

  it('refuses a diff with no hunks rather than returning the file unchanged', () => {
    expect(() => parseUnifiedDiff('--- a\n+++ b\n')).toThrow(/no hunks/);
  });
});

describe('tools: retrieval is bounded', () => {
  it('reads a range with line numbers and returns the hash needed to patch', async () => {
    const { tool } = await tools();
    const result = await tool('read_file_range').execute('1', { path: 'index.html', startLine: 6, endLine: 8 });
    const text = textOf(result);
    expect(text).toContain('   6| var score = 0;');
    expect(text).toContain(`hash ${(result.details as { hash: string }).hash}`);
    expect((result.details as { totalLines: number }).totalLines).toBe(GAME.split('\n').length);
  });

  it('caps a read at the line budget even when asked for more', async () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const { tool } = await tools({ 'big.txt': long });
    const result = await tool('read_file_range').execute('1', { path: 'big.txt', startLine: 1, endLine: 500 });
    expect((result.details as { end: number }).end).toBe(LIMITS.readLines);
  });

  it('caps search results and reports no matches honestly', async () => {
    const many = Array.from({ length: 100 }, () => 'needle').join('\n');
    const { tool } = await tools({ 'n.txt': many, 'index.html': GAME });
    const hit = await tool('search_project_text').execute('1', { query: 'needle' });
    expect((hit.details as { count: number }).count).toBe(LIMITS.matches);
    const miss = await tool('search_project_text').execute('1', { query: 'walrus' });
    expect(textOf(miss)).toContain('no matches');
    expect(miss.isError).toBeUndefined();
  });

  it('searches literally by default, so a regex-looking query does not explode', async () => {
    const { tool } = await tools({ 'a.txt': 'cost: $5 (approx)' });
    const result = await tool('search_project_text').execute('1', { query: '$5 (approx)' });
    expect(textOf(result)).toContain('a.txt:1');
  });

  it('hides build output from listings and searches', async () => {
    const { tool } = await tools({
      'index.html': GAME,
      'node_modules/pkg/index.js': 'needle',
      'dist/bundle.js': 'needle',
    });
    const list = await tool('list_project_files').execute('1', {});
    expect(textOf(list)).not.toContain('node_modules');
    const search = await tool('search_project_text').execute('1', { query: 'needle' });
    expect(textOf(search)).toContain('no matches');
  });
});

describe('tools: mutations are guarded', () => {
  it('applies a patch and reports the new hash', async () => {
    const { tool } = await tools();
    const before = await tool('read_file_range').execute('1', { path: 'index.html' });
    const hash = (before.details as { hash: string }).hash;
    const diff = ['@@ -6,1 +6,1 @@', '-var score = 0;', '+var score = 5;'].join('\n');
    const result = await tool('apply_unified_diff').execute('1', { path: 'index.html', diff, expectedHash: hash });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('patched index.html');
  });

  it('rejects a patch written against a stale hash and writes nothing', async () => {
    const { store, tool } = await tools();
    await store.write('index.html', `${GAME}\n<!-- edited elsewhere -->`);
    const diff = ['@@ -6,1 +6,1 @@', '-var score = 0;', '+var score = 5;'].join('\n');
    const result = await tool('apply_unified_diff').execute('1', { path: 'index.html', diff, expectedHash: 'deadbeefdeadbeef' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('stale patch rejected');
    expect(await store.read('index.html')).toContain('edited elsewhere');
  });

  it('rejects a patch whose context drifted, and leaves the file untouched', async () => {
    const { store, tool } = await tools();
    const diff = ['@@ -6,2 +6,2 @@', '-var score = 0;', '-var nope = 1;', '+var score = 5;', '+var nope = 2;'].join('\n');
    const result = await tool('apply_unified_diff').execute('1', { path: 'index.html', diff });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Nothing was written');
    expect(await store.read('index.html')).toBe(GAME);
  });

  it('refuses to silently overwrite an existing file when no hash is given', async () => {
    const { tool } = await tools();
    const result = await tool('write_project_file').execute('1', { path: 'index.html', content: 'clobbered' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('refusing to overwrite');
  });

  it('allows creating a new file without a hash', async () => {
    const { store, tool } = await tools();
    const result = await tool('write_project_file').execute('1', { path: 'notes.md', content: '# notes' });
    expect(result.isError).toBeUndefined();
    expect(await store.read('notes.md')).toBe('# notes');
  });

  it('rejects paths that escape the project', async () => {
    const { tool } = await tools();
    const result = await tool('write_project_file').execute('1', { path: '../../etc/passwd', content: 'x' }).catch((e) => e);
    expect(String(result)).toContain('escapes the project');
    expect(() => normalizePath('/abs/path')).toThrow(/absolute/);
  });
});

describe('project map', () => {
  it('summarises directories and names the entry point', () => {
    const summary = projectMap([
      { path: 'index.html', bytes: 2048 },
      { path: 'src/game.js', bytes: 4096 },
      { path: 'src/util.js', bytes: 1024 },
    ]);
    expect(summary).toContain('3 file(s)');
    expect(summary).toContain('entry: index.html');
    expect(summary).toContain('src/  2 file(s)');
  });

  it('hashes deterministically', async () => {
    expect(await contentHash('abc')).toBe(await contentHash('abc'));
    expect(await contentHash('abc')).not.toBe(await contentHash('abd'));
    expect((await contentHash('abc')).length).toBe(16);
  });
});
