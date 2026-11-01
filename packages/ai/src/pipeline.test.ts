import { describe, it, expect } from 'vitest';
import { MockAiProvider } from './mock-provider';
import { planGame } from './planner';
import { extractHtmlArtifact } from './generator';
import { extractOrGenerateMetadata } from './metadata';
import { runGenerationPipeline } from './pipeline';
import type { GenerationProgress } from './types';

describe('packages/ai pipeline', () => {
  const mockProvider = new MockAiProvider();

  it('plans a game concept and chooses appropriate archetype', async () => {
    const spec = await planGame('A bird flapping between pipes in a retro city', mockProvider);
    expect(spec.title).toBeDefined();
    expect(spec.templateId).toBe('flappy');
    expect(spec.controls).toBeDefined();
  });

  it('extracts clean HTML from code blocks or doctype tags', () => {
    const rawWithMarkdown = 'Here is your game:\n```html\n<!DOCTYPE html><html><body><h1>Test</h1></body></html>\n```\nEnjoy!';
    const extracted = extractHtmlArtifact(rawWithMarkdown);
    expect(extracted).toBe('<!DOCTYPE html><html><body><h1>Test</h1></body></html>');
  });

  it('extracts metadata from code or falls back to spec', async () => {
    const spec = {
      title: 'Neon Snake',
      concept: 'A glowing snake eating cyber orbs',
      genre: 'arcade',
      templateId: 'snake',
      coreMechanic: 'Swipe to turn',
      controls: 'Swipe gestures',
      palette: ['#000', '#fff'],
      loseCondition: 'Wall collision',
    };
    const codeWithManifest = `
      <!DOCTYPE html><html><head>
      <script type="application/json" id="pl-manifest">
      {"title":"Embedded Neon Snake","description":"A glowing snake eating cyber orbs","controls":"swipe","orientation":"portrait","sdkVersion":1,"tags":["cyber","arcade"],"scoring":"higher"}
      </script></head><body></body></html>
    `;
    const meta = await extractOrGenerateMetadata(codeWithManifest, spec, mockProvider);
    expect(meta.title).toBe('Embedded Neon Snake');
    expect(meta.tags).toContain('cyber');
  });

  it('runs the full generation pipeline and emits ordered progress events', async () => {
    const events: GenerationProgress[] = [];
    const result = await runGenerationPipeline(
      {
        prompt: 'Create a space shooter with asteroids and laser cannons',
        onProgress: (p) => events.push(p),
      },
      mockProvider
    );

    expect(result.code).toBeTruthy();
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.validateReport.errors).toHaveLength(0);
    expect(result.metadata.title).toBeTruthy();

    // Check event stages sequence
    const stages = events.map((e) => e.stage);
    expect(stages).toContain('spec');
    expect(stages).toContain('generating');
    expect(stages).toContain('validating');
    expect(stages).toContain('metadata');
    expect(stages[stages.length - 1]).toBe('done');
  });

  it('triggers repair loop when initial code fails validation and repairs it', async () => {
    let callCount = 0;
    const buggyProvider = new MockAiProvider({
      customCodeGenerator: () => {
        callCount++;
        if (callCount === 1) {
          // Introduce violation: external script tag
          return '<!DOCTYPE html><html><head><script src="https://evil.com/hax.js"></script></head><body><script>window.playloop?.ready();</script></body></html>';
        }
        // Repaired code on subsequent calls
        return '<!DOCTYPE html><html><head><script type="application/json" id="pl-manifest">{"title":"Repaired","description":"Fixed game","controls":"tap","orientation":"portrait","sdkVersion":1,"tags":["game"],"scoring":"higher"}</script></head><body><script>window.playloop?.ready();</script></body></html>';
      },
    });

    const result = await runGenerationPipeline(
      {
        prompt: 'Fixable game idea',
        maxRepairs: 2,
      },
      buggyProvider
    );

    expect(result.repairsCount).toBeGreaterThanOrEqual(1);
    expect(result.validateReport.errors).toHaveLength(0);
    expect(result.code).not.toContain('evil.com');
  });
});
