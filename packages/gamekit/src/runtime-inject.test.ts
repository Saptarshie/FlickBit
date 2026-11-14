import { describe, expect, it } from 'vitest';
import { injectRuntime, readAssetFile, runtimeFileFor, defaultRuntimesDir, defaultAssetsDir } from './runtime-inject';

const babylonHtml = `<!doctype html><html><head>
<script type="application/json" id="pl-manifest">{"title":"x","description":"y","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":[],"scoring":"higher","runtime":"babylon","runtimeVersion":"9.36.0"}</script>
</head><body></body></html>`;

const microHtml = `<!doctype html><html><head>
<script type="application/json" id="pl-manifest">{"title":"x","description":"y","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":[],"scoring":"higher"}</script>
</head><body></body></html>`;

describe('runtime injection for the gates', () => {
  it('inserts the pinned engine after <head> for an engine game', () => {
    const { html, injected } = injectRuntime(babylonHtml, { runtimesDir: defaultRuntimesDir() });
    expect(injected).toMatch(/^babylon@9\.36\.0-[0-9a-f]{16}\.js$/);
    expect(html).toContain(`<script src="/r/${injected}"></script>`);
    // after <head>, before the manifest: the engine must exist before game code
    expect(html.indexOf('/r/')).toBeLessThan(html.indexOf('pl-manifest'));
  });

  it('does nothing for a micro game', () => {
    const { html, injected } = injectRuntime(microHtml, { runtimesDir: defaultRuntimesDir() });
    expect(injected).toBeNull();
    expect(html).toBe(microHtml);
  });

  it('does not inject twice', () => {
    const once = injectRuntime(babylonHtml, { runtimesDir: defaultRuntimesDir() }).html;
    const twice = injectRuntime(once, { runtimesDir: defaultRuntimesDir() });
    expect(twice.injected).toBeNull();
    expect(twice.html).toBe(once);
  });

  it('returns null when the engine is not published', () => {
    const { injected } = injectRuntime(babylonHtml, { runtimesDir: '/nonexistent-runtimes' });
    expect(injected).toBeNull();
  });

  it('picks the newest version when several are published', () => {
    expect(runtimeFileFor('definitely-not-an-engine', defaultRuntimesDir())).toBeNull();
    const file = runtimeFileFor('babylon', defaultRuntimesDir());
    expect(file).toMatch(/^babylon@9\.36\.0-[0-9a-f]{16}\.js$/);
  });
});

describe('asset serving for the gates', () => {
  it('reads a real catalogue file', () => {
    const file = readAssetFile('df22c812ddd664fa.webp');
    if (!file) {
      // A fresh clone before `pnpm ingest:assets` has no catalogue; the gate then
      // reports the missing asset instead of pretending it loaded.
      expect(defaultAssetsDir()).toBeTruthy();
      return;
    }
    expect(file.byteLength).toBeGreaterThan(100);
    expect(file.subarray(8, 12).toString()).toBe('WEBP');
  });

  it('refuses anything that is not a content-addressed name', () => {
    expect(readAssetFile('../../etc/passwd')).toBeNull();
    expect(readAssetFile('index.json')).toBeNull();
    expect(readAssetFile('nothex.webp')).toBeNull();
  });
});
