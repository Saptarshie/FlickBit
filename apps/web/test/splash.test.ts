import { describe, expect, it } from 'vitest';
import { SPLASH_MAX_MS, SPLASH_MIN_MS, shouldShowSplash, splashDone } from '../src/lib/splash';
import { stampRuntime } from '@playloop/gamekit';
import { extractManifest } from '@playloop/gamekit';

const MANIFEST_JSON =
  '{"title":"T","description":"D","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":["arcade"],"scoring":"higher"}';

function artifact(manifest = MANIFEST_JSON): string {
  return [
    '<!doctype html><html><head>',
    `<script type="application/json" id="pl-manifest">${manifest}</script>`,
    '</head><body><canvas id="c"></canvas><script>PlayLoop.ready();</script></body></html>',
  ].join('');
}

describe('splash decisions', () => {
  it('shows once per session, and honours reduce-motion', () => {
    expect(shouldShowSplash({ seen: false, reducedMotion: false })).toBe(true);
    expect(shouldShowSplash({ seen: true, reducedMotion: false })).toBe(false);
    expect(shouldShowSplash({ seen: false, reducedMotion: true })).toBe(false);
  });

  it('never flashes for less than the minimum, never holds past the maximum', () => {
    // Feed ready immediately, but the brand beat has not happened yet.
    expect(splashDone(120, true)).toBe(false);
    // Brand beat done, but the feed has not painted: keep waiting.
    expect(splashDone(SPLASH_MIN_MS + 400, false)).toBe(false);
    // Both satisfied.
    expect(splashDone(SPLASH_MIN_MS, true)).toBe(true);
    // A dead database must not own the screen forever.
    expect(splashDone(SPLASH_MAX_MS, false)).toBe(true);
  });
});

describe('stampRuntime', () => {
  it('adds the engine pin to an existing manifest without disturbing the rest', () => {
    const stamped = stampRuntime(artifact(), { runtime: 'phaser4', runtimeVersion: '4.2.1' });
    expect(extractManifest(stamped)).toMatchObject({
      title: 'T',
      runtime: 'phaser4',
      runtimeVersion: '4.2.1',
      scoring: 'higher',
    });
  });

  it('leaves micro implicit — an engine-less game keeps a byte-identical manifest', () => {
    const stamped = stampRuntime(artifact(), { runtime: 'micro' });
    expect(extractManifest(stamped)?.runtime).toBeUndefined();
    expect(stamped).toContain('"title":"T"');
    expect(stamped).not.toContain('"runtime"');
  });

  it('overwrites a runtime the model invented', () => {
    const wrong = artifact(MANIFEST_JSON.replace('"scoring":"higher"', '"scoring":"higher","runtime":"babylon"'));
    const stamped = stampRuntime(wrong, { runtime: 'phaser4', runtimeVersion: '4.2.1' });
    expect(extractManifest(stamped)?.runtime).toBe('phaser4');
  });

  it('does nothing to a document with no manifest (the validator reports that)', () => {
    const noManifest = '<!doctype html><html><body>hi</body></html>';
    expect(stampRuntime(noManifest, { runtime: 'phaser4' })).toBe(noManifest);
  });
});
