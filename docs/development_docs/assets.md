# Assets

The agent used to draw everything with canvas primitives. That is why artifacts
were 6 KB — and why a hero was often an eight-pixel green dot. This is the layer
that gives the coder a vocabulary.

## The contract

Assets are **content-addressed files on the play origin**, exactly like engines:

```
/a/1eff32d4a8bc737b.webp     ← the file name is the SHA-256 prefix
/a/index.json                ← the catalogue the studio reads
```

- Served by `apps/play-worker` with `Cache-Control: immutable` — the name *is* the
  digest, so those bytes can never change under a cached URL.
- `img-src 'self'` was added to the artifact CSP for this. `connect-src` stays
  `'none'`: a game can load a sprite, it still cannot open a socket.
- A game references `/a/<file>` relatively; the frame's own origin is the play
  origin, so no rewriting is needed at injection time.
- The manifest declares what it used: `"assets":[{"id":"coin","file":"<sha16>.webp"}]`.
  `validateGame` rejects any asset entry that is not `<sha16>.(webp|png|ogg|mp3)` —
  a URL there would be an unchecked network dependency.

## Why not inline them

Measured on the starter pack: **23.1 KB on disk, 30.8 KB if base64-inlined**
(+33 %), and inlining also means every game re-downloads a copy of a sprite it
already has. Content-addressed files are cached once per browser and shared by
every game that draws that sprite.

## The pipeline

```
raw file ──► detect (pixel art? dimensions?) ──► resize to rendered size
        ──► encode (lossless WebP for pixel art, WebP q82-90 for the rest)
        ──► sha256 ──► /a/<sha16>.webp ──► index record (licence, tags, bytes)
```

`packages/assets`:

| module | job |
|---|---|
| `registry.ts` | record shape, licence shape, search/filter, publish profiles, budget maths |
| `optimize.ts` | sharp-based encoder; pixel-art detection by **distinct colour count** (≤64), not by file name |
| `ingest.ts` | idempotent ingest; output name derives from the optimised bytes, so re-running writes nothing |
| `starter.ts` | the 12-item starter pack, rendered from SVG through the same path |

```bash
pnpm ingest:assets                                  # the starter pack
npx tsx scripts/ingest-assets.ts --dir ./kenney/ui --kind ui --source Kenney
```

`pnpm start` ingests the starter pack automatically when `apps/play-worker/assets/index.json`
is missing, so a fresh clone is never asset-less.

## What the agent sees

The pipeline reads the index and hands the coder a fixed, small vocabulary (first
24 records): id, kind, dimensions, file, tags — plus the rules: load with
`new Image()`, draw only after `onload`, keep the game playable while it loads,
`ctx.imageSmoothingEnabled = false` for pixel art, declare what you used in the
manifest.

The SDK wraps the two things games get wrong:

```js
const img = await PlayLoop.loadImage('/a/abc123.webp');   // resolves after decode, 8s timeout
PlayLoop.drawSprite(ctx, img, x, y, w * 4, h * 4, true); // nearest-neighbour, restores state
```

Verified end-to-end (`.artifacts/check-assets.ts`): a sprite loads through the
sandboxed frame, decodes at its true size, and upscales 4× with hard pixel edges.
Screenshot: `.artifacts/shots/asset-draw.png`.

## Licence rules

Every record carries `{id, commercialUse, modification, redistribution, attribution, url}`.

- `searchAssets` never returns an asset whose `commercialUse` is false.
- CC BY records keep the exact attribution string, so a remix can carry it.
- A licence that forbids redistribution (Quaternius QAL) is recorded as such; the
  registry does not silently treat it as CC0.

The starter pack is ours: CC0 by construction, no attribution needed.

## Publishing profiles

| profile | budget | use |
|---|---|---|
| instant | 1 MB | the default feed card |
| standard | 2.5 MB | a card with real art |
| rich | 5 MB | 3D or progressive loading |

`withinBudget()` is the gate; nothing enforces it in the pipeline yet (see
`docs/state.md` §10).

## Audio

Sound effects are synthesised in `packages/assets/src/sounds.ts` (16-bit WAV,
no licensing questions) and encoded to **Ogg/Opus 48 kbps mono** by FFmpeg — 1–3 KB
each. The ingest path treats `sfx` and `music` separately: music gets 64 kbps
because it is long, effects get 48 kbps because they are 90–450 ms.

Games play them with `PlayLoop.playSfx('<file>')`, which caches one `Audio`
element per file, respects mute, and swallows autoplay rejections (the first tap
unlocks audio, not the page load).

Determinism: the Ogg muxer writes a random stream serial. Without normalising it,
encoding the same blip twice produced different bytes and a content-addressed URL
changed on every ingest. `steadyOggSerial()` zeroes the serial and recomputes each
page's CRC — verified by a test that ingests twice and asserts the second run
writes nothing.

FFmpeg is found on `PATH`, or via `FFMPEG_PATH`. When it is missing the ingest
reports a skip and everything else still works.

## Known limits

- No 3D assets: KTX2/Meshopt wait for a 3D game that needs models.
- The catalogue is a JSON file, not a database: linear scan, fine at 12–500
  records, the wrong shape at 50,000.
- Nothing imports a Kenney pack yet; the `--dir` flag is the door.

## 9. Browsing: categories, tree, sheets, search

The flat store (`<sha16>.webp`) is right for delivery and useless for retrieval. Three
things sit on top of it.

**Categories** (`registry.ts: CATEGORIES`) — one per asset, fixed vocabulary:
`2d/{characters,enemies,environments,tilesets,objects,effects}`,
`3d/{characters,environments,props,vehicles,weapons}`,
`ui/{buttons,panels,icons,hud}`, `audio/{sfx,music}`.
`classify()` infers it from id/name/tags/source path — a heuristic that is allowed to
be wrong because the cost is a folder out of place, and the fallback is the asset's
kind, never "uncategorised".

**Browse tree** — `writeBrowseTree()` mirrors the store into
`assets/tree/<category>/<id>.<ext>` with **hardlinks**, so browsing costs no disk and
cannot go stale. 267 links across 12 folders.

**Contact sheets** — `buildContactSheet()` renders up to 16 assets into one WebP
(4 columns, numbered captions). This is how the model *looks* instead of reading a
16-character hash. Small sprites are upscaled to fill the cell with nearest-neighbour,
because a 16×16 sprite at native size in a 132px cell is a dot on a black square.
Served at `/a/sheet-<folder with dashes>.webp` (e.g. `sheet-2d-characters.webp`),
regenerated on every ingest. Models are skipped — a GLB has no thumbnail without a
renderer.

**Search returns a ranked top-k** — `searchAssets(index, {text, category, kind, tags,
limit})`. Scoring: exact id/name 8, exact tag 6, substring in id/name 4, tag substring
3, category/kind 2; smaller file wins ties. Precision first: if any record matches
every word it wins outright, and partial matches only appear when nothing matches
strictly. Default k = 8, the coder gets 24.

**Controls are no longer tap-only.** The manifest `controls` field accepts
`joystick`, `buttons` and `mixed` alongside tap/drag/swipe/tilt/keys, and the coder
prompt specifies the geometry: 110–130px thumb-stick bottom-left with an 18% dead
zone, 64–72px action buttons bottom-right with ≥48px hit areas, both inside
`safeArea`, two pointers maximum, drawn in canvas rather than DOM.
