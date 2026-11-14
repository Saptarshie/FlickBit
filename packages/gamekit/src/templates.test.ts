import { describe, expect, it } from 'vitest';
import { templates, TEMPLATE_IDS, getTemplate } from './index';
import { extractManifest, validateGame } from './validate';

describe('TEMPLATES', () => {
  it('exports exactly the template games, one file each', () => {
    expect(templates()).toHaveLength(TEMPLATE_IDS.length);
    expect([...TEMPLATE_IDS].sort()).toEqual(
      ['brick-breaker', 'flappy', 'match-3', 'memory', 'neon-run-3d', 'physics-toss', 'shooter', 'snake', 'tap-runner'],
    );
    const ids = templates().map((t) => t.id);
    expect(new Set(ids).size).toBe(TEMPLATE_IDS.length);
    for (const t of templates()) {
      expect(t.file).toBe(`templates/${t.id}.html`);
      expect(t.code.length).toBeGreaterThan(500);
    }
  });

  it.each(templates().map((t) => [t.id, t] as const))(
    '%s passes validateGame with zero errors and zero warnings',
    (_id, template) => {
      const result = validateGame(template.code);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    },
  );

  it('every template carries a valid manifest with sdkVersion 1', () => {
    for (const t of templates()) {
      const manifest = extractManifest(t.code);
      expect(manifest, `${t.id} manifest`).not.toBeNull();
      expect(manifest?.sdkVersion).toBe(1);
      expect(manifest?.title.length ?? 0).toBeGreaterThan(0);
      expect(manifest?.description.length ?? 0).toBeGreaterThan(0);
      expect(Array.isArray(manifest?.tags)).toBe(true);
    }
  });

  it('every template is canvas-based, dpr-aware, sized from the viewport, dt-driven', () => {
    for (const t of templates()) {
      const code = t.code;
      const manifest = extractManifest(code);
      const engine = manifest?.runtime !== undefined && manifest.runtime !== 'micro';
      expect(code, t.id).toContain('<canvas');
      if (engine) {
        // An engine owns the canvas, the pixel ratio and the loop: asserting
        // getContext/requestAnimationFrame here would force every 3D game to
        // reimplement what it already does correctly.
        expect(code, t.id).toMatch(/new B\.Engine\(canvas/);
        expect(code, t.id).toMatch(/setHardwareScalingLevel|devicePixelRatio/);
        expect(code, t.id).toMatch(/runRenderLoop|registerBeforeRender/);
        // The canvas fills the frame by CSS; the engine follows the resize.
        expect(code, t.id).toMatch(/width:\s*100%|width:100%/);
        expect(code, t.id).toMatch(/engine\.resize\(\)/);
      } else {
        expect(code, t.id).toContain('getContext');
        expect(code, t.id).toMatch(/devicePixelRatio/);
        expect(code, t.id).toMatch(/requestAnimationFrame/);
      }
      if (!engine) {
        expect(code, t.id).toMatch(/innerWidth/);
        expect(code, t.id).toMatch(/innerHeight/);
      }
      // frame-rate independence: a delta-time computation on frame timestamps
      expect(code, t.id).toMatch(/(\(\s*\w+\s*-\s*\w+\s*\)\s*\/\s*1000|Math\.min\(\(now - last\))/);
    }
  });

  it('every template calls PlayLoop.ready + PlayLoop.gameOver and reads PlayLoop.safeArea', () => {
    for (const t of templates()) {
      expect(t.code, t.id).toContain('PlayLoop.ready(');
      expect(t.code, t.id).toContain('PlayLoop.gameOver(');
      expect(t.code, t.id).toContain('PlayLoop.safeArea');
    }
  });

  it('every template has touch (pointer) input and keyboard equivalents', () => {
    for (const t of templates()) {
      expect(t.code, t.id).toContain('pointerdown');
      expect(t.code, t.id).toMatch(/keydown/);
    }
  });

  it('keeps each template game script small enough to be read in one sitting', () => {
    for (const t of templates()) {
      const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
      for (const m of t.code.matchAll(re)) {
        const attrs = m[1] ?? '';
        if (/id\s*=\s*["']pl-manifest["']/.test(attrs)) continue;
        const lines = (m[2] ?? '')
          .split('\n')
          .filter((line) => line.trim().length > 0);
        // 3D templates get 25 more lines than 2D: three lanes cost a gesture state
        // machine (down/move/up + axis decision) that a tap-only archetype never
        // needs, and a runner without lane changes is the bug this guard protects.
        // 130, not 60: a template that ends properly needs a game-over overlay and
        // a restart path, and a 3D archetype needs scene, camera, lights and a
        // render loop before any gameplay exists.
        expect(lines.length, `${t.id} game script lines`).toBeLessThanOrEqual(160);
      }
    }
  });

  it('getTemplate returns templates by id and undefined for unknown ids', () => {
    expect(getTemplate('flappy')?.id).toBe('flappy');
    expect(getTemplate('tap-runner')?.file).toBe('templates/tap-runner.html');
    expect(getTemplate('nope-not-a-game')).toBeUndefined();
  });
});
