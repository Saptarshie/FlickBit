import { templates } from '@playloop/gamekit';
import { compactHistory, compactPrompt } from './context';
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
  if (runtime === 'babylon') {
    return [
      'RUNTIME: Babylon.js 9.36 is already loaded as window.BABYLON. Do NOT include the engine in your file.',
      'Available on window.BABYLON — this is the WHOLE list; anything else is undefined at runtime:',
      '  Engine, Scene, FreeCamera, ArcRotateCamera, UniversalCamera, HemisphericLight, DirectionalLight,',
      '  PointLight, MeshBuilder, Mesh, TransformNode, Vector3, Vector2, Color3, Color4, Matrix, Quaternion,',
      '  StandardMaterial, Texture, DynamicTexture, Scalar, Space, SceneLoader, Tools.',
      'Do not reach for ParticleSystem, SolidParticleSystem, GlowLayer, DefaultRenderingPipeline, Animation,',
      'PhysicsImpostor, GUI or NodeMaterial: they are not in the build. Faking particles with thin instances,',
      'MeshBuilder planes or a DynamicTexture sprite is expected.',
      'Required shape:',
      '  var engine = new BABYLON.Engine(canvas, true);',
      '  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));',
      '  var scene = new BABYLON.Scene(engine);',
      '  var camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 3.6, -8), scene); camera.setTarget(new BABYLON.Vector3(0, 2, 8));',
      '  scene.registerBeforeRender(function () { /* dt-driven gameplay */ });',
      '  engine.runRenderLoop(function () { scene.render(); });',
      '  window.addEventListener("resize", function () { engine.resize(); });',
      '- Babylon owns the loop: do not start your own requestAnimationFrame. Clamp dt = Math.min((now - last) / 1000, 0.05).',
      '- Build everything from MeshBuilder (box/sphere/cylinder/plane/ground/torus/disc) and StandardMaterial. No GLB, no textures on disk.',
      '- A 3D card must be readable at phone size: camera close to the action, strong emissive colours, fog (scene.fogMode = BABYLON.Scene.FOGMODE_EXP2) to hide the spawn edge.',
      '- Dispose meshes that leave the scene. Babylon keeps everything alive otherwise, and a runner leaks a mesh per second.',
      '- Put HUD text in DOM elements positioned with PlayLoop.safeArea (top / right / bottom), not in the 3D scene.',
      '- Call window.PlayLoop.ready() once, after the first scene.render(), and PlayLoop.gameOver({score}) when the run ends.',
    ].join(NL);
  }
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
    '- Build geometry from this.add.rectangle / circle / text / graphics and this.add.particles. For sprites, use the ASSETS block below (new Image + /a/<file>); there is no texture packer to call.',
    '- Audio is WebAudio (no files).',
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
  /**
   * What the platform can serve at /a/. Handed to the coder as a fixed
   * vocabulary, so the hero is a sprite and not an eight-pixel dot.
   */
  assetCatalogue?: Array<{ id: string; kind: string; width?: number; height?: number; file: string; tags: string[]; category?: string }>;
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
  const assetBlock =
    options.assetCatalogue && options.assetCatalogue.length > 0
      ? [
          'ASSETS — the platform already serves these at /a/, same origin as the frame.',
          'Use them instead of drawing a shape the player has to guess at. Do not invent paths.',
          ...options.assetCatalogue
            .slice(0, 24)
            .map(
              (a) =>
                `  ${a.id} [${a.category ?? a.kind}]${a.width ? ` ${a.width}x${a.height}` : ''} — /a/${a.file} — ${a.tags.slice(0, 4).join(', ')}`,
            ),
          'Load with: const img = new Image(); img.src = "/a/<file>"; img.onload = () => { ready2 = true; };',
          'Draw only after onload; keep the game playable while it loads (draw a placeholder, not a black screen).',
          'Set ctx.imageSmoothingEnabled = false for pixel art before drawing sprites.',
          'Declare every file you used in the manifest: "assets":[{"id":"coin","file":"<sha16>.webp"}].',
          'Sounds are in the same catalogue (kind sfx). Play them with PlayLoop.playSfx("<file>") — it caches, respects mute and swallows autoplay rejections. Never bundle audio bytes.',
          'Models are published as .glb. Load one with PlayLoop.loadModel(scene, "<file>") — it returns { root, meshes, animationGroups } parented to one node; move that node, not the meshes.',
          'The catalogue is organised in folders: 2d/characters, 2d/enemies, 2d/environments, 2d/tilesets, 2d/objects, 2d/effects, 3d/characters, 3d/environments, 3d/props, 3d/vehicles, 3d/weapons, ui/buttons, ui/panels, ui/icons, ui/hud, audio/sfx, audio/music. The list above is the shortlist chosen for this brief — if nothing fits, record that in pl-plan.todo instead of substituting a bad sprite.',
          'A visual contact sheet of each folder exists at /a/sheet-<folder with dashes>.webp (e.g. /a/sheet-2d-characters.webp); the reviewer looks at it, so keep names consistent with what you saw in the list.',
        ].join(NL)
      : '';

  // History is the only unbounded part of the prompt: compact it before it can
  // crowd out the code. The newest turns are the ones still in play.
  const history = compactHistory(options.history ?? [], 8);
  const historyBlock =
    history.kept.length > 0
      ? [
          history.omitted > 0
            ? `Earlier requests in this session (${history.omitted} older turn(s) omitted; the newest ${history.kept.length} follow and all must stay satisfied):`
            : 'Earlier requests in this session (oldest first, all must stay satisfied):',
          ...history.kept.map((entry, index) => `${index + 1}. ${entry}`),
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
    const editParts = [
      intent,
      `Requested change: ${userPrompt}`,
      historyBlock,
      feedbackBlock,
      assetBlock,
      designBlock(options.design),
      runtimeBlock(spec.runtime),
      HARD_RULES,
    ].filter(Boolean);

    // Single stateless call, but the brief + history + a 60 KB file can still add
    // up: compact rather than let the provider reject the request.
    const budget = Number(process.env.CONTEXT_BUDGET_TOKENS ?? 300_000);
    const parts = editParts.map((part) =>
      typeof part === 'string'
        ? { label: 'brief', text: part, priority: 40 }
        : (part as unknown as { label: string; text: string; priority: number }),
    );
    parts.push({ label: 'source', text: 'Current game source:' + NL + options.baseCode, priority: 100 });
    const compacted = compactPrompt(parts, budget);
    const editPrompt = compacted.text;
    if (compacted.dropped.length > 0) {
      console.warn(`[ai] context compacted: dropped ${compacted.dropped.join(', ')} (${compacted.tokens} tokens)`);
    }

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
    assetBlock,
    designBlock(options.design),
    runtimeBlock(spec.runtime),
    HARD_RULES,
    assetBlock
      ? 'One self-contained file under 30 KB (~700 lines). No external URLs, fonts or libraries — the only permitted network reference is /a/ (the asset catalogue).'
      : 'One self-contained file under 30 KB (~700 lines). No external URLs, fonts, images or libraries.',
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
