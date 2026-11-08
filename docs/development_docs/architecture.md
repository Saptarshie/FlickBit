# Architecture

PlayLoop is a pnpm + Turborepo monorepo. One Next.js app serves both the UI and
the API; a tiny Express worker serves immutable game artifacts; Postgres (with
pgvector) holds everything else.

```
browser ──► apps/web (Next 15, RSC + route handlers)
              │  ├─ src/components/*        client screens (feed, studio, profile…)
              │  ├─ app/api/*/route.ts     JSON + SSE APIs
              │  └─ src/lib/*              db client, feed server action, helpers
              │
              ├──► Postgres + pgvector  (dev: PGlite served on :5432)
              │
              └──► apps/play-worker (:3001)  GET /v/<sha256>.html
                     injects packages/sdk SHIM_SOURCE into the artifact
                     and serves it under a strict CSP
                        │
                        └──► <iframe sandbox="allow-scripts">   ← the game
                               ▲ postMessage (v:1) ▼
```

## Packages

| Package | Responsibility | Key files |
| --- | --- | --- |
| `@playloop/db` | Drizzle schema, migrations, seed, rollups, CLI | `src/schema/*`, `src/seed.ts`, `src/rollup.ts`, `events.sql`, `stats.sql` |
| `@playloop/gamekit` | Artifact validation (security + manifest + completeness) and the 8 template games | `src/validate.ts`, `src/templates/*` |
| `@playloop/sdk` | Host (`GameHost`) + guest shim (`SHIM_SOURCE`) + wire protocol | `src/host.ts`, `src/shim-source.ts`, `src/protocol.ts` |
| `@playloop/recsys` | Candidate generation, ranking (MMR), cursor pagination | `src/candidates.ts`, `src/ranker.ts`, `src/feed.ts` |
| `@playloop/ai` | Planner, coder, repair loop, metadata, embeddings, LLM provider | `src/pipeline.ts`, `src/openai-provider.ts`, `src/generator.ts` |
| `apps/web` | Product surface + API | `app/`, `src/components/`, `src/lib/` |
| `apps/play-worker` | Artifact delivery with CSP + shim injection | `src/app.ts` |

Dependency direction is strictly downward: apps → packages. A package never
imports from an app. `@playloop/db` is the only thing that talks SQL.

## Runtime topology

`pnpm dev` runs `scripts/dev.mjs`, which:

1. starts `scripts/dev-db.ts` — PGlite (Postgres compiled to WASM) + pgvector,
   applying `packages/db/migrations`, `events.sql`, `stats.sql`, then seeding the
   8 template games into `apps/play-worker/artifacts/`;
2. waits for port 5432 to accept connections (so the web app never boots against
   a dead database);
3. runs `turbo run dev` (web on 3000, play-worker on 3001);
4. tears everything down on Ctrl-C.

PGlite speaks the real Postgres wire protocol through `@electric-sql/pglite-socket`,
so application code uses `postgres-js` + `drizzle-orm` unchanged. Production only
changes `DATABASE_URL`.

## Request paths

**Feed** — `app/page.tsx` (server) → `src/lib/feed.ts` (`'use server'`) →
`@playloop/recsys` `fetchFeedPage(db, …)` → cards. Failures return an empty page,
never invented content.

**Interactions** — client components call `app/api/games/[id]/{like,save,comments,report}`,
`app/api/users/[id]/follow`, `app/api/me/*`. All are wrapped by
`src/lib/api-helpers.ts` (`wrap`, `requireUser`, `jsonOk`, `jsonError`).

**Generation** — `POST /api/studio/generate` streams SSE:
`plan → generate → validate → repair (≤3) → metadata → write artifact → insert
game/version → publish → embed`. See [generation-pipeline.md](./generation-pipeline.md).

**Playback** — the card mounts `GameHost` around
`http://localhost:3001/v/<sha>.html`; the worker injects `SHIM_SOURCE` before
serving, and the host/guest exchange `ready → init → resume`, with input,
pause/resume, mute, storage and telemetry flowing through `postMessage`.

## Security model

- Artifacts are content-addressed (`sha256`), written by the server only, served
  with `Cache-Control: immutable`.
- CSP on artifacts: `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'
  blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'`.
  No network egress, no same-origin privilege.
- The host validates every inbound message with `parseGuestMessage`
  (version, `src`, allowed type, payload size) and ignores messages that do not
  come from its own frame.
- The guest validates inbound messages by **embedding origin**
  (`location.ancestorOrigins[0]`) — not by `event.source` identity, which is not
  stable across opaque-origin sandboxes. See [input-pipeline.md](./input-pipeline.md).

## Where state lives

| State | Location | Lifetime |
| --- | --- | --- |
| Games, versions, users, social graph, events | Postgres | durable |
| Hourly aggregates for ranking | `game_stats_hourly` | durable, written by `src/rollup.ts` |
| Feed/session UI state | Zustand store (`src/lib/feed-store.ts`) | tab lifetime |
| Server data cache | TanStack Query | tab lifetime |
| Artifact bytes | `apps/play-worker/artifacts/<sha>.html` | durable (git-ignored) |
| Dev database | `.data/pglite/` | until deleted |

## Scaling notes

The web process is stateless apart from the `postgres-js` pool (memoised on
`globalThis` to survive HMR). Horizontal scaling needs only: shared Postgres,
shared object storage for artifacts, and the same `PLAY_ORIGIN`. Recommendations
are computed per request today; the candidate queries are already bounded and
index-backed (`idx_events_game_ts`, `game_stats_hourly` PK) so a results cache in
front of `fetchFeedPage` is a drop-in later.
