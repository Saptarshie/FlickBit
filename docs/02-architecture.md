# 02 — Architecture

## Diagram (logical)
```
Browser/PWA (Next.js app)  ──►  Next.js server (app.<domain>)  ──►  Postgres+pgvector, Redis
   │  iframe (sandboxed)            │ route handlers / server actions        │
   ▼                                ├─► Job queue (Inngest) ─► Workers:      │
play.<domain>  (CF Worker)          │      gen-worker (LLM pipeline)         │
   │ serves immutable artifacts     │      test-worker (Playwright)          │
   ▼                                │      embed-worker (embeddings)         │
R2 bucket (artifacts, thumbs)       │      moderation-worker                 │
                                    └─► LLM providers via Vercel AI SDK
Recsys: feature store in Postgres/Redis; offline training job (nightly) -> model/weights in R2
```

## Repo layout (monorepo, pnpm + turborepo)
```
apps/web            Next.js app (UI + API routes)
apps/play-worker    Cloudflare Worker serving artifacts on play origin
apps/workers        Node workers: gen, test (Playwright), embed, moderate
packages/db         Drizzle schema + migrations + queries
packages/sdk        playloop.js game SDK (host + guest halves) + types
packages/gamekit    Prompt templates, system prompts, validators, templates
packages/recsys     Candidate gen, ranker, reranker, offline training scripts
packages/ui         shared components
docs/
```

## Key decisions (ADRs)
ADR-1 Next.js monolith for app+API. Why: single deploy, SSR for SEO share pages, fast for cheap agent. Heavy/long work goes to queue workers, never in request path.
ADR-2 Separate play origin. Why: JS from strangers must not share cookies/localStorage/origin with the app. Also lets CDN cache artifacts with `immutable`.
ADR-3 Single-file HTML artifacts. Why: LLM-friendly, forkable, hashable (sha256 = id of content), no bundler, trivial CSP.
ADR-4 Postgres + pgvector (HNSW index, cosine). Why: one DB, transactional with metadata filters (safe/published). Revisit at scale.
ADR-5 Vercel AI SDK with provider abstraction + model router. Why: swap DeepSeek/Claude/Gemini by task and price.
ADR-6 Playwright smoke test in a container worker (not serverless). Why: needs Chromium, 5-20s runtime.
ADR-7 Event log first. Every interaction is an append-only `events` row (batched client side). Why: recsys training data; cannot be recovered retroactively.
ADR-8 Immutable versions: `game_versions` rows point to artifact hash in R2; `games` points at `published_version_id`.

## Environments
local (docker-compose: postgres+pgvector, redis, minio, mailpit) · preview (per PR) · prod.

## Env vars (documented in .env.example)
DATABASE_URL, REDIS_URL, R2_*, PLAY_ORIGIN, APP_ORIGIN, AUTH_SECRET, GOOGLE_*, LLM_* keys (OPENROUTER_API_KEY or per provider), EMBEDDING_MODEL, INNGEST_*, PLAY_SIGNING_SECRET.

## Artifact serving flow
1. Feed API returns `{gameId, versionId, artifactUrl: https://play.<domain>/v/<sha256>.html, posterUrl}`.
2. Client creates `<iframe sandbox="allow-scripts" src=artifactUrl allow="autoplay; fullscreen; gamepad">`.
3. Worker returns HTML with headers: CSP (doc 03), `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`.
4. SDK handshake via postMessage (doc 03).

## Observability
Sentry (web+workers), structured logs (pino), PostHog or own events table for product analytics, metrics on gen success rate, smoke-test fail reasons, LLM cost per generation, feed latency.

## Scale notes
Feed API p95 < 150ms: precompute per-user candidate lists in Redis (refresh every few minutes/on session start), rank at request time on ~200 candidates.
