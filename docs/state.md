# FlickBit — state of the system

Living document. Update it when a decision changes, a gate is added, or a number
moves. Everything here is measured on this machine unless marked *estimate*.

Last updated: 2026-11-13 · HEAD `b2a16de` + visual-review work in progress.

---

## 1. What this is

A mobile-first, Reels-style feed of tiny HTML5 games, all written by an AI
studio from a one-line prompt. Players scroll vertically, tap to engage, like /
comment / save / follow, remix each other's games, and share cards with OG
images.

The product promise is **instant**: a card must be playable the moment it is
engaged, on a mid-range phone, with no spinner.

## 2. Architecture at a glance

```
apps/web          Next 15 (App Router) — feed, studio, profiles, share, API
apps/play-worker  Express :3001 — serves artifacts + engines, runs the gates
packages/ai       generation pipeline (planner → art dir → coder → gates → QA)
packages/gamekit  artifact contract: validate, inject, smoke, playtest, capture
packages/sdk      guest shim + host bridge (postMessage protocol v1)
packages/db       Drizzle schema, migrations, rollups (PGlite or Postgres)
packages/recsys   candidates → ranker → MMR diversify
scripts/          dev, start, stop, probes, benches, seed/repair tooling
```

Runtime topology (production): `scripts/start.mjs` boots the embedded database,
the play-worker and `next start`. `pnpm stop` kills every process whose command
line points into the repo and waits until 3000/3001/5432 are actually free.

## 3. The game runtime model

Games are **gameplay only**. The engine is a separate, content-addressed file on
the play origin:

```html
<script>/* protocol shim, ~6 KB, inlined */</script>
<script src="/r/phaser4@4.2.1-932510e7e73173af.js"></script>
<script>/* 6 KB the model actually wrote */</script>
```

| decision | why |
|---|---|
| Engine served from `/r/<id>@<ver>-<hash>.js`, `immutable` | The URL is the digest, so a year-long cache is honest; the second game on that engine costs zero bytes and zero parse. |
| The manifest pins `runtime` + `runtimeVersion` | An engine upgrade can never silently change an old game. |
| The platform **stamps** the runtime; the model only proposes it | A model that omits, misspells or invents an engine would ship a game that never loads (or points at foreign code). `stampRuntime()` rewrites the manifest after generation. |
| `micro` is implicit (no `runtime` key) | Engine-less artifacts stay byte-comparable with everything published before engines existed. |
| CSP is `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:` | The frame's own origin is allowed for `/r/*`; `connect-src 'none'` still forbids every network call from game code. |
| Missing engine → `503 runtime_unavailable` | A loud failure the card can offer Retry for, instead of a blank frame with a silent ReferenceError. |

Prefetch: the feed knows each card's runtime from its manifest and fetches
engines 3–4 cards early on `requestIdleCallback` at `priority: 'low'`, skipping
`saveData`/2G/3G and a 700 KB session budget. The boot animation does the first
one during its 0.7–2.4 s.

## 4. Generation pipeline

```
prompt → plan (runtime chosen here) → art direction → code → static gate
       → smoke gate → playtest gate → visual review → QA critic → metadata
```

Each gate can send the build back for repair; repairs are counted and cap the
loop (3 static, 2 runtime, 1 playtest, 1 visual, 1 QA-critical). Every stage
streams SSE progress and records `timingsMs`.

| gate | proves | cannot see |
|---|---|---|
| static (`validateGame`) | safe, complete, self-contained, manifest valid, ≤500 KB | whether anything runs |
| smoke (`runSmokeTest`) | boots, paints, no uncaught errors, FPS, reacts to a tap | whether the run goes anywhere |
| playtest (`playtest`) | taps move the world, score/end appears, restart works after game over | whether it *looks* like anything |
| visual (`reviewVisual`) | a multimodal model looks at 3 screenshots: player legibility, HUD vs app chrome, dead space, description↔screen match, affordance | whether the mechanic is *fun* |
| QA critic (`reviewGame`) | code-level design review against the playbook | anything visual |

## 5. Algorithms

**Candidates** (`packages/recsys`): content-based, social, trending, fresh,
explore. Trending is computed over a 72-hour window with a rollup-awareness
trick — rolled buckets up to hour `b.t`, raw events from `b.t` on — so a lagging
rollup never reads as zero engagement.

