# 13 — Implementation Status (living doc)

Update this file at every commit. The next implementing agent resumes from here.
Task IDs come from 10-roadmap-tasks.md.

## Done (run it: real dev stack, real feed, real LLM, embeddings)

**The app is now runnable with one command and works end-to-end.**

- `pnpm dev` (new `scripts/dev.mjs`): starts the database first, waits for port 5432, then `turbo run dev` (web :3000 + play-worker :3001). Ctrl-C tears all three down.
- `scripts/dev-db.ts`: PGlite + pgvector served over the **Postgres wire protocol** (`@electric-sql/pglite-socket`) on 5432 — no Docker required. On boot it runs drizzle migrations, applies `events.sql` + `stats.sql`, and seeds the 8 template games + their artifacts into `apps/play-worker/artifacts`. Data persists in `.data/pglite/`.
- `apps/web/src/lib/feed.ts`: the mock is gone. The feed now calls `fetchFeedPage(getDb(), …)` (recsys) and returns an honest empty page instead of fabricated games.
- `packages/ai/src/openai-provider.ts`: `OpenAiCompatProvider` + `providerFromEnv()` — real `/chat/completions` against `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`. Handles null `content` from reasoning models (retry with bigger budget) and **continues truncated completions** (`finish_reason: length`) up to 3 times, then throws rather than publishing a half file.
- `packages/ai/src/embeddings.ts`: Ollama `/api/embed` (`EMBED_MODEL`, default embeddinggemma), zero-padded to the 1024-dim `text_vec`/`content_vec`; the studio route embeds on publish, best-effort (Ollama down ⇒ game still publishes, just not vector-indexed).
- `packages/gamekit/src/validate.ts`: new hard errors for **truncated artifacts** (missing `<html>` root, missing `</html>`, unclosed `<script>` count mismatch). This is what let a cut-off file reach the feed before.
- `packages/ai/src/generator.ts`: `extractHtmlArtifact` now handles unterminated fences and prose prefixes; the coder prompt asks for a bare `<!doctype html>` start.
- `apps/web/src/lib/db.ts`: postgres client memoised on `globalThis` (Next HMR was opening a new pool per edit and exhausting the dev DB's connections → ECONNRESET).
- `apps/web/next.config.ts`: loads the repo-root `.env` (Next only reads `apps/web`), transpiles the workspace packages.
- `scripts/audit-artifacts.ts`: audits every published game against the validator (missing file / sha mismatch / invalid) and `--fix` unlists the broken ones. Used to purge the truncated first generation.
- Tests: `apps/web/src/lib/feed.test.ts` rewritten for the DB-backed feed (seeded PGlite, empty-page-on-DB-failure); `packages/ai/src/openai-provider.test.ts` (10 tests: content, null-content retry, continuation splice, truncation throw, HTTP errors, env factory, extraction cases); gamekit truncation tests.

Verified end-to-end in a browser: `pnpm dev` → feed lists 9 real games → tapping a card loads the sandboxed artifact and the game plays → `/studio` generates a new game with `deepseek/deepseek-v4.1-flash`, validates it, publishes it, and it appears first in the feed. Suites: gamekit 71, ai 15, web 67, recsys 16, db 12, sdk 28, play-worker 9; typecheck clean in 8 workspaces.

## Done (trending/explore switch to game_stats_hourly)
- `packages/recsys` trending() and explore() now use a hybrid event split: completed hour buckets read `game_stats_hourly`, the current partial hour reads raw `events`. Split at the same TZ-independent UTC hour boundary the rollup truncates with (`to_timestamp(FLOOR(EXTRACT(epoch FROM now())/3600)*3600)`), so the sides never double-count or drop events. Pre-rollup, past-hour events are invisible to trending (documented, tested); a `db:rollup` run picks them up.
- 2 new candidate tests (rollup-gated visibility, explore sees rolled impressions); recsys 16/16, web 68/68, typecheck + build green.
- Production note: `db:stats` DDL must run before serving feed traffic, and a periodic `db:rollup` (e.g. every 5-15 min) keeps past-hour buckets fresh.

## Done (events rollup: game_stats_hourly)
- `packages/db/stats.sql`: `game_stats_hourly(game_id, hour, impressions, plays, plays15, likes, saves, remixes, comments, skips_fast)` PK (game_id, hour), applied via `pnpm --filter @playloop/db db:stats` (raw SQL like events.sql — not a drizzle-kit migration).
- `packages/db/src/rollup.ts`: `rollupGameStats(db, {from, to})` recomputes buckets from the events log with UTC hour truncation (`to_timestamp(FLOOR(EXTRACT(epoch FROM ts)/3600)*3600)`), `ON CONFLICT DO UPDATE` replaces counts so re-runs are idempotent and late-arriving events are picked up; ignores null game_id; returns buckets written. `getGameStats(db, gameId)` reads them back. 4 tests (column mapping, idempotency, incremental pickup, window isolation).
- CLI: `db:stats` (DDL) + `db:rollup` (full recomputation) added; `db:events` script was missing from package.json and is now wired too.
- Trending candidates in `packages/recsys` still read raw events; switching them to `game_stats_hourly` (or a hybrid for the current hour) is the natural follow-up once a cron drives the rollup.

Verified: packages/db 12 tests, typecheck clean in 8 workspaces, recsys 14 + web 68 still green against the new exports.

## Done (Phase 4b: share page /g/[id] + game detail API)
- `GET /api/games/[id]` (apps/web/app/api/games/[id]/route.ts): share detail — game + creator + counts + viewer (liked/saved/followsCreator) + forkedFrom provenance; 404s unknown and soft-deleted. 3 tests (likes bumped through the real route so denormalized counters stay honest).
- Share page `/g/[id]` (GameShareScreen + app/g/[id]/page.tsx): 9:16 playable sandboxed frame with tap-to-play overlay (posts `resume` to the guest), tags, remix provenance link to the parent's share page, creator row linking to `/u/<handle>`, Remix CTA to `/studio?remix=`, OG/Twitter metadata via generateMetadata (poster as og:image when posterKey exists). 107 kB first load.
- Feed card Share button routes to `/g/<id>`.
- Note: like/save denormalized counters (`games.likeCount` etc.) are maintained by their API routes — tests must go through those routes, not raw inserts, when asserting counts.

Verified: apps/web 68 tests, typecheck clean, `next build` green with /g/[id] in the route table.

## Done (Phase 4: profiles, publish lifecycle, remix provenance)
- `GET /api/users/[id]` (apps/web/app/api/users/[id]/route.ts): creator profile by uuid OR case-insensitive handle — profile fields, follower/following/game counts, viewer.following/isSelf, and published games with counts, artifactUrl, and `forkedFrom: {id, title}` remix provenance (parents resolved in one query). 3 tests.
- `PATCH /api/games/[id]` (apps/web/app/api/games/[id]/route.ts): creator-only edit of title/description/tags plus lifecycle `status: published|unlisted|draft`. Publish requires an attached artifact version (`no_version` 400 otherwise) and stamps publishedAt only on first publish; unpublish preserves it. 8 tests (401/403/400/404/200s).
- `GET /api/games/[id]/source` (apps/web/app/api/games/[id]/source/route.ts): returns the published version's artifact HTML from ARTIFACTS_DIR so the Studio can remix it (`baseCode` + `forkedFromId` on /api/studio/generate). 3 tests.
- Profile UI `/u/[handle]` (ProfileScreen): mobile-first header (avatar, handle, bio, counts), optimistic follow button wired to the existing follow API, 2-col game grid with remix provenance lines and play/like/remix counts.
- Feed cards: Remix button now routes to `/studio?remix=<gameId>`; creator handle in the rail links to `/u/<handle>`; cards show "🔁 remix of X" when forkedFrom is set.
- Studio remix flow: `/studio?remix=<gameId>` fetches base code, prefills the prompt, and sends `forkedFromId + baseCode + isRemix` through the generation pipeline. Publish modal's "Save details" PATCHes title/tags; shows remix provenance note.
- `useSearchParams` in StudioScreen requires the Suspense wrapper in app/studio/page.tsx (Next 15 static-render rule).

Verified: apps/web 65 tests (46 api + 6 anon + 4 feed + 5 auth + 2 db + 2 studio), typecheck clean in 8 workspaces, `next build` green with /u/[handle], /api/games/[id], /api/games/[id]/source in the route table.

## Done (Phase 3 AI pipeline & Studio, commit 521175e + fixes)
- AI Creation Pipeline (`packages/ai`): planner (GameSpec from prompt, archetype pick among the 8), code generator (template-grounded HTML5 output, `extractHtmlArtifact` strips markdown fences), static-validator repair loop (up to 3 attempts on `ValidationResult.errors`), metadata (embedded `pl-manifest` first, LLM/spec fallback), MockAiProvider for offline runs. 5 tests.
- SSE endpoint `POST /api/studio/generate` (apps/web): streams `progress` events through stages spec→generating→validating→repairing→metadata→done, writes the content-addressed artifact to `.artifacts/` and inserts game + version (game first with null publishedVersionId, then version, then update — the documented FK order). 2 tests.
- Mobile-first Studio UI (`/studio`): centered 9:16 sandboxed preview iframe (`sandbox="allow-scripts"`), floating prompt drawer with template chips, SSE progress stepper, pause/restart controls, publish modal. First Load JS 108 kB.
- Feed header launcher: `+ Vibecode` button linking to /studio.
- Fixed: `@playloop/db` has no `schema` namespace export — import as `import * as schema from '@playloop/db'` and take `eq` from `drizzle-orm` (see test files for the pattern).
- Fixed: `game_features` keys on `game_version_id` (→ `games.published_version_id`), NOT `game_id`. `follows` columns are `follower_id`/`followee_id`, NOT `following_id`.
- Fixed: `/api/feed` route handler must be `export const GET = wrap(async (req) => …)` — the wrap-returns-a-function anti-pattern breaks Next's route type contract.
- apps/web has `@/* → ./src/*` in tsconfig AND vitest.config.ts alias (vitest does not read tsconfig paths).
- Root `pnpm test` runs turbo with `--concurrency=1`: 8 parallel suites with PGlite WASM + Chromium crash V8 workers (ERR_IPC_CHANNEL_CLOSED) on this machine.

Verified: 184 tests across 7 test suites (sdk 28, gamekit 69 incl. Chromium smoke on 8 templates, ai 5, play-worker 9, db 8, recsys 14, web 51), typecheck clean in 8 workspaces, `next build` green (/studio + /api/studio/generate in route table).

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

## Session update — social shell + generation stability (2026-11-08)

The app is now a complete social product, not just a feed:

- **Accounts**: passwordless handle sign-in (`/login`, Credentials provider upserts a real `users` row), sign-out, session-backed likes/saves/comments/follows.
- **Chrome**: bottom nav (Home / Explore / Create / Activity / Profile) on every screen; feed top bar with a Create shortcut; Tailwind v4 finally installed so the studio renders styled (it was written in Tailwind classes but the package was never installed — the create page was raw HTML).
- **Scrolling**: bidirectional (vertical swipe, wheel, keyboard ↑/↓/PageUp/PageDown/Home), one card per gesture. The old "tap to play" overlay sat above the gesture layer and swallowed every swipe — that is why only the rail arrow worked.
- **Interactions**: like/save/follow with optimistic updates and 401 → sign in, comments sheet, native share + copy link, remix, report (`/g/<id>`).
- **Discovery**: `/explore` search over titles/tags/creators, `/t/<tag>`, `/saved`, `/notifications`, `/u/<handle>` with follow state and a playable grid.
- **Generation**: the provider now streams (`stream: true`, SSE deltas, idle timeout re-armed per chunk) instead of buffering behind a 180 s abort — that abort was the "it fails to load/generate" reports. A complete `</html>` is accepted even when `finish_reason=length`; the coder prompt now demands a compact (<30 KB), comment-free, fully closed file. The studio SSE emits a 5 s heartbeat with elapsed seconds so a 9-minute run never looks hung.
- **Cards**: a cover backdrop (title + creator on a gradient) sits behind the iframe, so a slow first paint never reads as a broken black frame; load failures offer Retry instead of auto-skipping.

Measured: real LLM run = ~7 min generation + 1 repair + metadata ≈ 9.5 min end-to-end on `deepseek/deepseek-v4.1-flash`; the run publishes and appears in the feed.

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
1. P2-T4/T5 background jobs: embeddings into `game_features` (text/visual/content vectors), poster frame capture (og:image then works end-to-end).
2. Real LLM provider client (pluggable behind the `AiProvider` interface; `MockAiProvider` is the offline default).
3. Collections / saved games page (P2-T1 remainder) + comments sheet UI (P2-T2).
4. Periodic `db:rollup` scheduling (cron job or Inngest) once infra exists.
