/**
 * The starter pack.
 *
 * These are ours: simple vector shapes rendered through the same pipeline as any
 * imported pack, so the first game that uses assets is not also the first test of
 * the pipeline. CC0 by construction — we made them.
 *
 * The point is not that these sixteen images are beautiful. The point is that the
 * agent has a *vocabulary* it can reach for, each item with a known size, known
 * licence and a content-addressed URL, instead of drawing a dark green dot and
 * hoping the player finds it.
 */
import sharp from 'sharp';
import type { AssetKind } from './registry';

export type StarterEntry = {
  id: string;
  name: string;
  kind: AssetKind;
  tags: string[];
  /** Rendered at this size before optimisation. */
  size: { width: number; height: number };
  svg: string;
};

const sprite = (body: string, width = 128, height = 128): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 128 128">${body}</svg>`;

export function starterPack(): StarterEntry[] {
  return [
    {
      id: 'hero_runner',
      name: 'Runner Hero',
      kind: 'sprite',
      tags: ['character', 'player', 'platformer', 'runner'],
      size: { width: 128, height: 128 },
      svg: sprite(`
        <circle cx="64" cy="34" r="18" fill="#ffd166"/>
        <rect x="46" y="54" width="36" height="42" rx="12" fill="#7ee0c1"/>
        <rect x="48" y="94" width="12" height="26" rx="6" fill="#2b6f7d"/>
        <rect x="68" y="94" width="12" height="26" rx="6" fill="#2b6f7d"/>
        <circle cx="58" cy="32" r="3.5" fill="#10202e"/>
        <circle cx="72" cy="32" r="3.5" fill="#10202e"/>`),
    },
    {
      id: 'enemy_blob',
      name: 'Blob Enemy',
      kind: 'sprite',
      tags: ['character', 'enemy', 'platformer', 'blob'],
      size: { width: 128, height: 128 },
      svg: sprite(`
        <path d="M64 22c26 0 42 22 42 48s-18 34-42 34S22 94 22 70 38 22 64 22z" fill="#e5548c"/>
        <circle cx="50" cy="62" r="8" fill="#fff"/><circle cx="78" cy="62" r="8" fill="#fff"/>
        <circle cx="50" cy="62" r="4" fill="#10202e"/><circle cx="78" cy="62" r="4" fill="#10202e"/>
        <path d="M52 84q12 10 24 0" stroke="#10202e" stroke-width="4" fill="none" stroke-linecap="round"/>`),
    },
    {
      id: 'coin',
      name: 'Coin',
      kind: 'icon',
      tags: ['currency', 'pickup', 'ui'],
      size: { width: 64, height: 64 },
      svg: sprite(`
        <circle cx="64" cy="64" r="52" fill="#ffd166"/>
        <circle cx="64" cy="64" r="40" fill="#f4a72c"/>
        <rect x="58" y="40" width="12" height="48" rx="6" fill="#8a4b00"/>`, 128, 128),
    },
    {
      id: 'heart',
      name: 'Heart',
      kind: 'icon',
      tags: ['life', 'hud', 'ui'],
      size: { width: 64, height: 64 },
      svg: sprite(`
        <path d="M64 104S20 78 20 50a24 24 0 0 1 44-13 24 24 0 0 1 44 13c0 28-44 54-44 54z" fill="#ff5d73"/>
        <path d="M44 40a12 12 0 0 1 12 6" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/>`, 128, 128),
    },
    {
      id: 'star',
      name: 'Star',
      kind: 'icon',
      tags: ['pickup', 'score', 'ui'],
      size: { width: 64, height: 64 },
      svg: sprite(`
        <path d="M64 18l13 30 33 3-25 22 7 32-28-17-28 17 7-32-25-22 33-3z" fill="#ffe066" stroke="#b78900" stroke-width="4"/>`, 128, 128),
    },
    {
      id: 'spike',
      name: 'Spike',
      kind: 'sprite',
      tags: ['hazard', 'level', 'platformer'],
      size: { width: 128, height: 64 },
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64" viewBox="0 0 128 64">
        <path d="M0 64L32 8l32 56z" fill="#c9d6e3"/><path d="M32 64L64 8l32 56z" fill="#9fb2c4"/>
        <path d="M64 64L96 8l32 56z" fill="#c9d6e3"/></svg>`,
    },
    {
      id: 'platform',
      name: 'Platform Tile',
      kind: 'tileset',
      tags: ['level', 'platformer', 'tile'],
      size: { width: 128, height: 48 },
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="48" viewBox="0 0 128 48">
        <rect width="128" height="48" rx="8" fill="#3c6e57"/><rect width="128" height="12" rx="6" fill="#7ee0c1"/>
        <rect x="16" y="24" width="10" height="10" fill="#2c5541"/><rect x="72" y="24" width="10" height="10" fill="#2c5541"/></svg>`,
    },
    {
      id: 'brick',
      name: 'Brick',
      kind: 'tileset',
      tags: ['level', 'breakout', 'tile'],
      size: { width: 96, height: 48 },
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48" viewBox="0 0 96 48">
        <rect width="96" height="48" rx="6" fill="#e5548c"/><rect x="6" y="6" width="39" height="15" rx="4" fill="#ff8fb5"/>
        <rect x="51" y="6" width="39" height="15" rx="4" fill="#ff8fb5"/><rect x="6" y="27" width="39" height="15" rx="4" fill="#ff8fb5"/>
        <rect x="51" y="27" width="39" height="15" rx="4" fill="#ff8fb5"/></svg>`,
    },
    {
      id: 'sky_gradient',
      name: 'Sky Background',
      kind: 'background',
      tags: ['background', 'sky', 'outdoor'],
      size: { width: 1170, height: 2532 },
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">
        <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#0b1e3a"/><stop offset="0.55" stop-color="#1d4e89"/><stop offset="1" stop-color="#77c7d9"/>
        </linearGradient></defs>
        <rect width="390" height="844" fill="url(#s)"/>
        <circle cx="300" cy="150" r="46" fill="#ffe9b0" opacity="0.9"/>
        <path d="M0 640q90-60 180 0t210 0v204H0z" fill="#12304f" opacity="0.85"/></svg>`,
    },
    {
      id: 'neon_grid',
      name: 'Neon Grid Background',
      kind: 'background',
      tags: ['background', 'neon', 'retro', 'synth'],
      size: { width: 1170, height: 2532 },
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">
        <rect width="390" height="844" fill="#12021f"/>
        <g stroke="#ff2fd6" stroke-width="2" opacity="0.75">
          <path d="M195 420L-40 844M195 420L60 844M195 420L195 844M195 420L330 844M195 420L430 844"/>
        </g>
        <g stroke="#2ff6ff" stroke-width="1.5" opacity="0.5">
          <path d="M0 470h390M0 520h390M0 590h390M0 680h390M0 800h390"/>
        </g>
        <circle cx="195" cy="420" r="70" fill="#ff2fd6" opacity="0.18"/></svg>`,
    },
    {
      id: 'hud_panel',
      name: 'HUD Panel',
      kind: 'ui',
      tags: ['ui', 'panel', 'hud'],
      size: { width: 320, height: 96 },
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96" viewBox="0 0 320 96">
        <rect x="4" y="4" width="312" height="88" rx="20" fill="#0d1b2a" opacity="0.82"/>
        <rect x="4" y="4" width="312" height="88" rx="20" fill="none" stroke="#7ee0c1" stroke-width="3" opacity="0.7"/></svg>`,
    },
    {
      id: 'btn_pill',
      name: 'Button Pill',
      kind: 'ui',
      tags: ['ui', 'button', 'controls'],
      size: { width: 256, height: 88 },
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="88" viewBox="0 0 256 88">
        <rect x="3" y="3" width="250" height="82" rx="41" fill="#7ee0c1"/>
        <rect x="3" y="3" width="250" height="82" rx="41" fill="none" stroke="#2b6f7d" stroke-width="4"/></svg>`,
    },
  ];
}

/** Render one entry to a PNG buffer, ready for the optimiser. */
export async function renderStarter(entry: StarterEntry): Promise<Buffer> {
  return sharp(Buffer.from(entry.svg), { density: 192 })
    .resize(entry.size.width, entry.size.height, { fit: 'fill', kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
}