**Trending score**: `(plays15 + 3·likes + 5·remixes) / (impressions + 20)`.

**Ranking**: weighted blend of engagement, recency, social proximity, and
personal affinity; then **MMR** diversity over tags so a feed page is not eight
synthwave runners.

**Feed page size** 10; live iframes limited to `MOUNT_RADIUS = 1` (three at
most); browse-vs-play mode via `engagedGameId` so a tap engages the game and the
rail/✕/Esc release it.

## 6. Performance (measured)

| what | number | how |
|---|---|---|
| micro card: ready, 1× / 4× CPU | 119 ms / 654 ms cold, 56 / 329 ms warm | `pnpm bench:runtimes` |
| Phaser card: ready, 1× / 4× CPU | 828 ms / 4,542 ms cold, 226 / 1,017 ms warm | same |
| micro card size | 3.5–5.2 KB | artifact bytes |
| Phaser engine | 1,344 KB raw / 346 KB gzip | measured, 4.2.1 |
| Feed API | 27–35 ms (production, 15 games) | curl |
| `/` first byte | 6–18 ms (production) | curl |
| Boot animation | appears 300 ms, leaves 1.34 s, once per session | Playwright |
| Test suite | 288 tests, ~7 min serial | `pnpm test` |
| Generation | 5–12 min per game (LLM-bound) | E2E runs |

## 7. Decision log

| # | decision | alternative rejected | cost we accepted |
|---|---|---|---|
| D1 | PGlite over the Postgres wire, not Docker Postgres | real Postgres in dev | one connection, `prepare: false`, no concurrent test+app DB access |
| D2 | Separate `.next` / `.next-dev` build dirs | one dir | two builds on disk |
| D3 | Publishing is its own idempotent step keyed by `(game, sha256)` | publish inside generation | an extra endpoint + pending markers |
| D4 | Stale sessions are a first-class state (`401 session_stale`) | letting the FK fail | every route resolves the viewer first |
| D5 | Artifacts revalidate (`max-age=0`) even though the URL is a hash | immutable artifacts | one 304 per card (the shim changes under a fixed hash) |
| D6 | Engine files are content-addressed and immutable | version-only URLs | must keep old runtime builds forever |
| D7 | Phaser 4 as the default engine, micro as an escape hatch | micro everywhere | +0.3–1.0 s warm start per card |
| D8 | Runtime chosen by the planner, stamped by the platform | free choice / keyword rules | one extra decision in the planner prompt |
| D9 | Playtest asserts "responds + can restart", not "scores in N seconds" | strict score assertions | a slow game can pass while being dull |
| D10 | Visual review is advisory except for *critical* findings | blocking on score | taste never blocks a build |
| D11 | Dead games are `unlisted`, never deleted | delete | hidden-but-reachable content lingers |
| D12 | Chrome insets are the **shim's default** (top 80, right 72, bottom 70), not zero | waiting for the host's `init` | a game that reads `safeArea` once in its constructor still draws in a visible place |
| D13 | Visual review runs on **compositor screenshots** of three moments | one screenshot / DOM read | ~3 s and one model call per build |

## 8. Findings (bugs the gates caught, in order of how much they taught)

1. **Phaser 4 never calls `update()` on a plain object scene.** It renders one
   frame, reports 60 fps and freezes. Must be `class extends Phaser.Scene`.
2. **A `ReferenceError` inside `update()` freezes the world one frame after it
   throws** — the game looks loaded, and every pixel is the same.
3. **Four of eight template games had no way back after game over** in the live
   feed (stale artifacts). Republished as v2.
4. **Two generated games were completely frozen** (0 frame changes on input).
   Unlisted by `quarantine-unplayable.ts`.
5. **Most generated games never reported their score during play**, so the host
   HUD and the playtest could not see progress. Templates now report at 2 Hz and
   the coder prompt requires it.
6. **`canvas.toDataURL()` is blank on WebGL canvases** — the old interactivity
   check was a false pass for every engine game. Capture and playtest now use
   compositor screenshots.
7. **The playtest harness 404'd the engine** when replaying a worker-served
   artifact on its own port, and silently tested the fallback. Fixed by proxying
   `/r/*` to the play origin.
