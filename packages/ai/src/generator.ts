import { templates } from '@playloop/gamekit';
import { CODER_SYSTEM_PROMPT } from './prompts';
import { PERFORMANCE_RULES } from './playbook';
import type { AiProvider, GameDesign, GameSpec } from './types';

const NL = String.fromCharCode(10);

const HARD_RULES = `${PERFORMANCE_RULES}

CODE RULES
- Guard every canvas radius: Math.max(0, Number.isFinite(r) ? r : 0). A NaN radius throws and freezes the whole game.
- Clamp dt: const dt = Math.min((now - last) / 1000, 0.05).
- Start your reply with <!doctype html>. No preamble, no markdown fences. End with </html>.`;

/**
 * Engine instructions. Phaser is the default now, so the coder is told exactly
 * how to use it — including the two failures that look like "it loaded fine":
 * a plain object scene never gets update() called, and a missing top-level
 * declaration throws once per frame until the world stops moving.
 */
function runtimeBlock(runtime?: string): string {
  if (runtime !== 'phaser4') {
    return [
      'RUNTIME: micro (no engine). Draw with a single <canvas> and a 2D context.',
      '- requestAnimationFrame loop, ctx.setTransform for devicePixelRatio.',
    ].join(NL);
  }
  return [
    'RUNTIME: Phaser 4.2.1 is already loaded as window.Phaser. Do NOT include the engine in your file.',
    'Required shape:',
    '  class GameScene extends Phaser.Scene { constructor() { super({ key: "game" }); } create() {...} update(time, delta) {...} }',
    '  new Phaser.Game({ type: Phaser.AUTO, parent: "ph", backgroundColor: "#000", scale: { mode: Phaser.Scale.RESIZE }, scene: [GameScene] })',
    '- The scene MUST be a class. A plain { create, update } object is accepted but update() is never called: the game renders one frame and freezes while the loop still reports 60fps.',
    '- No assets, no loading: build everything from this.add.rectangle / circle / text / graphics and this.add.particles. No textures, no audio files — use WebAudio for sound.',
    '- Phaser owns the loop, so do not start your own requestAnimationFrame; put all gameplay in update(time, delta) and clamp dt = Math.min(delta, 50) / 1000.',
    '- Destroy and recreate pooled objects (pipes, bullets, enemies) instead of leaking them; the scene runs for minutes.',
    '- Your file still calls window.PlayLoop.ready() once, on create(), and PlayLoop.gameOver({score}) at the end.',
  ].join(NL);
}

function designBlock(design?: GameDesign): string {
  if (!design) return '';
  return [
    'DESIGN BRIEF (build exactly this):',
    `- Visual identity: ${design.visualIdentity}`,
    `- Palette: ${design.palette.join(', ')}`,
    `- HUD: ${design.hud.join('; ')}`,
    `- Assets: ${design.assetPlan.join('; ')}`,
    `- Juice: small=${design.juice.small}; medium=${design.juice.medium}; large=${design.juice.large}`,
    `- Difficulty: ${design.difficulty}`,
    `- Performance: ${design.performanceNotes.join('; ')}`,
    `- Must never happen: ${design.failureModes.join('; ')}`,
  ].join(NL);
}

/**
 * Pull the HTML document out of a model response.
 *
 * Models wrap the artifact inconsistently: a ```html fence, a bare ``` fence, a
 * <!DOCTYPE> with chatter before it, or a fence that never closes because the
 * completion was cut short. Strategy, most specific first:
 *   1. a complete fenced block
 *   2. an unterminated fence -> everything after it
 *   3. <!DOCTYPE ... </html> / <html ... </html>
 *   4. from <!DOCTYPE (or <html) to end of string (truncated output)
 * Anything else is returned trimmed so validation (not this function) decides.
 */
