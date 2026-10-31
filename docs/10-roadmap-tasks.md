# 10 — Roadmap & Atomic Tasks

Each task: ID, goal, deliverable, acceptance (AC). Do them in order; don't start a phase until the prior gate passes. All UI tasks must satisfy doc 12 (mobile-first).

## Phase 0 — Foundations (1 wk)
- P0-T1 Monorepo: pnpm + turborepo, apps/web (Next 15 TS, Tailwind, shadcn), packages/{db,sdk,gamekit,recsys,ui}. AC: `pnpm dev`, `pnpm lint`, `pnpm test`, `pnpm typecheck` all green in CI (GitHub Actions).
- P0-T2 docker-compose: postgres+pgvector, redis, minio, mailpit. `.env.example`. AC: `pnpm infra:up` then app boots.
- P0-T3 Drizzle schema for doc 06 (identity + games + social first), migrations, seed script. AC: `pnpm db:migrate && pnpm db:seed` works; schema tests.
- P0-T4 Auth.js (magic link + Google), session helpers, anon_id cookie. AC: login/logout e2e.
- P0-T5 PWA shell: manifest, icons, Serwist SW, bottom tab bar, safe-area CSS, mobile e2e profile in Playwright.

## Phase 1 — Play Engine (2 wks) — GATE: riskiest tech proven
- P1-T1 Play origin Worker (Cloudflare) + local equivalent (a second Next/Express server on another port; host `play.localhost`). Serves artifact by sha with CSP + injected SDK shim. AC: header tests.
- P1-T2 packages/sdk guest shim + GameHost (doc 03). AC: unit tests for protocol, handshake timeout, pause freezes rAF/timers/audio.
- P1-T3 Author the 8 template games + manifests. AC: each passes validator + smoke test.
- P1-T4 Validator (static rules) with fixtures of bad games. AC: >= 30 fixtures, each correct verdict.
- P1-T5 Smoke-test runner (Playwright) per doc 03 returning report + poster. AC: detects blank, crash, no-interactivity, low-fps fixtures.
- P1-T6 Feed UI v1 with seeded games: snap scroll, iframe pool, preload, poster overlay, events batching. AC: mobile e2e swipe through 20 games, <= 3 iframes alive, no memory growth (measure).
- P1-T7 SPIKE: scroll-vs-play gesture conflict (doc 12 #15). AC: written ADR + chosen pattern implemented.
- P1-T8 SPIKE: service worker on play origin caches artifacts offline. AC: airplane-mode play of previously seen game.
- P1-T9 Sandbox escape test suite: games attempting cookie/localStorage/fetch/top-nav/popup/parent access. AC: all blocked.

## Phase 2 — Social (2 wks)
- P2-T1 Like/save/collections/follow with optimistic UI. P2-T2 Comments sheet. P2-T3 Profile pages. P2-T4 Share page /g/[id] with OG poster. P2-T5 Notifications (in-app). P2-T6 Report flow. P2-T7 Events API + client batching + tables (doc 06 events). P2-T8 Heuristic feed v0 (trending+fresh+random, seen filter). AC each: API tests (401/403/400/200) + mobile e2e.

## Phase 3 — AI Studio (3 wks) — GATE: >85% first-pass playable on eval set
- P3-T1 LLM client layer (Vercel AI SDK), model router, cost tracking (`model_runs`). P3-T2 Prompt files + versioning. P3-T3 Job queue + `generation_jobs` + SSE with resume. P3-T4 Pipeline stages 1-6 (doc 04) incl. repair loop and search/replace patcher. P3-T5 Studio UI mobile-first (chat, preview, stepper, versions). P3-T6 Credits ledger + limits + kill switch. P3-T7 Metadata generation + publish flow + moderation gate. P3-T8 Remix flow. P3-T9 Eval harness `pnpm eval:gen` (50 prompts). P3-T10 Edit-by-chat with patches. AC: eval report committed; cost/game documented.

## Phase 4 — Recommendation v1 (2 wks)
- P4-T1 Embed worker (text + visual), `game_features`, code_summary LLM step, HNSW index. P4-T2 User taste vectors updater (cron/stream). P4-T3 Candidate generators (ANN, trending, social, exploration). P4-T4 Ranker v0 heuristic + MMR rerank + Redis session cache. P4-T5 Onboarding vibes. P4-T6 Impression logging with source/propensity. P4-T7 Offline replay evaluator + dashboard. AC: offline NDCG beats trending-only baseline by >= 10% on synthetic+real data; p95 feed API < 150ms.

## Phase 5 — Hardening & Launch (2 wks)
Moderation pipeline + admin queue, rate limits everywhere, Sentry, load test, Lighthouse mobile >= 90, real-device testing (iOS Safari, Android), ToS/privacy, DMCA flow, seed 100+ quality games, closed beta.

## Phase 6+ — Growth
CF item-item, LightGBM ranker + nightly training, A/B framework, push notifications, leaderboards/challenges, code editor, asset generation, monetization, creator analytics, Capacitor wrappers.

## Definition of Done (every task)
Typecheck + lint + tests pass; new code has tests; mobile screenshot for UI; docs updated if contract changed; no TODOs without an issue number; no secrets committed.
