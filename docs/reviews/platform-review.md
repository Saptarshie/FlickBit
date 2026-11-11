# PlayLoop — Independent Platform, Performance & Security Review

**Reviewer stance:** adversarial. Nothing below is taken from `docs/13-implementation-status.md` on trust; every claim is either read in source or produced by running something against the repo.
**Date:** 2026-11-11 · **Repo:** `D:/prac_prog/fun/PlayLoop` (pnpm monorepo, 8 workspaces)
**Scope:** data layer, security, reliability, tests, build/packaging.
**Rules observed:** no source edits, no `git`, no `pnpm install`, no server restarts.

---

## Verdict: **DO NOT SHIP**

The dev experience is polished and the artifact sandbox is genuinely well built. But this cannot go to production in its current state: `pnpm run build` **fails**, there is **no rate limiting anywhere**, generation is **unauthenticated and auto-publishes unmoderated AI content**, and the login provider is **passwordless for any handle**. Those are not hardening items, they are the product breaking.

---

## 0. What was actually executed (evidence base)

| Check | Command | Result |
|---|---|---|
| Build | `pnpm run build` | **FAIL** — `Invariant: no direct app page entry found for /_not-found` (reproduced twice, second time after `rm -rf apps/web/.next`) |
| db tests | `pnpm --filter @playloop/db run test` | 4 files / **12 passed** |
| recsys tests | `pnpm --filter @playloop/recsys run test` | 3 files / **16 passed** |
| gamekit tests | `pnpm --filter @playloop/gamekit run test` | 3 files / **71 passed** (111 s, Playwright smoke) |
| sdk tests | `pnpm --filter @playloop/sdk run test` | 3 files / **36 passed** |
| ai tests | `pnpm --filter @playloop/ai run test` | 2 files / **16 passed** |
| play-worker tests | `pnpm --filter @playloop/play-worker run test` | 1 file / **9 passed** |
| web tests | `pnpm --filter @playloop/web run test` | 6 files / **71 passed** |
| Live DB survey | `postgres` client → `127.0.0.1:5432` | PGlite 0.5.15 / PG 18.6; 12 games, 12 versions, 3 features, **0 events, 0 stats rows**, 0 likes/comments/scores |
| Query plans | `EXPLAIN (ANALYZE, BUFFERS)` of the four candidate queries against a throwaway in-memory PGlite loaded with 20 k games / 120 k events / 159 k follows | numbers in §2 |
| Partition edge case | insert `events.ts = 2027-07-15` in a rolled-back txn | **FAILS**: `no partition of relation "events" found for row` |

Totals: **231 tests, 7 suites, all green.** Green tests and a broken build is exactly the failure mode CI is configured to miss (§6).

> **Environment incident, disclosed:** while measuring index behaviour I loaded 400 k synthetic event rows into the live dev PGlite through the wire protocol. The PGlite socket server dropped the connection mid-statement and the process exited; `scripts/dev.mjs` then tore down web and worker (by design). The stack is therefore **down** at the time of writing — I did not restart it, per instructions. `.data/pglite` is intact and `pnpm dev` will bring it back (migrate + seed are idempotent). This is itself finding **P1-3**.

---

## 1. Findings index

| ID | Severity | Area | One line |
|---|---|---|---|
| P0-1 | P0 | Build | `pnpm run build` fails; no production artifact exists |
| P0-2 | P0 | Security/Auth | Credentials provider accepts any handle with no password → account takeover |
| P0-3 | P0 | Security/Cost | `POST /api/studio/generate` runs unauthenticated, unrate-limited, uncapped → unbounded LLM spend |
| P0-4 | P0 | Security/Content | Every generated game is inserted `status=published`, `moderation=approved` with no review gate |
| P0-5 | P0 | Reliability | Generation runs inline in the request; no job row, no credits, no cost accounting, no idempotency |
| P1-1 | P1 | Performance | Four feed candidate queries have **no `LIMIT`**; 557 ms at only 20 k games |
| P1-2 | P1 | Performance | Missing `follows(followee_id)` index (522 index probes per follower count); `model_runs(job_id)`, unique `idempotency_key` also missing |
| P1-3 | P1 | Reliability | One child exit (or one heavy query) kills the whole dev stack; no restart, orphans on Windows |
| P1-4 | P1 | Data | `events` partitions cover Nov 2026–Apr 2027 only, no DEFAULT partition → analytics hard-fails after that |
| P1-5 | P1 | Product/Recsys | No client ever posts events; `play_count` never incremented → trending/explore signals are inert |
| P1-6 | P1 | Security | Zero rate limiting in the entire codebase, despite the spec requiring it |
| P1-7 | P1 | Security | Unauthenticated `POST /api/events` with client-controlled `ts` → recommendation poisoning + table flood |
| P1-8 | P1 | Security | Play origin has no `frame-ancestors`/XFO and hashes+parses up to 500 KB on every hit |
| P1-9 | P1 | Packaging | Only `@playloop/web` has a build; worker has no build/start; CI never builds |
| P1-10 | P1 | Correctness | `/api/media/*` route does not exist, but the feed returns `posterUrl: /api/media/...` |
| P1-11 | P1 | Correctness | `/api/games/[id]/source` resolves `ARTIFACTS_DIR` differently from the generator → remix 404s |
| P1-12 | P1 | Integrity | Scores are client-supplied with no bounds → leaderboard is trivially forgeable |
| P1-13 | P1 | Tests | No auth/abuse tests for the generation route; the only success test *asserts* auto-publish |
| P2-1..P2-9 | P2 | misc | see §2–§5 |