export function extractHtmlArtifact(raw: string): string {
  const completeFence = raw.match(/```(?:html|HTML)?\s*([\s\S]*?)```/);
  if (completeFence?.[1]?.trim()) return completeFence[1].trim();

  const openFence = raw.match(/```(?:html|HTML)?\s*([\s\S]*)$/);
  if (openFence?.[1]?.trim() && /<!doctype|<html/i.test(openFence[1])) {
    return openFence[1].trim();
  }

  const htmlTagMatch = raw.match(/(<!DOCTYPE[\s\S]*<\/html>|<html[\s\S]*<\/html>)/i);
  if (htmlTagMatch?.[1]) return htmlTagMatch[1].trim();

  const doctypeStart = raw.search(/<!doctype\s+html/i);
  if (doctypeStart !== -1) return raw.slice(doctypeStart).trim();
  const htmlStart = raw.search(/<html[\s>]/i);
  if (htmlStart !== -1) return raw.slice(htmlStart).trim();

  return raw.trim();
}

/** Strip a duplicate DOCTYPE that a truncated fence may leave behind. */
function normalizeDocument(html: string): string {
  const doctype = html.search(/<!doctype\s+html/i);
  if (doctype > 0) return html.slice(doctype);
  return html;
}

export type GenerateOptions = {
  baseCode?: string;
  isRemix?: boolean;
  /** Follow-up turn: apply a change to the existing artifact. */
  isEdit?: boolean;
  design?: GameDesign;
  /** Earlier turns in this session, oldest first. */
  history?: string[];
  /** Concrete defects from QA/runtime to fix in this pass. */
  feedback?: string[];
  imageDataUrl?: string;
};

/**
 * Write (or rewrite) the game.
 *
 * With `baseCode` this is an EDIT: the model is told to apply only the requested
 * change and return the whole document. That is what makes follow-up requests
 * ("make the jump higher", "add a shield pickup") stateful instead of a
 * from-scratch regeneration that forgets everything.
 */
export async function generateCode(
  userPrompt: string,
  spec: GameSpec,
  provider: AiProvider,
  options: GenerateOptions = {},
): Promise<string> {
  const historyBlock =
    options.history && options.history.length > 0
      ? [
          'Earlier requests in this session (oldest first, all must stay satisfied):',
          ...options.history.map((entry, index) => `${index + 1}. ${entry}`),
        ].join(NL)
      : '';
  const feedbackBlock =
    options.feedback && options.feedback.length > 0
      ? [
          'FIX THESE DEFECTS (found in the last build — every one must be addressed):',
          ...options.feedback.map((entry, index) => `${index + 1}. ${entry}`),
        ].join(NL)
      : '';

  if (options.baseCode) {
    const intent = options.isRemix
      ? 'Remix this game: keep the core idea and controls, but change the theme, feel and content as described.'
      : 'This is a follow-up change to the game below. Apply ONLY the requested change. Keep every mechanic, screen and control that already works; do not rewrite the file from scratch. Return the COMPLETE updated document.';
    const editPrompt = [
      intent,
      `Requested change: ${userPrompt}`,
      historyBlock,
      feedbackBlock,
      designBlock(options.design),
      runtimeBlock(spec.runtime),
      HARD_RULES,
      'Current game source:',
      options.baseCode,
    ]
      .filter(Boolean)
      .join(NL + NL);

    const response = await provider.generateText(editPrompt, {
      systemPrompt: CODER_SYSTEM_PROMPT,
      temperature: options.isRemix ? 0.7 : 0.5,
      images: options.imageDataUrl ? [options.imageDataUrl] : undefined,
    });
    return normalizeDocument(extractHtmlArtifact(response));
  }

  const template = templates().find((t) => t.id === spec.templateId) || templates()[0];
  const promptWithSpec = [
    'Create a complete mobile-first HTML5 game based on this specification:',
    '',
    `Concept: ${spec.concept}`,
    `Archetype: ${spec.templateId}`,
    `Mechanics: ${spec.coreMechanic}`,
    `Controls: ${spec.controls}`,
    `Palette: ${spec.palette.join(', ')}`,
    `Loss condition: ${spec.loseCondition}`,
    historyBlock,
    feedbackBlock,
    designBlock(options.design),
    runtimeBlock(spec.runtime),
    HARD_RULES,
    'One self-contained file under 30 KB (~700 lines). No external URLs, fonts, images or libraries.',
    'Show a start screen and wait for the first input before the simulation begins; never start moving on load.',
    options.imageDataUrl ? 'A concept image is attached: match its palette, mood and subject.' : '',
    // The archetype source is a crutch: with an art-direction brief it mostly
    // tempts the model to clone the toy template, and it costs ~4 KB of prompt.
    options.design ? '' : `Reference archetype code (structure only, do not copy its simplicity):${NL}${template?.code || ''}`,
  ]
    .filter(Boolean)
    .join(NL);

  const response = await provider.generateText(promptWithSpec, {
    systemPrompt: CODER_SYSTEM_PROMPT,
    temperature: 0.7,
    images: options.imageDataUrl ? [options.imageDataUrl] : undefined,
  });

  return normalizeDocument(extractHtmlArtifact(response));
}
