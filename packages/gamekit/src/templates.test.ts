import { describe, expect, it } from 'vitest';
import { templates, TEMPLATE_IDS, getTemplate } from './index';
import { extractManifest, validateGame } from './validate';

describe('TEMPLATES', () => {
  it('exports exactly the 8 template games, one file each', () => {
    expect(templates()).toHaveLength(8);
    expect([...TEMPLATE_IDS].sort()).toEqual(
      ['brick-breaker', 'flappy', 'match-3', 'memory', 'physics-toss', 'shooter', 'snake', 'tap-runner'],
    );
    const ids = templates().map((t) => t.id);
    expect(new Set(ids).size).toBe(8);
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

  it('every template is canvas-based, dpr-aware, sized from innerWidth/innerHeight, dt-driven', () => {
    for (const t of templates()) {
      const code = t.code;
      expect(code, t.id).toContain('getContext');
      expect(code, t.id).toMatch(/devicePixelRatio/);
      expect(code, t.id).toMatch(/innerWidth/);
      expect(code, t.id).toMatch(/innerHeight/);
      expect(code, t.id).toMatch(/requestAnimationFrame/);
      // frame-rate independence: a delta-time computation on frame timestamps
      expect(code, t.id).toMatch(/\(\s*\w+\s*-\s*\w+\s*\)\s*\/\s*1000/);
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

  it('keeps each template game script to about 60 lines of JS', () => {
    for (const t of templates()) {
      const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
      for (const m of t.code.matchAll(re)) {
        const attrs = m[1] ?? '';
        if (/id\s*=\s*["']pl-manifest["']/.test(attrs)) continue;
        const lines = (m[2] ?? '')
          .split('\n')
          .filter((line) => line.trim().length > 0);
        expect(lines.length, `${t.id} game script lines`).toBeLessThanOrEqual(60);
      }
    }
  });

  it('getTemplate returns templates by id and undefined for unknown ids', () => {
    expect(getTemplate('flappy')?.id).toBe('flappy');
    expect(getTemplate('tap-runner')?.file).toBe('templates/tap-runner.html');
    expect(getTemplate('nope-not-a-game')).toBeUndefined();
  });
});