---

## 2. Data layer

### P1-1 — Candidate generators fetch the whole games table (`no LIMIT`)
`packages/recsys/src/candidates.ts:63-69` (`trending`), `:101-111` (`fresh`), `:145-156` (`social`), `:189-215` (`explore`) all `ORDER BY …` with **no `LIMIT` and no `OFFSET`**, then slice in JS (`:85`, `:127`, `:172`, `:231`). Every feed request therefore reads, computes a score for, sorts and materialises **every published game**.

Measured (in-memory PGlite, 20 000 games, 120 000 events, 5 000 stats rows, 159 600 follows — full plans in the appendix run):

| query | plan | execution | rows returned |
|---|---|---|---|
| `trending` | `Seq Scan games (20 000)` → 2× Hash Left Join → `Sort` (2.0 MB quicksort) | **557 ms** | 20 000 |
| `explore` | same shape | 367 ms | 20 000 |
| `social` | `Nested Loop` + `Memoize` (20 000 cache probes) → Sort | 128 ms | **19 950 for one user** |
| `fresh` | `Seq Scan` → Sort | 97 ms | 20 000 |

At 20 k games a single cold feed request costs ~1.1 s of DB time for a 10-card page, and `GET /api/feed` fires all four concurrently (`packages/recsys/src/feed.ts:48-53`), so 10 cards cost four full scans. Memory scales linearly with the catalogue (sort spills at ~50 k games).

**Fix:** `LIMIT` in SQL. `trending`/`explore` need the ownership test pushed down: `ORDER BY (<score expr>) DESC LIMIT $1` still sorts everything; the real fix is to materialise the score (`game_stats_hourly` already exists — add a `score` column refreshed by the rollup) and index it, then `ORDER BY score DESC LIMIT $1`. For `fresh`/`social`, use `WHERE (published_at, id) < ($cursor)` keyset pagination against `games_status_published_idx`. Also stop passing `seenGameIds` into SQL only in JS — filter with `id <> ALL($seen)` in the query.

### P1-1b — No partition pruning on the "current hour" CTE
Plans show `Append` over all six `events_*` partitions with **5 `Index Searches` + 5 `Seq Scan`s** per query, because the cutoff comes from `WITH h AS (SELECT to_timestamp(...))` (`candidates.ts:31`, `:190`) — a CTE the planner cannot fold into a constant. With 36 monthly partitions this becomes 36 probes per feed request.
**Fix:** compute the hour boundary in the API layer and pass it as a bind parameter (`$1`), which enables runtime pruning; or `AND e.ts >= now() - interval '2 hours'` with an explicit upper bound.

### P1-2 — Missing indexes for real query shapes
Catalog dump from the live DB (`pg_indexes`) vs. queries actually executed:

