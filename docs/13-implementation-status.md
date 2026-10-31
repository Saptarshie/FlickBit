# 13 — Implementation Status (living doc)

Update this file at every commit. The next implementing agent resumes from here.
Task IDs come from 10-roadmap-tasks.md.

## Done
- P0-T1 monorepo (commit 0684502): pnpm+turbo, Next 15 web skeleton, packages/{db,sdk,gamekit,recsys,ui}, docker-compose, .env.example, GitHub Actions CI, SDK protocol + parseGuestMessage with tests.
- P0-T3 schema (commit 77ac817): Drizzle schema (identity incl. Auth.js tables, games+versions+features with pgvector 1024/768 + HNSW, social, AI creation), migration 0000_init.sql (hand-added CREATE EXTENSION vector), idempotent seed, db:generate/db:migrate/db:seed scripts. 6 tests on PGlite.

## Done (batch B, commit ea0f89b)
- Play-worker (apps/play-worker): Express 5 serving artifacts by sha256 with the exact spec CSP, immutable caching, nosniff, injected SDK shim, 404/409/500 error contract. 9 tests.
- Smoke-test runner (packages/gamekit): runSmokeTest on real Playwright chromium with a served-injectShim harness and the real GameHost, blank/crash/never-ready/interactive fixtures, and a gate asserting all 8 templates pass at fps >= 30. 69 tests.
- Feed UI (apps/web): Reels-style snap feed with IntersectionObserver active tracking, hard 3-iframe cap, tap-to-play overlay, thumb-zone rail, keyboard controls, TanStack Query + zustand. 17 tests. First Load JS 121 kB (under the 150 kB budget).

Verified by the orchestrator: 129 tests across 5 packages, typecheck clean across 7, next build green.

## Done (data layer for phase 2, commit 9d6c315)
- Events log: `packages/db/events.sql` creates the `events` table PARTITION BY RANGE (ts) with 6 monthly partitions (drizzle-kit cannot express this, so it is raw SQL applied by `pnpm --filter @playloop/db db:events`). `insertEvents` writes through it. Test proves the DDL applies and rows land.
- Seed now writes each template as a content-addressed artifact (`<sha256>.html`) plus its game + version rows, so the play-worker has real files to serve. Idempotent (deterministic game id per template). Test verifies the sha256 of each file matches its name.

## Bug found and fixed while building the seed
`games.publishedVersionId` and `game_versions.gameId` reference each other, so inserting the version first violated the FK. Fixed with insert-game (publishedVersionId null) -> insert-version -> update-game. Rule: any code creating a game + version must use this order.

## Done (batch A, commit ad0c33b)
- SDK host + guest shim (packages/sdk): parseGuestMessage, SHIM_SOURCE IIFE with pause-honouring timer/rAF wrapping and AudioContext suspension, GameHost with source-checked messages and handshake timeout. 28 tests.
- Validator + 8 template games (packages/gamekit): validateGame with 22 rejection rules, extractManifest from both formats, entropy warning, 8 real playable canvas templates. 54 tests.
- Auth.js v5 + anon cookie + middleware (apps/web): magic link + Google, handleFromEmail slug, signed anon id, protected-route middleware, /api/auth/[...nextauth]. 13 tests.

Verified by the orchestrator after the batch: 101 tests pass across 4 packages, typecheck clean across 6, `next build` succeeds. `*.tsbuildinfo` added to .gitignore and untracked (was committed by accident, 260KB of churn).

## Pitfall learned (batch A)
A subagent that cannot run `pnpm install` hand-made `node_modules` symlinks instead. One of them (pglite-pgvector) pointed into a pnpm store entry that pnpm had renamed to `.ignored_pglite-pgvector`, leaving a self-referential symlink that made `pnpm install`/`pnpm test` fail with ELOOP and "Cannot find package". Repair: restore the store dir name, delete the self-referential links, re-run pnpm install. Rule for future batches: NEVER hand-make node_modules links. If deps are missing, report it and stop. Pre-install deps centrally before dispatching.

## Not verified / caveats
- Docker engine was not running: docker-compose, db:migrate, db:seed against real Postgres are UNVERIFIED. The migration itself was applied successfully to PGlite (Postgres + pgvector).
- lint = `tsc --noEmit`. There is no ESLint.
- CI workflow has never run (no remote repo configured).
- Local dev caveat: play origin is a different port (localhost:3001), which is same-site with the app, so cookies are shared. Real isolation needs a separate registrable domain in production (playloop-play.example). Documented in 03; needs a decision before launch.

## Decisions made while implementing
- `events` table and its partitions are deferred to the events task; `game_stats_hourly`, `user_taste`, `experiments` to the recsys task.
- pgvector extension lives in its own package `@electric-sql/pglite-pgvector` (not `@electric-sql/pglite/vector`).
- pnpm 11 requires explicit `allowBuilds` entries in pnpm-workspace.yaml for packages with install scripts (esbuild, sharp, unrs-resolver).

## Next up (do these in order)
1. play-worker: Express app in apps/play-worker serving artifacts by sha256 with CSP + injected SDK shim (depends on the shim string from @playloop/sdk).
2. smoke-test runner: Playwright headless validation (depends on validator + templates).
3. Feed UI v1 with seeded games (depends on play-worker for the artifact URL scheme).
4. Social APIs + events logging.
5. AI pipeline (gamekit prompts + jobs + SSE), then Studio UI.
6. Recsys (embeddings, candidates, ranker, reranker).
