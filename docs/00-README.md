# PlayLoop — Planning Docs

PlayLoop: a TikTok/Reels-style feed of short, playable games. Creators vibecode games by chatting with an AI inside the platform. Players scroll, play instantly, like, save, comment, and remix.

## Read order
1. 01-product-spec.md        — what we build, user flows, scope (MVP vs later)
2. 02-architecture.md        — stack, services, deployment, key decisions (ADRs)
3. 03-game-artifact-spec.md  — THE core contract: what a "game" is, sandbox, SDK
4. 04-ai-creation-pipeline.md— prompt -> game generation, validation, repair, remix
5. 05-recommendation.md      — feed ranking: embeddings + CF + bandit
6. 06-data-model.md          — Postgres schema (Drizzle-ready)
7. 07-api-spec.md            — routes/endpoints
8. 08-frontend-pwa.md        — feed player, studio, PWA, perf budgets
9. 09-security-moderation.md — sandbox threats, abuse, moderation, cost control
10. 10-roadmap-tasks.md      — phased, atomic tasks with acceptance criteria
11. 11-agent-handoff-rules.md— rules for the cheaper implementing agent
12. 12-mobile-first.md       — BINDING mobile-first (Reels-like) rules; wins on any conflict

MOBILE-FIRST: PlayLoop is a phone product first (installable PWA, full-screen vertical snap feed, thumb-zone controls, one-finger games, create-on-phone Studio). Desktop = centered 9:16 column. Read doc 12 before any UI work.

## Ten decisions that shape everything
1. Game = ONE self-contained HTML file (inline JS/CSS, assets as data-URIs or CDN refs on allowlist), <= 300 KB. No build step on the user side. Easy for LLMs to emit, easy to hash/fork/diff/embed.
2. Games run in a sandboxed iframe on a SEPARATE origin (play.<domain>), `sandbox="allow-scripts"` only, strict CSP. Never same-origin with the main app.
3. Games talk to the platform ONLY through a tiny postMessage SDK (`playloop.js`): lifecycle, input, score, storage, share.
4. Games are immutable versions. Edit/remix = new version/new fork with `parent_id` lineage.
5. AI generation is a PIPELINE (spec -> code -> static check -> headless smoke test -> auto-repair loop -> publish), not one LLM call. Unplayable games never reach the feed.
6. Feed = 3 stages: candidate generation (embeddings ANN + CF + trending + follows) -> ranker -> re-ranker (diversity, freshness, safety). Start heuristic, upgrade to learned.
7. Implicit signals (played >15s, replay, remix, time-to-first-input) beat explicit likes. Instrument from day 1.
8. Cold-start of NEW games uses content embeddings + an exploration budget (bandit), so good new games surface fast.
9. Postgres + pgvector first. No separate vector DB until >5M games.
10. Cost control is a first-class feature: per-user AI credits, model routing, caching, rate limits.

## Stack summary
Next.js 15 (App Router, TS) · Postgres + pgvector (Neon/Supabase) · Drizzle ORM · Redis (Upstash) · Cloudflare R2 (artifacts) + Cloudflare Worker/Pages for the play origin · Auth.js · Vercel AI SDK (multi-provider) · Inngest/BullMQ jobs · Playwright (smoke tests, worker container) · Tailwind + shadcn/ui · Serwist (PWA) · Vitest + Playwright e2e.
