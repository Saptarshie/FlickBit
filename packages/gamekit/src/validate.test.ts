import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractManifest,
  shannonEntropy,
  stripHtmlComments,
  stripJsComments,
  validateGame,
} from './validate';

const MANIFEST_JSON =
  '{"title":"T","description":"D","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":["arcade"],"scoring":"higher"}';

/** Minimal valid artifact shell around a JS body (no extra errors/warnings). */
function withManifest(body: string, manifestJson: string = MANIFEST_JSON): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<script type="application/json" id="pl-manifest">',
    manifestJson,
    '</script></head><body><canvas id="c"></canvas><script>',
    body,
    'PlayLoop.ready(); PlayLoop.gameOver({ score: 1 });',
    '</script></body></html>',
  ].join('\n');
}

function pseudoRandomBase64(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let seed = 42;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += alphabet.charAt(Math.floor(seed / 65536) % alphabet.length);
  }
  return out;
}

describe('validateGame — hard errors (one fixture per rule)', () => {
  const BAD: Array<{ name: string; code: string; error: string }> = [
    { name: 'iframe tag', code: withManifest("var f = '<iframe src=\"x.html\"></iframe>';"), error: 'forbidden pattern: <iframe' },
    { name: 'form tag', code: withManifest("var f = '<form action=\"x\"><input></form>';"), error: 'forbidden pattern: <form' },
    { name: 'fetch(', code: withManifest("var p = fetch('data.json');"), error: 'forbidden pattern: fetch(' },
    { name: 'XMLHttpRequest', code: withManifest('var r = new XMLHttpRequest();'), error: 'forbidden pattern: XMLHttpRequest' },
    { name: 'WebSocket', code: withManifest("var s = new WebSocket('w');"), error: 'forbidden pattern: WebSocket' },
    { name: 'sendBeacon', code: withManifest("navigator.sendBeacon('/log', 'x');"), error: 'forbidden pattern: sendBeacon' },
    { name: 'importScripts', code: withManifest("importScripts('worker.js');"), error: 'forbidden pattern: importScripts' },
    { name: 'document.cookie', code: withManifest("document.cookie = 'a=1';"), error: 'forbidden pattern: document.cookie' },
    { name: 'localStorage', code: withManifest("localStorage.setItem('k', 'v');"), error: 'forbidden pattern: localStorage' },
    { name: 'sessionStorage', code: withManifest("sessionStorage.getItem('k');"), error: 'forbidden pattern: sessionStorage' },
    { name: 'window.top', code: withManifest('var t = window.top;'), error: 'forbidden pattern: window.top' },
    { name: 'window.parent', code: withManifest('var p = window.parent;'), error: 'forbidden pattern: window.parent' },
    { name: 'parent.', code: withManifest("node.parent.style.display = 'none';"), error: 'forbidden pattern: parent.' },
    { name: 'eval(', code: withManifest("var f = eval('1');"), error: 'forbidden pattern: eval(' },
    { name: 'new Function(', code: withManifest("var f = new Function('a', 'return a');"), error: 'forbidden pattern: new Function(' },
    { name: 'alert(', code: withManifest("alert('hi');"), error: 'forbidden pattern: alert(' },
    { name: 'confirm(', code: withManifest("confirm('ok');"), error: 'forbidden pattern: confirm(' },
    { name: 'prompt(', code: withManifest("prompt('name');"), error: 'forbidden pattern: prompt(' },
    { name: 'javascript: URL', code: withManifest("var u = 'javascript:void(0)';"), error: 'forbidden pattern: javascript:' },
    {
      name: 'external URL',
      code: withManifest("var u = 'https://evil.example.com/x.js';"),
      error: 'external URL not allowed',
    },
    {
      name: 'oversized 600KB',
      code: withManifest('// ' + 'x'.repeat(600 * 1024)),
      error: 'artifact too large',
    },
    {
      name: 'missing manifest',
      code: '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>' +
        '<body><canvas id="c"></canvas><script>PlayLoop.ready(); PlayLoop.gameOver({ score: 1 });</script></body></html>',
      error: 'missing pl-manifest',
    },
    {
      name: 'truncated file (no closing html)',
      code: withManifest('var a = 1;').replace('</html>', ''),
      error: 'truncated artifact: missing closing </html>',
    },
  ];

  for (const bad of BAD) {
    it(`rejects ${bad.name} with the specific error`, () => {
      const result = validateGame(bad.code);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(bad.error);
    });
  }

  it('reports byte size of the artifact', () => {
    const code = withManifest('var x = 1;');
    expect(validateGame(code).bytes).toBe(new TextEncoder().encode(code).length);
    expect(validateGame('x'.repeat(600 * 1024)).bytes).toBeGreaterThan(500 * 1024);
  });

  it('rejects a truncated document even when everything else is valid', () => {
    const cut = withManifest('var a = 1;').replace('</html>', '');
    const errors = validateGame(cut).errors;
    expect(errors.some((e) => e.includes('missing closing </html>'))).toBe(true);

    const noScriptClose = withManifest('var a = 1;').replace('</script></body></html>', '</body></html>');
    expect(validateGame(noScriptClose).errors.some((e) => e.includes('unclosed <script>'))).toBe(true);

    const prose = "Here's a complete game with many fun features and levels.";
    expect(validateGame(prose).errors.some((e) => e.includes('missing <html> root element'))).toBe(true);
  });

  it('allows URLs in HTML and JS comments but not in code or strings', () => {
    const ok = withManifest('// see https://docs.example.com/a\nvar x = 1;\n') + '\n<!-- https://example.org/b -->';
    expect(validateGame(ok).errors).toEqual([]);
    const bad = withManifest("var u = 'https://cdn.example.com/lib.js';");
    expect(validateGame(bad).errors.some((e) => e.includes('external URL'))).toBe(true);
  });
});

