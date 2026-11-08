# PlayLoop

Scroll. Play. Remix. A Reels-style feed of AI-vibecoded mini games (mobile-first PWA).

## Run it (one command)

```bash
pnpm install      # once
pnpm dev
```

Then open **http://localhost:3000**.

`pnpm dev` starts everything you need:

| Service | Port | What it is |
| --- | --- | --- |
| `scripts/dev-db.ts` | 5432 | PGlite (Postgres in WASM) + pgvector served over the Postgres wire protocol. Runs migrations, the events/stats DDL, and seeds the 8 template games. **No Docker needed.** |
| `apps/web` | 3000 | Next.js 15 app: feed, studio, profiles, share pages, APIs |
| `apps/play-worker` | 3001 | Serves content-addressed game artifacts (`/v/<sha256>.html`) inside the sandbox CSP |

Data persists in `.data/pglite/` (delete it to start fresh). Artifacts live in
`apps/play-worker/artifacts/`.

### Configuration (`.env` at the repo root)

| Variable | Used by | Notes |
| --- | --- | --- |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | studio generation | Any OpenAI-compatible `/chat/completions` endpoint. Without these the studio falls back to the offline template provider. |
| `OLLAMA_BASE_URL`, `EMBED_MODEL` | embeddings | Defaults to `http://127.0.0.1:11434` and `embeddinggemma`. `ollama pull embeddinggemma` once; if Ollama is down the game still publishes, it is just not embedded. |
| `DATABASE_URL` | web | Points at the dev PGlite server by default; in production point it at real Postgres with the `vector` extension. |
| `PLAY_ORIGIN` / `NEXT_PUBLIC_PLAY_ORIGIN` | feed cards | Origin the game iframes load from (`http://localhost:3001` in dev). |
| `ARTIFACTS_DIR` | studio + play-worker | Where generated artifacts are written (default `apps/play-worker/artifacts`). |
| `AUTH_SECRET` | NextAuth | Dev value is fine locally. |

## What works today

- **Feed** — DB-backed recommendations (`@playloop/recsys`: trending / fresh / social / explore → ranker → MMR tag diversity), full-bleed vertical snap that scrolls both ways (touch, wheel, keyboard), one card per gesture.
- **Account** — passwordless "pick a handle" sign-in (`/login`); likes, saves, comments and follows are stored against that user.
- **Social** — like/unlike, save/unsave, comments sheet, share (Web Share + copy link + `/g/<id>` OG page), follow/unfollow, report.
- **Profiles** — `/u/<handle>` with follower/following counts and a playable game grid; your own profile offers Create and Saved.
- **Discovery** — `/explore` search across titles, tags and creators, trending tag chips, `/t/<tag>`, `/saved`, `/notifications` with an unread badge.
- **Vibecoding** — `/studio`: describe a game, the AI planner picks an archetype, the coder writes a self-contained HTML artifact, the validator (sandbox security + manifest + completeness) gates it, and it is content-addressed, published and immediately playable in the feed.
- **Remix** — `/studio?remix=<gameId>` loads the source artifact and generates a variant, with provenance shown on the card.
- **Social** — likes, saves, comments API, follows, creator profiles (`/u/<handle>`), share pages (`/g/<id>`) with OG metadata.
- **Event pipeline** — partitioned event log, hourly rollups (`game_stats_hourly`) feeding trending; CLI: `pnpm --filter @playloop/db run db:rollup`.
- **Sandbox** — `sandbox="allow-scripts"` iframe (no same-origin), strict CSP, `connect-src 'none'`, postMessage-only SDK.

## Verify

```bash
pnpm typecheck
pnpm test          # serialized: PGlite + Chromium suites
pnpm build
```

Per package (faster): `pnpm --filter @playloop/gamekit run test`, etc.

## Repo layout

```
apps/web            Next.js app (feed, studio, profiles, API routes)
apps/play-worker    artifact server (Express): /v/:sha256.html + CSP
packages/sdk        host/guest postMessage protocol + guest shim
packages/gamekit    artifact validator, manifest extraction, 8 template games
packages/db         Drizzle schema, migrations, seed, events + stats rollups
packages/recsys     candidate generation, ranking, MMR diversity
packages/ai         generation pipeline (planner → coder → validate/repair → metadata), LLM + embedding clients
scripts/            dev stack (dev.mjs, dev-db.ts)
docs/               product + architecture docs (start at docs/00-README.md)
```

## Notes

- Docker is optional locally — `docker compose up -d` still works if you prefer
  the real Postgres/Redis/MinIO stack described in `docs/02-architecture.md`.
- The dev database is single-node PGlite: ideal for local development and tests,
  not for production traffic.
- Implementing agents: read `docs/11-agent-handoff-rules.md` and `docs/12-mobile-first.md` first.


