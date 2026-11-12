# Verifying the app (every corner)

PlayLoop has four layers of verification. Run them in this order; each one is
cheap to run on its own and none of them needs Docker.

## 1. Static checks (seconds)

```bash
pnpm typecheck      # 8 packages, tsc --noEmit
pnpm lint
pnpm test           # sdk 36, gamekit 71, ai 21, db 12, recsys 16, worker 9, web 73
pnpm build          # root turbo build — STOP `pnpm dev` first (shared .next)
```

`pnpm build` and `pnpm dev` share `apps/web/.next`; running a build against a
live dev server corrupts the dev server's React Client Manifest and every route
starts 500ing with "module not found in Client Manifest".

## 2. Artifact audit — static (seconds)

```bash
pnpm exec tsx scripts/audit-artifacts.ts        # every artifact: exists, sha, validator
pnpm exec tsx scripts/audit-artifacts.ts --fix  # unlist the ones that fail
```

## 3. Artifact audit — runtime (minutes)

```bash
node scripts/audit-runtime.mjs        # needs the dev stack up
```

Posts every HTML artifact (published store + `.artifacts/seeds`) to the
play-worker's smoke service, which plays each one in Chromium at 390×844 with
taps, a hold-and-release, a resize and random input. Writes
`docs/reviews/runtime-audit.json` with fps, uncaught errors, blank-frame and
interactivity verdicts.

Last run: **26/27 pass** — the only failure is a retired 4 KB draft from Nov 8
that is not in the feed.

## 4. Studio E2E — stateful generation (15–25 min)

```bash
node scripts/e2e-studio.mjs                  # real LLM, real HTTP, real DB
E2E_HANDLE=someone E2E_PASSWORD=… node scripts/e2e-studio.mjs
```

Signs in through Auth.js, then:

1. turn 1 — creates a game (planner → art director → coder → static gate →
   runtime gate → QA → metadata);
2. turn 2 — sends a follow-up with `gameId` and asserts the result is **v2 of
   the same game**, not a new one;
3. reads `GET /api/studio/thread?gameId=` and asserts 2 user turns, 2 assistant
   replies and ≥2 versions.

Expected output ends with `[e2e] PASS — sessions are stateful and versioned`.

Last run (2026-11-11): turn 1 **694 s** ("Neon Corridor" v1, runtime gate pass, 0
repairs), turn 2 **287 s** (v2 of the same game, gate pass, 0 repairs), thread
returned 4 messages and 2 versions. The edit is more than twice as fast as the
create because it reuses the stored spec and the art-direction brief.

## 5. Input path (seconds, per artifact)

```bash
pnpm probe:input                       # every artifact in the store + seeds
pnpm probe:live --title "Memory"       # a real card in the running app
```

The host never lets a finger reach the game: the frame is `pointer-events: none`,
the gesture layer captures the touch and replays it as
`{ v: 1, src: 'playloop', type: 'input', payload: { kind, x, y } }`. A game that
only listens to real DOM events therefore renders fine and still ignores every
tap on a phone. `probe:input` posts that exact envelope and compares the canvas;
`probe:live` does the same through the real feed, engaging the card first.

Both poll for up to 2 s per tap instead of sampling once — a loaded machine can
miss a frame and report a healthy game as dead.

`packages/gamekit/src/templates.input.test.ts` runs the same check for all 8
templates in CI, and the runtime gate runs it for every generated game before it
publishes.

**Caching rule:** `/v/<sha>.html` is keyed by the game hash but the body inlines
the shim, so it must revalidate (`max-age=0, must-revalidate`, ETag) and every
artifact URL carries `?v=<shim version>`. An `immutable, max-age=1y` header
pinned players to an old shim for a year and made "fixed" input look broken.

## 6. Load / latency (seconds)

```bash
node scripts/load-smoke.mjs http://localhost:3000 24
```

24 concurrent feed requests against the single-connection PGlite server. The
only correct result is `non-200=0`; p50 is dominated by the serialised socket,
not by the query.

Warm timings on this machine (dev, Turbopack, PGlite):

| Route | Time |
| --- | --- |
| `/` | ~210 ms |
| `/api/feed` | ~390 ms |
| `/g/<id>` | ~120 ms |
| `/u/<handle>` | ~180 ms |

## 7. Manual smoke (2 minutes)

```bash
pnpm dev     # DB :5432, web :3000, play-worker :3001
```

- `/` — feed renders, swipe/wheel/↑↓ moves exactly one card, the game starts on
  tap and the in-game controls respond (the overlay is `pointer-events:none`
  until you tap the play chip).
- `/studio` — 307 to `/login` when signed out; after sign-in, prompt → live
  stage progress → preview → publish.
- `/login` — wrong password is rejected; unknown handle signs up.
- `/g/<id>` — like/save/comment/follow work and survive a reload.
- `/saved`, `/notifications`, `/activity` — never dead ends.

## Recovering the dev database

PGlite is one WASM process: a hard kill (`Stop-Process -Force`, a crash, a shut
laptop) can leave the data directory unreadable, and the next open aborts with
`RuntimeError: Aborted()`.

`scripts/dev-db.ts` handles this:

- it snapshots `.data/pglite` to `.data/backups/pglite-<ts>` at most every 12 h
  and keeps the last three;
- if the directory will not open, it moves it to `.data/pglite.broken-<ts>`
  and starts a **fresh** database instead of killing the dev stack — migrations,
  the 8 templates and the AI seed games are re-published automatically.

A reset loses user accounts, likes and generated games. If the rename itself
fails (Windows keeps a handle briefly), stop anything holding the directory and
retry — the rename is what fails, not the recovery logic.