| Query | Source | Index available | Verdict |
|---|---|---|---|
| `SELECT count(*) FROM follows WHERE followee_id = $1` | `apps/web/app/api/users/[id]/route.ts:39-42` | PK is `(follower_id, followee_id)` (`packages/db/migrations/0000_init.sql:37`) | **No usable prefix.** Plan: `Bitmap Index Scan on follows_follower_id_followee_id_pk` with **522 index searches** (one per followee_id value scanned) and 399 heap blocks |
| followers list / fan-out | same + `packages/recsys/src/candidates.ts:152` | none on `followee_id` | seq scan |
| `model_runs WHERE job_id` | `packages/db/src/schema/ai.ts` (cost reporting) | **no index at all** | full scan |
| `generation_jobs.idempotency_key` | `0000_init.sql:251` | **no unique index** | idempotency cannot be enforced |
| `scores WHERE game_id ORDER BY score DESC` | `apps/web/app/api/games/[id]/leaderboard/route.ts` | `scores_game_score_idx (game_id, score)` ✔ | OK |
| `comments WHERE game_id ORDER BY created_at` | `comments/route.ts:51-54` | `comments_game_created_idx` ✔ | OK |
| `games WHERE status='published' ORDER BY published_at` | `candidates.ts:110` | `games_status_published_idx (status, published_at)` exists but is **unused** — no `LIMIT`, so the planner prefers seq-scan + sort | index can't help until P1-1 is fixed |

**Fix:** `CREATE INDEX follows_followee_idx ON follows (followee_id, created_at)`; `CREATE INDEX model_runs_job_idx ON model_runs (job_id)`; `CREATE UNIQUE INDEX generation_jobs_idem_uq ON generation_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL`; for search, enable `pg_trgm` and add `games_title_trgm_idx USING gin (title gin_trgm_ops)`.

### P1-4 — Event partitions expire in five months
`packages/db/events.sql:27-41` creates partitions for `m IN 0..5` **once, at apply time**, with no `DEFAULT` partition and no scheduled job to create more. Verified: inserting an event with `ts = 2027-07-15` returns `no partition of relation "events" found for row`. Every `POST /api/events` after **2027-05-01** will 500, the `live` CTE in trending/explore dies with it, and the failure is silent to the client (middleware marks `/api/events` public; the beacon gets a 500 and nobody notices).
Backdating is the mirror image: `events.ts` is client-supplied (`apps/web/app/api/events/route.ts:17-20,86`) with no window check, so an attacker writes rows into any existing partition.
**Fix:** add `CREATE TABLE events_default PARTITION OF events DEFAULT;` and a `pg_cron`/worker job that creates the next 3 months monthly; clamp `ts` server-side to `now() ± 5 min`.

### P1-5 — The analytics loop is not wired at all
- No client code calls `/api/events` (grep across `apps/web/src` and `apps/web/app`: the only hits are the route itself and middleware allow-lists).
- Nothing increments `games.play_count` / `play15_count` (grep: only reads in `search`, `users/[id]`, `games/[id]`).
- Live DB: `events = 0`, `game_stats_hourly = 0`; `packages/db/src/rollup.ts` is only reachable via the manual `db:rollup` CLI, never scheduled.

Consequence: `trending.score` is `0 / 20 = 0` for every game, so `ORDER BY score DESC, published_at DESC` degenerates into newest-first; `explore` is `ORDER BY 0 ASC, published_at DESC`, also newest-first. Three of the four candidate streams return the same ordering, and `search`'s `ORDER BY play_count DESC` is a no-op tie. The "recommendation system" currently adds no ranking signal whatsoever.
**Fix:** emit `impression`/`play_15s`/`like` from `GameCardView` + `FeedScreen` on the existing SSE-free beacon path; schedule `rollupGameStats` every 5 min; filter `feed_eligible` in the candidate SQL.

### P2 (data)
- `game_features` is only written by the generation route (`apps/web/app/api/studio/generate/route.ts:149-161`); seeded/template games have no feature row, so `quality_score` is always `NULL` → ranker's `quality` term is a constant 0.5 (`packages/recsys/src/ranker.ts:53`).
- `feed.ts:75` builds `sql.join(topIds.map(...))` — safe here because the early return at `:65` guarantees non-empty, but there is no guard if a future refactor reorders it; `IN ()` is a syntax error.
- `fetchFeedPage` ignores `opts.anonId` entirely (`packages/recsys/src/feed.ts:34-53`); anon identity is minted and then thrown away.
- `GET /api/games/[id]/comments` (`comments/route.ts:39-54`) and `GET /api/users/[id]` (`:76-77`) have **no `LIMIT`** — unbounded payloads on popular games/creators.
- `search` uses `ILIKE '%q%'` (`apps/web/app/api/search/route.ts:35-46`): seq scan 65 ms at 20 k rows (measured), no trigram index, no minimum query length, and unescaped `%`/`_` so `q=%` matches everything.

---

## 3. Security

### P0-2 — Any handle is a valid login (account takeover)
`apps/web/auth.ts:79-118`: the `handle` Credentials provider takes a handle, looks the user up (`:90-92`), creates it if missing (`:95-100`), and **returns a session with no password, no code, no email verification**. There is no `NODE_ENV` guard. Anyone can `POST /api/auth/callback/handle` with `handle=playloop` (or any admin) and own that account. `normalizeHandle` (`:32-41`) only sanitises the string.

