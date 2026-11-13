# Ablation and performance studies

Every number here was produced on this machine by a script in the repo. Where a
number is not comparable to another, the table says so — that distinction is the
whole point of running the study.

Reproduce:

```bash
pnpm bench:runtimes -- --cpu 1     # laptop-class
pnpm bench:runtimes -- --cpu 4     # ≈ mid-range Android (CDP CPU throttle)
npx tsx .artifacts/babylon/bench.ts   # Babylon engine boot, isolated
npx tsx scripts/ingest-assets.ts      # asset byte accounting
```

---

## 1. Engine ablation — micro vs Phaser 4 vs Babylon

### Bytes on the wire

| engine | bundle raw | bundle gzip | per-game artifact |
|---|---|---|---|
| micro (inlined shim, no engine) | — | ~2 KB | 3.5–6 KB |
| Phaser 4.2.1 | 1,344 KB | **346 KB** | 6 KB + engine |
| Babylon 9.36 (curated entry) | 1,735 KB | **411 KB** | 6 KB + engine |

Measured with `gzip -9`. Babylon's figure is the tree-shaken bundle built from
`runtimes/babylon/entry.js` — 24 curated exports. Per-module imports are what
makes 3D affordable: the UMD build is 8.7 MB, and importing `@babylonjs/core`
wholesale lands near 1.9 MB gzip. **A 3D card costs +65 KB gzip over a 2D card.**

### Boot time

`ready` = from navigation to the game's own `ready()` call, 390×844 @2x.

| engine | cold 1× | warm 1× | cold 4× | warm 4× |
|---|---|---|---|---|
| micro (flappy) | 41 ms | 55 ms | 355 ms | 214 ms |
| Phaser (flappy.phaser) | 718 ms | 233 ms | 3,319 ms | 998 ms |
| Babylon 3D (neon-run-3d) | 320 ms | 265 ms | 1,245 ms | 1,157 ms |

4× figures are the `neon-run-3d` / `flappy` / `flappy.phaser` rows of
`.artifacts/bench-cpu4.log`; the 1× figures come from `.artifacts/bench-cpu1.log`.
Babylon looks comparatively cheap here because the bundle is served from
localhost with no network throttling — on a real 4G phone the 1.7 MB download
dominates, and it is the reason 3D cards are prefetched 3–4 cards ahead.

**Frame rate, measured properly.** The benchmark's default renderer is SwiftShader
(software), which is the right choice for CI determinism but the wrong source for
an fps claim. The same 3D game, same build, measured twice on this machine:

| renderer | fps |
|---|---|
| ANGLE / D3D11 on the AMD Radeon iGPU | **60.5** |
| SwiftShader (software, what CI uses) | 24 |
| SwiftShader at 4× CPU throttle | 14 |

So the earlier "3D is slow" reading was the rasteriser, not the game. The honest
statement is: `neon-run-3d` holds 60 fps on hardware and 24 fps when there is no
GPU at all — which matters for low-end devices and for the gates, not for the
median phone. It is still the only class that can miss frame budget, so 3D stays
behind prefetch and out of the default feed mix.

Cold = first card in the session that needs that engine (fetch + parse + compile +
boot). Warm = same browser context, engine already parsed; the cost is HTTP
revalidation plus scene construction. This is why the feed prefetches engines 3–4
cards ahead and why the boot animation exists.

**Babylon in isolation** (`.artifacts/babylon/bench.ts`, engine + one rendered
frame of a box, localhost, no network throttle):

| | in-page | wall |
|---|---|---|
| cold 1× | 175 ms | 424 ms |
| cold 4× | 308 ms | 960 ms |
| warm 1× | 140 ms | 325 ms |
| warm 4× | 321 ms | 910 ms |

Read that as a floor, not a comparison: it excludes game logic and excludes the
network, which for 1.7 MB is the dominant term on a real phone.

### What the ablation decides

- **micro stays the floor.** ~2 KB and 56 ms warm is unbeatable for grid puzzles.
- **Phaser is the default.** 346 KB gzip amortised across every 2D game in the
  session, and it buys physics, cameras, tweens and particles the coder would
  otherwise reimplement badly.
- **Babylon is a third class, not a second default.** +65 KB gzip and a 1.7 MB
  parse are worth it only when the mechanic is genuinely 3D. The planner is
  instructed accordingly and was verified against the live model: a 3D runner and
  a rotatable 3D maze → `babylon`; a 2D platformer → `phaser4`; sudoku → `micro`.

---

## 2. Asset pipeline ablation

### Inline vs content-addressed

| | bytes |
|---|---|
| starter pack on disk (18 assets) | 34.7 KB |
| same bytes base64-inlined | 46.2 KB (+33 %) |
| images only (12) | 23.1 KB → 30.8 KB inlined |

Inlining also means every game re-downloads a sprite a previous game already
cached. Content-addressed files at `/a/<sha16>.webp` are cached per browser and
shared across games; the cost is one extra request on a cold cache.

### Encoder settings (why these defaults)

| asset | choice | reason |
|---|---|---|
| pixel art (≤64 distinct colours) | lossless WebP, nearest-neighbour resize | lossy WebP turns hard sprite edges into mush at 4× upscale |
| illustrated art | WebP q82–90, alphaQuality +8 | 25–35 % smaller than JPEG at equal quality |
| backgrounds | WebP q76, resized to 1170 px wide | the card is 390 CSS px at up to 3× dpr |
| sound effects | Ogg/Opus 48 kbps mono | 1–3 KB per blip |
| music (when added) | Opus 64 kbps | ~470 KB/min, only with a `rich` profile |

Determinism matters more than it looks: the Ogg muxer writes a random stream
serial, so identical audio encoded twice produced different bytes and a
content-addressed URL changed on every ingest. `steadyOggSerial()` rewrites the
serial to zero and recomputes the page CRC — same input, same hash, verified by a
test that ingests twice and asserts zero writes on the second pass.

---

## 3. Gate performance

| gate | cost | what it catches |
|---|---|---|
| static `validateGame` | <10 ms | unsafe HTML, missing manifest, oversized artifact |
| smoke (`runSmokeTest`) | 20–35 s | never boots, blank screen, no reaction to input |
| playtest | 5–20 s | frozen world, no score, no restart after game over |
| visual review | ~5 s + one model call | unreadable player, HUD under the chrome, screen contradicting the description |

The gates run on the play worker, serially, per build. A generation that passes
every gate end-to-end takes 5–12 minutes, of which the model is >95 %.

---

## 4. Feed and serving

| what | number |
|---|---|
| `/api/feed` (16 games, production build) | 27–40 ms |
| `/` first byte | 6–18 ms |
| `/r/:file` (engine, immutable) | 1 request per browser per engine |
| `/a/:file` (asset, immutable) | 1 request per browser per asset |
| live iframes in the feed | max 3 (`MOUNT_RADIUS = 1`) |

---

## 5. Known limits of this study

- No real-device numbers: 4× CPU throttle approximates a mid-range Android, it
  does not measure one. Network throttling is not applied in the runtime bench,
  so cold-start figures understate a 4G phone.
- Babylon's boot figure is engine-only, not game-driven.
- The visual reviewer is a model. It is measured by inspection, not by a labelled
  set; when it contradicts the pixels, the PNG in `.artifacts/shots/` wins.