describe('validateGame — warnings', () => {
  it('warns over the 300KB soft limit', () => {
    const result = validateGame(withManifest('// ' + 'y'.repeat(320 * 1024)));
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('artifact is large'))).toBe(true);
  });

  it('warns on missing viewport meta, PlayLoop.ready and PlayLoop.gameOver', () => {
    const bare = '<!doctype html><html><head></head><body><canvas id="c"></canvas><script>var x = 1;</script></body></html>';
    const result = validateGame(bare);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('missing pl-manifest');
    expect(result.warnings.some((w) => w.includes('viewport'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('PlayLoop.ready'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('PlayLoop.gameOver'))).toBe(true);
  });

  it('warns on a high-entropy string literal over 512 chars (embedded blob)', () => {
    const blob = pseudoRandomBase64(700);
    expect(shannonEntropy(blob)).toBeGreaterThan(4.5); // fixture sanity
    const result = validateGame(withManifest(`var blob = '${blob}';`));
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('high-entropy'))).toBe(true);
  });

  it('does not warn on a long low-entropy string literal', () => {
    const result = validateGame(withManifest(`var pad = '${'a'.repeat(600)}';`));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('does not warn when a high-entropy literal is at most 512 chars', () => {
    const result = validateGame(withManifest(`var blob = '${pseudoRandomBase64(512)}';`));
    expect(result.warnings.some((w) => w.includes('high-entropy'))).toBe(false);
  });
});

describe('extractManifest', () => {
  const EXPECTED = {
    title: 'Tap Demo',
    description: 'A demo game.',
    controls: 'tap',
    orientation: 'portrait',
    sdkVersion: 1,
    tags: ['arcade', 'demo'],
    scoring: 'higher',
  };

  it('reads the script-tag JSON format', () => {
    const html =
      '<script type="application/json" id="pl-manifest">\n' +
      '{"title":"Tap Demo","description":"A demo game.","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":["arcade","demo"],"scoring":"higher"}\n' +
      '</script>';
    expect(extractManifest(html)).toEqual(EXPECTED);
  });

  it('reads the HTML comment format', () => {
    const html =
      '<!-- pl-manifest: {"title":"Tap Demo","description":"A demo game.","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":["arcade","demo"],"scoring":"higher"} -->';
    expect(extractManifest(html)).toEqual(EXPECTED);
  });

  it('returns null when no manifest marker exists', () => {
    expect(extractManifest('<html><body>hi</body></html>')).toBeNull();
  });

  it('returns null on strict-JSON violations (e.g. trailing comma)', () => {
    const html = '<!-- pl-manifest: {"title":"T","description":"D","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":[], "scoring":"high",} -->';
    expect(extractManifest(html)).toBeNull();
  });

  it('returns null on structurally invalid manifests', () => {
    const bad = [
      '{"title":"","description":"D","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":[],"scoring":"higher"}',
      '{"title":"T","description":"D","controls":"blink","orientation":"portrait","sdkVersion":1,"tags":[],"scoring":"higher"}',
      '{"title":"T","description":"D","controls":"tap","orientation":"up","sdkVersion":1,"tags":[],"scoring":"higher"}',
      '{"title":"T","description":"D","controls":"tap","orientation":"portrait","sdkVersion":2,"tags":[],"scoring":"higher"}',
      '{"title":"T","description":"D","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":"a","scoring":"higher"}',
      '{"title":"T","description":"D","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":[],"scoring":"up"}',
    ];
    for (const json of bad) {
      expect(extractManifest(`<!-- pl-manifest: ${json} -->`)).toBeNull();
    }
  });

  it('validateGame reports invalid pl-manifest with a reason', () => {
    const html =
      '<!doctype html><html><head><script type="application/json" id="pl-manifest">{"title":"T"}</script></head>' +
      '<body><canvas></canvas><script>var a=1;</script></body></html>';
    const result = validateGame(html);
    expect(result.manifest).toBeNull();
    const manifestErrors = result.errors.filter((e) => e.includes('invalid pl-manifest'));
    expect(manifestErrors).toHaveLength(1);
    expect(manifestErrors[0]).toContain('controls');
  });
});

describe('comment strippers', () => {
  it('stripHtmlComments removes HTML comments only', () => {
    expect(stripHtmlComments('a<!-- x -->b')).toBe('ab');
  });

  it('stripJsComments removes JS comments but keeps strings', () => {
    expect(stripJsComments("var u = 'https://x.test'; // https://y.test\n/* https://z.test */ var v = 1;"))
      .toBe("var u = 'https://x.test'; \n var v = 1;");
  });
});

describe('good fixtures — zero errors and zero warnings', () => {
  const minimal = readFileSync(new URL('../fixtures/minimal-game.html', import.meta.url), 'utf8');

  it('accepts the minimal game fixture', () => {
    const result = validateGame(minimal);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.manifest?.title).toBe('Minimal Game');
  });

  it('rejects the missing-manifest fixture with exactly one error', () => {
    const code = readFileSync(new URL('../fixtures/missing-manifest.html', import.meta.url), 'utf8');
    const result = validateGame(code);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('missing pl-manifest');
    expect(result.warnings).toEqual([]);
  });
});
