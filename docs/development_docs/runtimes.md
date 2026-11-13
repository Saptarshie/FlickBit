# Shared runtimes (engines)

A game is never shipped with its engine. The artifact carries **gameplay**; the
platform carries the **engine**; the two meet at serve time, on the play origin.

```html
<!-- what /v/<sha>.html returns -->
<script>/* protocol shim, ~6 KB, inlined */</script>
<script src="/r/phaser4@4.2.1-<hash>.js"></script>   <!-- cached forever -->
<script>/* the 8 KB the model actually wrote */</script>
```

## Why it is built this way

| Constraint | Consequence |
|---|---|
| A game is content-addressed by SHA-256 | The artifact on disk is the thing that is hashed. The engine tag is added *at serve time*, exactly like the shim, so the hash still means "these bytes". |
| `sandbox="allow-scripts"` (no `allow-same-origin`) | The frame cannot see the host's globals. "Load the engine once in the feed" is impossible across the realm boundary — the engine must be reachable **from inside the frame**, which is what `/r/...` provides. |
| `connect-src 'none'` | No `fetch`, no XHR, no WebSocket inside a game. An engine is loaded as a `<script src>`, which is governed by `script-src 'self'` — the only relaxation this design needs. |
| Immutable caching must be honest | The URL contains the engine's sha384 prefix, so `max-age=1y, immutable` cannot go stale. The artifact HTML keeps `must-revalidate`, because its response also carries the shim. |
| An old game must never change behaviour | The manifest pins `runtimeVersion`. `/r/:file` resolves the pinned build, or fails loudly (503 `runtime_unavailable`) — never a blank frame. |

## The allowlist

`packages/sdk/src/runtimes.ts` is the single source of truth. A manifest may
name an id from it, never a URL: a URL in `pl-manifest` would let creator code
load arbitrary scripts under our origin, so `extractManifest` rejects it.

```
micro     inlined shim; no engine; 8 archetypes; ~0 bytes
phaser4   344 KB gzip (measured, 4.2.1) — physics, tweens, tilemaps, particles
babylon   1.88 MB gzip UMD (measured, 9.36) — 3D; only for `needs: 3d`
```

Adding an engine:

```bash
pnpm add -w phaser
pnpm install:runtime phaser4      # copies node_modules → runtimes/, hashes it
```

`scripts/install-runtime.mjs` writes `<id>@<version>-<hash16>.js`. The worker
re-hashes every file at boot and **ignores any file whose name does not match
its bytes**, so a swapped or truncated engine fails at boot, not at a player's
expense.

## Prefetch (nobody should wait for an engine)

The feed already knows each card's runtime, because it comes back with the
manifest. `apps/web/src/lib/runtime-prefetch.ts`:

- looks 3–4 cards ahead,
- fetches on `requestIdleCallback` at `priority: 'low'`,
- dedupes for the session and never retries a failed engine,
- refuses when `navigator.connection.saveData` or effective type is 2G/3G,
- spends at most **700 KB** of engine per session (`planPrefetch` budget).

The point is not bandwidth, it is the perceived one: by the time a card is on
screen, its engine is in the HTTP cache and the frame's first paint is local.

## Failure modes (all deliberate)

| Situation | Behaviour |
|---|---|
| Manifest names an engine this origin does not hold | `503 runtime_unavailable` from `/v/...`, so the card offers Retry instead of showing a blank frame |
| Manifest names an id outside the allowlist | `extractManifest` returns null → static gate fails at generate/publish time |
| Engine file's bytes no longer match its name | Ignored at boot (and logged); the pinned build is then missing → the 503 path above |
| Client on a metered/slow connection | No prefetch; the card loads the engine on demand |

## Benchmarking a new engine

```bash
pnpm bench:runtimes -- --cpu 4          # 4x CPU throttle ≈ a mid-range phone
```

Measures, per artifact, through the real serving path (worker routes, CSP, shim
injection, sandboxed iframe):

- **bytes** on the wire,
- **ttfb**,
- **ready** — navigation → the game's `ready` message (the number a player feels),
- **fps** over a 2 s window.

Baseline for the inlined micro runtime, 390×844 @2x:

| artifact | bytes | ready (1×) | ready (4×) | fps |
|---|---|---|---|---|
| tap-runner | 3,479 | 37 ms | ~180 ms | 60 |
| flappy | 3,693 | 39 ms | 369 ms | 60 |
| snake | 3,935 | 64 ms | — | 60 |
| shooter | 4,447 | 55 ms | — | 60 |
| brick-breaker | 4,480 | 83 ms | — | 60 |

