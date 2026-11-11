import { templates } from '@playloop/gamekit';
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

    // 1b. Art director request
    if (sys.includes('art director')) {
      return JSON.stringify({
        visualIdentity: 'Flat neon geometry on a deep field; one accent colour marks the player.',
        palette: ['#0b1020', '#38bdf8', '#fb7185', '#34d399', '#fde047'],
        hud: ['score top-centre', 'best under it'],
        assetPlan: ['player: glowing triangle', 'hazard: rotating square', 'background: starfield'],
        juice: { small: 'tick + 5 particles', medium: 'hit + 10 particles + 60ms stop', large: 'boom + 30 particles + shake' },
        difficulty: 'speed +8% per 10 points, capped at 2.4x',
        performanceNotes: ['pool particles', 'cache starfield'],
        failureModes: ['non-finite radius', 'input blocked during feedback'],
      });
    }

    // 1c. QA review request
    if (sys.includes('senior QA engineer')) {
      return JSON.stringify({ verdict: 'ship', summary: 'Playable and readable.', issues: [] });
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
      const template = templates().find((t) => t.id === 'tap-runner') ?? templates()[0];
      return template?.code ?? '<html><body><script>window.playloop?.ready();</script></body></html>';
    }

    // 4. Code generator request
    if (this.customCodeGenerator) {
      return this.customCodeGenerator(prompt);
    }

    // Pick template matching prompt or default
    let chosenTemplate = templates()[0];
    for (const t of templates()) {
      if (prompt.toLowerCase().includes(t.id)) {
        chosenTemplate = t;
        break;
      }
    }

    if (chosenTemplate) {
      return chosenTemplate.code;
    }

    return templates()[0]?.code ?? '';
  }
}