The magic-link provider (`:131-148`) is fine, but the credentials provider is a back door that makes every `requireUser` check meaningless.

**Fix:** gate the provider behind `process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH === '1'`; in production use only OAuth + magic link, and add `emailVerified` to the JWT before allowing generation.

### P0-3 — Unauthenticated, uncapped LLM spend
`apps/web/app/api/studio/generate/route.ts:31-49`: if there is no session it falls back to the `playloop` user and, if that is missing, **creates a user inline**. No `requireUser`. Combined with P0-2 (instant session for any handle) and P1-6 (no rate limit), the endpoint is effectively public.

Cost surface per request:
- `prompt` has **no length cap** (`:23-29`) — only emptiness is checked;
- `baseCode` is likewise unbounded and fed straight into the prompt (`:104`);
- `runGenerationPipeline` does plan → generate → up to 3 repair rounds → metadata (`packages/ai/src/pipeline.ts:31,40,52-62,83`), and each LLM call can itself retry at double budget (`packages/ai/src/openai-provider.ts:68-78`) and splice up to 3 continuations (`:83-102`) → **worst case ≈ 12 completions of up to 64 k output tokens** per HTTP request, with a 120 s idle timeout each (`:56,124`);
- there is no `maxDuration`, no overall deadline, no per-user budget and **no credits deduction** — `credit_ledger`, `generation_jobs`, `gen_events` and `model_runs` are never written by any production code path (grep confirms: schema only).

`docs/07-api-spec.md:41` and `docs/09-security-moderation.md:17` both *require* per-user/day caps, credits and idempotency keys. None exist.

**Fix:** `requireUser` + verified email; `prompt ≤ 2000`, `baseCode ≤ 100 KB`; insert a `generation_jobs` row with `idempotency_key`, debit `credit_ledger` before the first call, write `model_runs` per completion; a global daily budget check with a hard `maxDuration`; rate limit per user and per IP.

### P0-4 — Auto-publish with `moderation='approved'`
`route.ts:122-131` inserts `status: 'published', moderation: 'approved'` for whatever the model returned, then `:143-145` points `published_version_id` at it. The only gate is `validateGame` (`packages/gamekit/src/validate.ts:270`), which is a **denylist** of 19 literals plus a size check — it does not look at content, and `globalThis['fet'+'ch']` or `this['eval']` trivially bypasses the substring list (the real containment is the play-origin CSP, which is good).
`docs/09-security-moderation.md:21-23` mandates prompt moderation and a `moderation=pending` publish gate. Neither exists, and there is no `/api/admin/*` route at all.
**Fix:** insert `moderation: 'pending', status: 'draft'`, run the classifier, and only promote on pass; never let the generation route set `approved`.

### P1-6 — There is no rate limiting anywhere
`grep -rniE 'rate.?limit|throttle|slowdown|upstash'` over `apps/` + `packages/`: the only hits are comments in `packages/sdk/src/shim-source.ts`. No middleware limiter, no per-route limiter, no upstream WAF config, no `Retry-After`.
Affected: `/api/events` (flood), `/api/studio/generate` (spend), `/api/search` (seq scan per keystroke), `/api/games/[id]/comments` (spam), `/api/games/[id]/score` (flood), and the play origin's `/v/:sha.html` (see P1-8).
**Fix:** one limiter (Upstash or a token bucket in Redis, already in `docker-compose.yml:9-11`) applied in `middleware.ts` with per-route budgets from `docs/07-api-spec.md:41`; 429 + `Retry-After`; separate buckets for anon vs authed.

### P1-7 — Event beacon is an unauthenticated write with a client-supplied timestamp
`apps/web/app/api/events/route.ts:61-97`: no auth by design (`middleware.ts:10`), no origin check, no rate limit, `gameId` is any UUID (no existence check), `ts` is any parseable date, and 50 rows per request with unlimited requests. This is both a **table-growth DoS** and a **ranking poison** (spam `like`/`remix` events for your own game, or `impression` events for a rival to tank its engagement rate).
Also `props` is `z.record(z.string(), z.unknown())` (`:25`) with no depth/size bound beyond the 50-event cap.
**Fix:** require a same-origin `Origin`/`Sec-Fetch-Site` header, clamp `ts` to a 10-minute window, verify `gameId` exists and is published, rate limit by anon id + IP, cap `props` to 1 KB serialized.