An engine card is only ready for the feed if it stays within roughly
**+150 ms ready** and **−5 fps** of these numbers at 4× throttle.

## Measured: Phaser 4 vs the micro runtime

Same game (flappy), same viewport (390×844 @2x), same serving path, two CPU
throttle levels. `ready` = navigation → the game's own `ready` message.

| artifact | engine | bytes | ready 1× cold | warm | ready 4× cold | warm | fps 4× |
|---|---|---|---|---|---|---|---|
| flappy.html | micro | 3,693 | 119 ms | 56 ms | 654 ms | 329 ms | 61 |
| flappy.phaser.html | phaser4 | 6,016 | 828 ms | 226 ms | 4,542 ms | 1,017 ms | 48 |

Reading:

- **The engine is the cost, not the game.** The artifact grew by 2.3 KB; the
  page grew by 1.3 MB (346 KB gzip) and time-to-ready grew 7× cold, 3× warm.
- **Tree-shaking does not help.** Bundling `phaser.esm.js` with esbuild while
  importing only `{ Game, Scene, Scale, AUTO }` produced 1,361 KB / 360 KB gz
  against 1,344 KB / 346 KB for the full build. Phaser 4 is one module graph
  with side effects; 346 KB is the floor.
- **FPS is fine** (48–61), so this is a startup problem, not a rendering one.

### Policy: Phaser by default, micro by exception

The platform's default is now **phaser4**. The cost above is a cold-start cost,
and a feed app only pays it once: the boot animation (below) fetches the engine
while the logo plays, so every card after that starts warm.

The planner chooses per game, in the same completion that writes the spec:

| the game | runtime |
|---|---|
| platformers, shooters with waves, physics toys, anything moving >~40 objects, anything needing cameras/tweens/particles | `phaser4` (default) |
| grid puzzles, memory/sequence, sudoku, trivia, word games, card flips, tap-timing reflexes | `micro` |
| unsure | `phaser4` |

The model **proposes**, the platform **disposes**: `stampRuntime()` rewrites the
manifest server-side and overwrites anything the model invented, so a manifest
can never name an engine that is not on the allowlist. `micro` stays implicit —
an engine-less artifact carries no `runtime` key at all.

Honest caveat: "once, for days" is not guaranteed. A browser may evict the
engine under storage pressure, and a returning user can pay the cold cost again.
The splash window absorbs it when that happens; nothing breaks.

### Cold start: the boot animation

`SplashGate` is a loading state shaped like a brand moment. It exists because
the first Phaser card would otherwise show 0.8 s (warm) to 4.5 s (cold) of black
on a phone-class CPU.

- Runs **once per tab session** (`sessionStorage`), skipped entirely under
  `prefers-reduced-motion`.
- Loops between a 700 ms floor and a 2400 ms ceiling, and leaves as soon as the
  feed has painted a card — it never adds time, it only fills time that was
  already being spent.
- While it plays it prefetches the default engine, which is the whole point:
  measured appearance 300 ms, dismissal 1.34 s on the local production build.

Follow-up worth having: drive that prefetch from the first page's manifests
instead of assuming `phaser4`. Today the guess is right because Phaser is the
default; if the mix ever changes, the splash should read `/r/index.json` and the
feed, not hardcode an id.

### Two Phaser 4 traps worth remembering

Both were found by playing the game, not by reading it:

1. **A plain `{ create, update }` scene object never gets `update()` called.**
   Phaser 4 accepts it, renders one frame, reports a healthy 60 fps loop and
   then sits still. It must be a real `class extends Phaser.Scene`.
2. **A missing top-level declaration fails silently at runtime.** A
   `ReferenceError` inside `update()` is thrown once per frame, so the world
   freezes while everything still looks "loaded" — this is exactly the class of
   bug the input gate exists to catch, and it caught it here too.

Both argue for the same thing: the gate must tap the game and read the world
back, not diff pixels or trust `ready`.

Babylon stays uninstalled. Before it ships it needs a tree-shaken build
(`@babylonjs/core` + esbuild, targeting < 600 KB gz), a procedural-geometry-only
art rule (no external assets inside `connect-src 'none'`), and a playtest gate —
see `docs/user_ref/engine_adv.md` for the options weighed.