8. **Visual review of "Neon Dead Highway" (the game in the user's screenshot)**
   scored 4/10: no zombies or traffic on screen despite the description, score
   and distance under the app's 72px profile row, nitro meter inside the right
   icon rail, and the opening screen saying "DRAG" while the card says "tap".

### What the visual gate has already fixed

| game | finding | fix |
|---|---|---|
| all 15 | HUD/timer under the 72px profile row (10 games) | host sends real insets; shim defaults to them; prompt requires entities to respect them |
| Flappy | no game-over screen, no restart, loop stopped on death | overlay + tap-to-restart; loop keeps running |
| Flappy | bird could fly into the chrome band, pipes hung from y=0 | playfield ceiling = `safeArea.top + 8` |
| Flappy | died during the opening second | physics starts on the first tap |
| Shooter | enemies spawn under the right rail | prompt: entity bounds inside `width - safeArea.right` (regen pending) |
| Neon Dead Highway | screen shows no zombies or traffic, contradicts its card | queued for regeneration |

The reviewer is a model, not a measurement: on one Flappy frame it claimed the
bird was "half off the left edge" when pixel inspection put it at x≈117/390.
Mitigations now in place — numbered screenshots, explicit canvas dimensions, and
`scripts/probe-visual.ts` dumps every frame to `.artifacts/shots/` so any claim
can be checked against the actual PNG.

## 9. Asset library — options weighed

The agent currently draws everything with canvas primitives and WebAudio. That
is why artifacts are ~6 KB and why there is no asset pipeline, no binary
moderation, and no attribution bookkeeping. Adding art assets is therefore a
pipeline decision, not a file-download decision.

**Numbers that constrain it** (measured earlier): base64 inlining costs exactly
+33 %, and gzip cannot recover it (0 % on already-compressed data). So a 300 KB
WebP becomes 400 KB on the wire inside a self-contained artifact.

| option | licence | fit today | verdict |
|---|---|---|---|
| **Kenney** (2D sprites, UI, audio) | CC0 | excellent — small, consistent, no attribution | **start here**, curated ~200 files |
| **Quaternius** (low-poly 3D) | CC0 / QAL (no standalone redistribution) | 3D only | defer with Babylon |
| **Poly Haven / ambientCG** (PBR) | CC0 | 3D only, heavy | defer |
| **OpenGameArt** | mixed | every asset needs manual licence review | avoid bulk ingest |
| **game-icons.net** | CC BY 3.0 | attribution required | optional, with attribution store |
| **Phaser Labs** | code MIT, assets unclear | not cleared for commercial use | do not bulk copy |

**Recommended shape when we do it**: an asset registry (SQLite/Postgres table:
id, sha256, size, dimensions, licence, attribution text, tags, category) plus a
build step that (a) picks ≤N assets matching the brief, (b) re-encodes to WebP,
(c) inlines them as data URLs only when the total stays under the card budget,
(d) writes an `assets` block into the manifest so a remix inherits provenance.
Budget: 2D card ≤1.2 MB total, of which ≤600 KB assets. No 3D until Babylon
ships.

**What is deliberately not built yet**: unsupervised ingestion (licence risk),
AI upscaling in the player (cost, and nearest-neighbour is correct for pixel
art), and a CDN (nothing to serve until assets exist).

## 10. Known gaps

- Fun/balance is unmeasured. No playtest agent that plays to a goal, no
  difficulty telemetry.
- The visual reviewer sees three stills, not motion — it cannot judge game feel.
- The splash prefetches `phaser4` unconditionally instead of reading the first
  page's manifests.
- `pickTemplateFromPrompt` is still a keyword matcher (violates the
  no-keyword-whitelist rule it should follow).
- No moderation queue; reports go to a table, nothing triages them.
- Everything runs on PGlite: no vector index at scale, one connection.
- CI has no `pnpm build` step; the gates run on the worker, so CI exercises
  logic, not playability.

## 11. Next

1. Run the visual gate on the whole feed and re-generate the worst cards.
2. Turn critical visual findings into a hard publish block (today they only
   trigger one repair pass).
3. Asset registry + Kenney subset + inline budget check (Section 9).
4. A playtest agent that tries to reach the goal, not just to touch the screen.
5. Replace the keyword template matcher with a model call, cached to disk.