### P1-8 — Play origin: no framing protection, expensive per request
`apps/play-worker/src/app.ts:9-12`: the CSP has `frame-src 'none'` (children) but **no `frame-ancestors`**, and there is no `X-Frame-Options`. Any site can iframe `/v/<sha>.html` — impact is low (no cookies in an opaque origin) but it is free clickjacking surface on a games product, and the spec's "verified by scanner" line (`docs/09:41`) will fail.
`:57-92` re-reads the file, re-hashes up to 500 KB with SHA-256, re-parses the manifest and re-injects the 18 KB shim **on every request**, with no `ETag`/`If-None-Match`, no in-process cache and no rate limit. A 100-byte request buys ~500 KB of I/O + hashing: a cheap amplification vector, and p99 latency is dominated by work that never changes for a given SHA.
**Fix:** `frame-ancestors http://localhost:3000 https://app.playloop...`; add `X-Frame-Options: SAMEORIGIN`-equivalent; cache `sha → {body, etag}` in an LRU (the content is immutable and hash-verified); answer `If-None-Match` with 304; add `compression`.

What is right here, and worth keeping: `ARTIFACT_FILE_RE` (`:17`) + `path.join` on a 64-hex name makes traversal impossible; hash verification (`:75-79`) is a real integrity control; `sandbox="allow-scripts"` without `allow-same-origin` on all three iframes (`GameCardView.tsx:472`, `GameShareScreen.tsx:54`, `StudioScreen.tsx:208`) is the correct primitive; the shim's `ancestorOrigins` check (`shim-source.ts:448-460`) is a sensible substitute for opaque-origin `event.source`.

