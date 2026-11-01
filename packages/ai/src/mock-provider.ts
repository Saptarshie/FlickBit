import { TEMPLATES } from '@playloop/gamekit';
import type { AiProvider } from './types';

export class MockAiProvider implements AiProvider {
  private customCodeGenerator?: (prompt: string) => string;

  constructor(options: { customCodeGenerator?: (prompt: string) => string } = {}) {
    this.customCodeGenerator = options.customCodeGenerator;
  }

  async generateText(
    prompt: string,
    options: { systemPrompt?: string; temperature?: number } = {}
  ): Promise<string> {
    const sys = options.systemPrompt ?? '';

    // 1. Planner request
    if (sys.includes('specializing in hyper-casual') || prompt.includes('Create a specification')) {
      let templateId = 'tap-runner';
      if (prompt.includes('flappy') || prompt.includes('bird')) templateId = 'flappy';
      if (prompt.includes('snake')) templateId = 'snake';
      if (prompt.includes('brick') || prompt.includes('pong')) templateId = 'brick-breaker';
      if (prompt.includes('match') || prompt.includes('gem')) templateId = 'match-3';
      if (prompt.includes('shooter') || prompt.includes('space')) templateId = 'shooter';
      if (prompt.includes('physics') || prompt.includes('toss')) templateId = 'physics-toss';

      return JSON.stringify({
        title: 'Mock Vibe Game',
        concept: 'A high-energy mobile arcade game created with AI',
        genre: 'arcade',
        templateId,
        coreMechanic: 'Tap to jump and dodge hazards',
        controls: 'Tap to jump',
        palette: ['#38bdf8', '#fb7185', '#34d399', '#fde047', '#0f172a'],
        loseCondition: 'Lose all lives on hitting spikes',
        audioNotes: 'Chiptune sound effects',
      });
    }

    // 2. Metadata request
    if (sys.includes('Generate concise metadata')) {
      return JSON.stringify({
        title: 'Neon Dash',
        description: 'Dodge glowing neon obstacles in this fast-paced mobile runner.',
        tags: ['arcade', 'runner', 'cyberpunk'],
        controls: 'Tap to jump',
        orientation: 'portrait',
      });
    }

    // 3. Repair request
    if (sys.includes('debugging assistant') || prompt.includes('violations')) {
      // If code was broken, return a clean template
      const template = TEMPLATES.find((t) => t.id === 'tap-runner') ?? TEMPLATES[0];
      return template?.code ?? '<html><body><script>window.playloop?.ready();</script></body></html>';
    }

    // 4. Code generator request
    if (this.customCodeGenerator) {
      return this.customCodeGenerator(prompt);
    }

    // Pick template matching prompt or default
    let chosenTemplate = TEMPLATES[0];
    for (const t of TEMPLATES) {
      if (prompt.toLowerCase().includes(t.id)) {
        chosenTemplate = t;
        break;
      }
    }

    if (chosenTemplate) {
      return chosenTemplate.code;
    }

    return TEMPLATES[0]?.code ?? '';
  }
}
