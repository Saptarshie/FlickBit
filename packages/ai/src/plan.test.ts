import { describe, expect, it } from 'vitest';
import { extractPlan, journalSummary, planSummary, sectionIndex } from './plan';
import { repairCode } from './repair';
import type { AiProvider } from './types';

const PLAN = {
  sections: ['1 CONFIG', '2 AUDIO', '3 ENTITIES', '4 HUD', '5 UPDATE', '6 RENDER', '7 LOOP'],
  stateMachine: 'start -> playing -> over -> start',
  input: 'tap: jump',
  entities: ['player', 'spike'],
  score: '+1 per spike cleared',
  hud: 'score top-centre inside safeArea',
  todo: [] as string[],
};

const html = `<!doctype html><html><head>
<script type="application/json" id="pl-plan">${JSON.stringify(PLAN)}</script>
</head><body><script>
// == 1 CONFIG ==
const W = 390;
// == 3 ENTITIES ==
const player = { x: 10 };
// == 7 LOOP ==
requestAnimationFrame(function l(t){ return l(t); });
</script></body></html>`;

describe('plan block', () => {
  it('reads the plan the coder wrote', () => {
    const plan = extractPlan(html);
    expect(plan?.stateMachine).toBe('start -> playing -> over -> start');
    expect(plan?.entities).toContain('player');
  });

  it('returns null instead of throwing on a missing or broken block', () => {
    expect(extractPlan('<html><body>no plan</body></html>')).toBeNull();
    expect(extractPlan('<script type="application/json" id="pl-plan">{ not json }</script>')).toBeNull();
  });

  it('summarises as labelled lines, not raw JSON', () => {
    const text = planSummary(PLAN);
    expect(text).toContain('state machine: start -> playing -> over -> start');
    expect(text).toContain('entities: player, spike');
    expect(text).not.toContain('{"');
  });

  it('finds the section markers in the code', () => {
    expect(sectionIndex(html)).toEqual(['1 CONFIG', '3 ENTITIES', '7 LOOP']);
  });

  it('summarises the repair journal one line per attempt', () => {
    const text = journalSummary([
      { attempt: 1, stage: 'playtest', issue: 'the picture never changed after input' },
      { attempt: 2, stage: 'visual', issue: 'HUD under the profile row' },
    ]);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('[playtest #1]');
    expect(text).toContain('[visual #2]');
  });
});

describe('repair prompt carries the state', () => {
  const recorder = () => {
    let seen = '';
    const provider = {
      async generateText(prompt: string) {
        seen = prompt;
        return html;
      },
      async generateJson<T>() {
        return {} as T;
      },
      async embed() {
        return [];
      },
    } as unknown as AiProvider;
    return { provider, seen: () => seen };
  };

  it('passes the plan, the journal and the section list to the repair pass', async () => {
    const { provider, seen } = recorder();
    await repairCode(html, { ok: false, errors: ['smoke failed'], warnings: [] } as never, provider, ['it froze'], {
      plan: extractPlan(html),
      journal: [{ attempt: 1, stage: 'assets', issue: 'dropped the sprite it had added' }],
      sections: sectionIndex(html),
    });
    const prompt = seen();
    expect(prompt).toContain('state machine: start -> playing -> over -> start');
    expect(prompt).toContain('do not undo these');
    expect(prompt).toContain('[assets #1]');
    expect(prompt).toContain('3 ENTITIES');
    // The rules are repeated right before the document, not only at the top.
    const tail = prompt.slice(prompt.indexOf('re-check against these'));
    expect(tail).toContain('pl-plan block is still present');
    // Order matters: plan and journal first, then the re-check list, then the code.
    const checklist = prompt.indexOf('pl-plan block is still present');
    expect(checklist).toBeGreaterThan(prompt.indexOf('state machine:'));
    expect(prompt.lastIndexOf('requestAnimationFrame')).toBeGreaterThan(checklist);
  });

  it('asks for a plan block when the artifact has none', async () => {
    const { provider, seen } = recorder();
    await repairCode('<html></html>', { ok: false, errors: ['x'], warnings: [] } as never, provider);
    expect(seen()).toContain('has no <script id="pl-plan"> block');
  });
});