### P2 (security)
- `packages/sdk/src/host.ts:253-264` posts with target origin `'*'`. Necessary for an opaque origin, but it means if a game navigates itself to a remote page, host messages (`storage:result` payloads included) follow it. Add `sandbox` without `allow-top-navigation` (already) **plus** a `beforeunload`/`load` guard that tears the host down, or wrap storage results in an id the attacker can't correlate.
- `host.ts:284-292` only counts **invalid** messages and resets on the first valid one; a hostile artifact can call `parent.postMessage` directly (bypassing the shim's 60/s limiter, which is guest-side only) at line rate and drive `onMessage`/React work. Add a host-side token bucket and ignore floods.
- Shim overrides `Date.now` (`shim-source.ts:100`) but not `new Date()`, so a paused game reading `new Date()` sees real wall time — inconsistent virtual clock.
- No CSP on the **app** origin (`apps/web/next.config.ts` sets no `headers()`), while `docs/09:15` requires "CSP on app origin with nonces". No HSTS, no `Referrer-Policy`.
- `session: { strategy: 'jwt' }` (`auth.ts:153`) with an adapter configured: no server-side revocation, so a banned/mod removed user keeps a valid token until expiry; `token.handle` is never refreshed after a rename.
- `validateGame` is denylist-only and its "external URL" scan (`validate.ts:292-303`) can be defeated with `h`+`ttps://`; treat it as a lint, not a security boundary.

---

## 4. Reliability

### P0-5 — Generation lives inside the HTTP request
`route.ts:70-180` runs the whole pipeline in a floating async IIFE that writes to a `TransformStream`. If the client disconnects, `writer.write` rejects; the `catch` then calls `sendEvent('error', …)` (`:172-176`) which rejects too → **unhandled promise rejection**, and `writer.close()` in `finally` (`:177-179`) can reject as well. The DB work already done is orphaned: the artifact file is written (`:118-119`) before the game row (`:122`), so a failure between the two leaves a 500 KB file on disk that nothing references — and if the insert of the game succeeds but the version insert fails, a `published` game with `published_version_id = NULL` is left in the feed join.
No retry, no resume, no job record, no `maxDuration`. `docs/13:103` mentions "a 9-minute run" — a 9-minute Next request handler is not a job queue.
**Fix:** the route should insert a `generation_jobs` row and return `202 {jobId}`; a worker process (`apps/play-worker` is the natural home) consumes it and streams progress from `gen_events`. Wrap the generator so DB writes happen in one transaction (`games` → `game_versions` → `UPDATE games` is already the right order, just make it atomic).

### P1-3 — One failure takes down the dev stack; Ctrl-C leaks processes
`scripts/dev.mjs:27-31`: any child exit → `shutdown()` → kills all children → `process.exit`. There is no restart, no backoff, and no distinction between "web crashed" and "db crashed". Observed live: the DB child died under a large insert, and web + worker went down with it.
`:39-46` uses `child.kill('SIGTERM')` for every child. On Windows `SIGTERM` is `TerminateProcess` on the direct child only, while `shell: process.platform === 'win32'` (`:24`) means each child is a `cmd.exe` wrapper — so `next dev` and `tsx` grandchildren survive and keep :3000/:3001 bound. `:46` then `process.exit` after 500 ms regardless.
`:78-86`: on `waitForPort` failure it calls `shutdown(1)` and **keeps executing** — printing "database ready" and spawning turbo seconds before the process exits.
**Fix:** use `taskkill /T /F /PID` (or `tree-kill`) on Windows; `return` after `shutdown(1)`; supervise the DB child separately and restart it with backoff instead of tearing the world down.

### Timeouts on external calls
| Call | Timeout | Verdict |
|---|---|---|
| Ollama embeddings | 30 s, `AbortController` (`packages/ai/src/embeddings.ts:31-51`) | ✔, returns `null` and the game still publishes (`generate/route.ts:149-161`) — acceptable degradation |
| LLM completions | 120 s **idle** per chunk (`openai-provider.ts:56,124-128`) | partial: no total deadline, so a chatty stream can run for hours |
| DB queries | **none** | `postgres(url, { max: 4, ... })` in `apps/web/src/lib/db.ts:32` sets no `statement_timeout`/`connect_timeout`; a hung backend pins the request and one of only 4 pool slots |
| LLM call on worker/HTTP fetch | n/a — no fetch in the worker | ✔ |

Also: `getDb()` silently throws only when `DATABASE_URL` is unset (`db.ts:29`); with the DB down, read paths degrade well (`fetchFeedGames` catches and returns an empty page, `apps/web/src/lib/feed.ts:54-57` — and the tests prove it), but `/api/search`, `/api/users/[id]` and every mutation return a raw 500 via `wrap()` (`api-helpers.ts:77-81`).
Ollama-down is handled correctly; **LLM-down** is not: a provider error surfaces as the SSE `error` event and the game is dropped, with no retry and no user-visible reason beyond `err.message`.

### P2 (reliability)
- `dev-db.ts:63` opens the PGlite socket server with `maxConnections: 10`, while the app holds 4 (`db.ts:32`) **plus** a separate 4-connection pool created at import time for NextAuth (`auth.ts:25`). That leaves 2 for scripts/tests; combined with `dev.mjs` restarts, this is why "the dev DB drops the oldest sockets" (comment at `db.ts:11-16`).
- `dev-db.ts` runs migrations + seed on every boot with no guard on a partially-applied migration; a throw exits 1 and `main().catch` prints a stack — fine — but the seed writes artifacts to `apps/play-worker/artifacts` while the generator writes to `path.resolve(repoRoot, ARTIFACTS_DIR)` (`generate/route.ts:51-56`) and the source route to `process.env.ARTIFACTS_DIR || ../../.artifacts` (`source/route.ts:44-45`). **Three different resolutions of the same setting** → see P1-11.
- `scripts/audit-artifacts.ts` is manual-only; nothing detects a published game whose artifact is missing at runtime (the worker 404s and the card shows a black frame).

### P1-10 / P1-11 — Two dead links in the core loop
- `packages/recsys/src/feed.ts:136` returns `posterUrl: /api/media/${posterKey}`, but `apps/web/app/api/` has no `media` route (dirs: auth, comments, events, feed, games, me, notifications, search, studio, users). Every poster 404s.
- `source/route.ts:44-48` reads `${ARTIFACTS_DIR}/${sha}.html` with a **relative** `ARTIFACTS_DIR` (`./apps/play-worker/artifacts` in `.env`) resolved against `process.cwd()` (`apps/web`), i.e. `apps/web/apps/play-worker/artifacts`. The generator resolves the same value against the repo root (`generate/route.ts:53-55`). Result: generation succeeds, remix returns 404. The test passes only because it injects an absolute path.
**Fix:** one `resolveArtifactsDir()` helper in a shared package, used by worker, generator, source route, seed and audit script; plus a real `/api/media/[...key]` route (or drop `posterKey` everywhere).

### P1-12 — Client-authoritative scores
`apps/web/app/api/games/[id]/score/route.ts:16-20,57-66` accepts any finite number from the client and stores it. `leaderboard/route.ts` then sorts by it. No max, no rate limit, no "did this score come from a run of this version", no server-side replay of game events. A one-line `fetch` puts 10^9 at the top of every leaderboard permanently. For a games product, leaderboard integrity is a trust issue, not a nit.
**Fix at minimum:** clamp to the manifest's declared scoring range, one row per `(user, version)` best-of, rate limit; properly: accept only signed score submissions verified against a server-issued run token.

---

## 5. Tests — 231 green, and what they do not cover

All suites pass. The distribution is lopsided and several critical paths have no test at all.

| Area | Tests | Notes |
|---|---|---|
| `gamekit` | 71 (111 s) | strongest suite: validation, templates, Chromium smoke on 8 templates |
| `web` | 71 | good API-surface coverage: like/save/comment/follow/notify/report/score/PATCH publish/unpublish/feed honesty |
| `sdk` | 36 | protocol + host + shim |
| `ai` | 16 | provider streaming/continuation/truncation — good |
| `recsys` | 16 | candidates/ranker/feed |
| `db` | 12 | schema, events, rollup, seed |
| `play-worker` | 9 | CSP headers, traversal, hash mismatch, no-manifest, shim injection — good |

Coverage gaps, in order of risk:
1. **Generation auth/abuse is untested.** `apps/web/test/studio.test.ts:51-83` is the only success-path test, and it asserts `games[0].status === 'published'` — it *locks in* P0-4. No test asserts a 401 for an unauthenticated caller, because there isn't one.
2. **No rate-limit tests** (there is nothing to test).
3. **No test for the events partition horizon** (P1-4) — would have caught it in one line.
4. **No test for `ARTIFACTS_DIR` resolution** (P1-11); the source-route test injects an absolute dir (`api.test.ts`, `GET /api/games/[id]/source`), hiding the bug.
5. **No DB-level performance assertion**: nothing runs the candidate queries against a seeded ≥1 k-game DB, so "no LIMIT" is invisible to CI. A single test loading 5 000 games and asserting `EXPLAIN` has no `Seq Scan`+`Sort` on `games` would have caught P1-1.
6. **No test exercises the real auth provider** — `auth.test.ts` only checks that the config parses and that Google is omitted; nothing asserts the handle provider requires… anything.
7. **No coverage tooling at all**: no `@vitest/coverage-*` dependency, no `--coverage` script, no thresholds. `--passWithNoTests` is set on six packages (`db`, `recsys`, `ai`, `gamekit`, `sdk`, `play-worker`, `ui`), so a suite that silently collects zero tests is green.
8. `packages/ui` has `test: vitest run --passWithNoTests` and zero test files — the workspace exists to satisfy the glob.

---

## 6. Build & packaging

### P0-1 — `pnpm run build` fails, reproducibly
```
@playloop/web:build: ✓ Compiled successfully in 20.6s
@playloop/web:build: > Build error occurred
@playloop/web:build: [Error: Invariant: no direct app page entry found for /_not-found]
```
Reproduced twice: once as-found, once after deleting `apps/web/.next`. The compile succeeds and it dies during "Collecting page data". There is no `app/not-found.tsx` in `apps/web/app`, and `app/g/[id]/page.tsx:99` calls `notFound()`; the invariant is consistent with Next 15.5.28 failing to synthesise the `/_not-found` entry for this tree.
**Fix path:** add `apps/web/app/not-found.tsx`, re-run; if it persists, `next build --debug` and try pinning Next (15.5.28 is a patch-level suspect) — and, most importantly, put `pnpm build` in CI so this can never be merged again.

Consequence: there is **no production artifact for the web app**, so the "107 kB first load" claim in `docs/13:39` cannot be verified, bundle budgets cannot be enforced, and nothing here has ever been built for production.

### P1-9 — Only one of eight packages can build
`turbo run build` reports `Packages in scope: 8` and `Tasks: 0 successful, 1 total` — only `@playloop/web` defines `build`. `packages/*` are consumed as TypeScript source via `transpilePackages` (`apps/web/next.config.ts:36`), which works for Next but means:
- `@playloop/play-worker` has **no `build` and no `start`** (`apps/play-worker/package.json` scripts: `dev`, `typecheck`, `lint`, `test`) — the artifact server can only run under `tsx`, i.e. never as a production deployment. It is also the security-critical process (CSP, hash verification) and has no Dockerfile.
- `@playloop/db`, `@playloop/sdk`, `@playloop/gamekit`, `@playloop/ai`, `@playloop/recsys`, `@playloop/ui` produce no `dist/`, no `.d.ts`, no publishable artifact. Fine for a private monorepo, but it means the worker cannot be containerised without a bundler step.
- `docker-compose.yml` provisions postgres/redis/minio/mailpit, but redis and minio are **unused by any code** (no `ioredis`/`@aws-sdk` dependency anywhere) — infra that implies caching/queue/object-storage that does not exist.
- `lint` is `tsc --noEmit` in all eight workspaces. There is no ESLint, no `eslint-plugin-react-hooks`, no import-boundary rule — "lint" is a second typecheck.

### CI
`.github/workflows/ci.yml:13` runs `pnpm typecheck && pnpm lint && pnpm test`. It does **not** run `pnpm build`, so P0-1 ships green CI forever. It also doesn't run `test:smoke` (Playwright) explicitly — it happens to be inside `gamekit`'s `test`.

---

## 7. Top 5 blockers

1. **The build is broken** (P0-1). Nothing can be deployed. Fix the `/_not-found` invariant and add `pnpm build` to CI in the same PR.
2. **Any handle is a valid login** (P0-2, `auth.ts:79-118`). Every authorization check in the app is downstream of a provider that authenticates nobody.
3. **Generation is public money** (P0-3 + P0-4 + P1-6): unauthenticated, uncapped prompt → ≤12 LLM completions → auto-published, auto-approved, unmoderated game. Add auth, caps, credits, a rate limit, and a `pending` moderation gate before this endpoint is reachable from the internet.
4. **The feed does four full-table scans per page** (P1-1: 557 ms/367 ms at 20 k games, no `LIMIT`), and the engagement signal that is supposed to justify the ranking has **zero input** (P1-5: no events emitted, no rollup schedule). Performance and product quality are the same bug here.
5. **Nothing degrades gracefully** (P0-5 + P1-3): generation is a 9-minute request handler with no job record, no cost record, no retry, and a dev supervisor that takes the whole stack down when any child hiccups.

Ship criteria, in order: build green in CI → real auth → authz + rate limits + credits on generation → `LIMIT`/keyset + a real analytics loop → generation moved into a job with `generation_jobs`/`credit_ledger`/`model_runs` written.

---

## Appendix A — Query plans (measured)

In-memory PGlite, migrations + `events.sql` + `stats.sql`, then 20 000 games, 120 000 events (current month), 5 000 `game_stats_hourly` rows, 159 600 follows, `ANALYZE`.

```
=== trending   Execution Time: 557 ms   rows=20000
  Sort  (quicksort 2075kB)
    -> Hash Left Join (g.id = live.game_id)      rows=20000
       -> Hash Left Join (g.id = rolled.game_id) rows=20000
          -> Hash Left Join (published_version_id)  rows=20000
             -> Seq Scan on games  Filter: status='published' AND moderation='approved'
          -> HashAggregate on game_stats_hourly  rows=4998   (Bitmap Index Scan hour_idx, Index Cond: hour < h.t)
       -> HashAggregate on live  rows=17527
          -> Append over events_2026_11..2027_04   Index Searches: 5  (+5 Seq Scans on empty partitions)
=== explore    Execution Time: 367 ms   rows=20000
=== social     Execution Time: 128 ms   rows=19950   (Memoize cache probes: 20000)
=== fresh      Execution Time:  97 ms   rows=20000
=== followerCount  Execution Time: 7.5 ms
  Bitmap Index Scan on follows_follower_id_followee_id_pk
    Index Cond: (followee_id = …)   Index Searches: 522   Heap Blocks: 399
=== searchIlike  Execution Time: 65 ms   (Seq Scan games rows=11111, top-N heapsort)
```

`Index Searches: 522` is the missing-index signature: the planner is walking 522 distinct `followee_id` entries through a PK that leads with `follower_id`.

## Appendix B — Files read (no modifications)

`packages/db/{migrations/0000_init.sql, events.sql, stats.sql, src/schema/*}`, `packages/recsys/src/*`, `packages/sdk/src/*`, `packages/ai/src/*`, `packages/gamekit/src/{index,validate}.ts`, `apps/play-worker/src/*`, `apps/web/src/{auth.ts, lib/*, middleware.ts}`, `apps/web/app/api/**`, `apps/web/app/{layout,page,g/[id]}.tsx`, `apps/web/next.config.ts`, `apps/web/test/*`, `scripts/*`, `turbo.json`, `package.json` (root + all workspaces), `.github/workflows/ci.yml`, `docker-compose.yml`, `docs/{07,09,13}*`.

Files created by this review: this document only. Scratch benchmark/EXPLAIN scripts were written outside the repo (`%LOCALAPPDATA%/hermes/cache/scratch`).
