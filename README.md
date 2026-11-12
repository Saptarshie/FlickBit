# PlayLoop

Scroll. Play. Remix. A Reels-style feed of AI-vibecoded mini games — mobile-first
PWA, self-contained HTML5 games, stateful vibecoding studio.

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

That is the whole setup. No Docker, no external database, no build step.

---

## 1. Requirements

| Thing | Version | Notes |
| --- | --- | --- |
| Node.js | **22 or newer** | `node --version` |
| pnpm | 9 or 10 | `corepack enable` then `corepack prepare pnpm@latest --activate` |
| Chromium for Playwright | any | Installed automatically by `pnpm install`; used by the runtime gate that plays each generated game before it publishes |
| Ollama *(optional)* | any | Only for embeddings (`embeddinggemma`). Without it games still publish, they just are not embedded. |
| An OpenAI-compatible LLM *(optional)* | — | Only for AI generation. Without it the studio uses the offline template provider. |

## 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set at least `AUTH_SECRET` (`openssl rand -base64 32`). Everything
else has a working local default.

| Variable | Default | What it does |
| --- | --- | --- |
| `AUTH_SECRET` | — | Auth.js signing secret. **Required.** |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/postgres` | The app's database. In dev this is the embedded PGlite server. |
| `DB_PORT` | `5432` | Port the embedded database listens on. |
| `APP_ORIGIN` | `http://localhost:3000` | Public origin of the app. |
| `PLAY_ORIGIN`, `NEXT_PUBLIC_PLAY_ORIGIN` | `http://localhost:3001` | Origin that serves game artifacts. Must be reachable from the browser. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | empty | Any OpenAI-compatible `/chat/completions` endpoint; enables real generation. |
| `OLLAMA_BASE_URL`, `EMBED_MODEL` | `http://127.0.0.1:11434`, `embeddinggemma` | Embeddings for recommendations. |
| `ARTIFACTS_DIR` | `apps/play-worker/artifacts` | Where game HTML is stored. |
| `PLAYLOOP_SMOKE` | unset | `0` disables the headless-browser gate (much faster, less safe). |
| `PLAYLOOP_SINGLE_SOCKET` | set by the scripts | `1` for the embedded PGlite database (one connection); `0` against a real Postgres, which gets a pool. `pnpm dev` / `pnpm start` set it. |
| `DATABASE_POOL_MAX` | `20` | Connection pool size when not in single-socket mode. |
| `PLAYLOOP_INTERNAL_TOKEN` | unset | Shared secret for the worker's `/internal/smoke` (loopback-only, and token-checked when set). |
| `HOST` | `::` | Interface the artifact worker binds. Dual-stack on purpose: browsers resolve `localhost` to `::1` first, so an IPv4-only bind makes every game frame fail. `/internal/smoke` is guarded independently (loopback + optional token). |
| `LEADERBOARD_MAX_SCORE` | `1000000` | Reject scores outside this magnitude. |
| `ROLLUP_WINDOW_HOURS` | `6` | How far back the stats rollup recomputes per run. |
| `PLAYLOOP_DB` | unset | `external` tells `pnpm start` not to start the embedded database. |
| `PLAYLOOP_TEMPLATES_DIR` | unset | Only if the seeded templates cannot be located automatically. |

Uploaded concept images go to `apps/play-worker/uploads/`; the database lives in
`.data/pglite/`.

## 3. Run it in development

```bash
pnpm dev
```

`scripts/dev.mjs` starts three processes and waits for each:

| Service | Port | What it is |
| --- | --- | --- |
| `scripts/dev-db.ts` | 5432 | PGlite (Postgres compiled to WASM) + pgvector served over the **real Postgres wire protocol**. Applies migrations, the events/stats DDL, seeds the 8 template games and publishes `packages/gamekit/templates` + `.artifacts/seeds/*` |
| `apps/web` | 3000 | Next.js 15 app (Turbopack): feed, studio, profiles, APIs |
| `apps/play-worker` | 3001 | Serves content-addressed artifacts (`/v/<sha256>.html`) under the sandbox CSP, plus `POST /internal/smoke` (the runtime gate) |

Open **http://localhost:3000**.

Useful dev facts:

- **Hot reload** — editing anything in `apps/web` or `packages/*` recompiles in place.
- **Restart clean** — Ctrl-C then `pnpm dev` again.
- **Reset the database** — stop the stack and delete `.data/pglite/`; the next
  `pnpm dev` rebuilds the schema and republishes the template + seed games.
- **Dev output directory** is `apps/web/.next-dev`, separate from the production
  build in `apps/web/.next`. You can run `pnpm build` **while** `pnpm dev` is
  running; neither touches the other.
- **Generate a seed game** while the stack is running (takes 2–5 min):

  ```bash
  pnpm gen:seed my-slug "a neon rhythm game with four lanes and combos"
  # restart pnpm dev (or the boot of the DB publishes .artifacts/seeds/*.html)
  ```

## 4. Run it in production mode (locally or on a server)

```bash
pnpm build     # production build -> apps/web/.next
pnpm start     # database (optional) + play-worker + next start
```

`pnpm start` (`scripts/start.mjs`):

1. refuses to start if there is no build (`pnpm build` first);
2. starts the embedded database **only** when `DATABASE_URL` points at this
   machine and nothing is listening on `DB_PORT` — set `PLAYLOOP_DB=external`
   to always use your own Postgres;
3. starts the play-worker on `:3001` and the production server on `:3000`;
4. prints the two URLs once both ports answer.

Open **http://localhost:3000**.

### Production on a real server

1. **Postgres with pgvector.** `pgvector` is required (recommendation vectors):

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

   Point `DATABASE_URL` at it and set `PLAYLOOP_DB=external`. Migrations run
   automatically on the first `pnpm start` via the embedded launcher only when it
   owns the database; for a fully external Postgres run them explicitly:

   ```bash
   pnpm --filter @playloop/db exec drizzle-kit migrate
   ```

2. **Two origins.** Games are served from `PLAY_ORIGIN` (the play-worker). It
   must be publicly reachable — the app renders `<iframe src="{PLAY_ORIGIN}/v/…">`.
   Put both behind TLS, e.g. `https://playloop.example.com` → :3000 and
   `https://play.playloop.example.com` → :3001, and set:

   ```bash
   APP_ORIGIN=https://playloop.example.com
   PLAY_ORIGIN=https://play.playloop.example.com
   NEXT_PUBLIC_PLAY_ORIGIN=https://play.playloop.example.com
   ```

   `NEXT_PUBLIC_*` is inlined at build time, so **set it before `pnpm build`**.

3. **Artifact storage.** `apps/play-worker/artifacts/` is a local directory. On a
   single box that is fine; for multiple instances mount a shared volume or sync
   the directory, otherwise an artifact generated on one node 404s on another.

4. **Reverse proxy.** Any proxy works as long as it forwards the `Host` header and
   does not rewrite `/api/*`. The web app sends `X-Frame-Options: DENY` for
   itself and `Content-Security-Policy: frame-ancestors {APP_ORIGIN}` for
   artifacts, so the play origin must match `APP_ORIGIN` exactly.

5. **Process supervision.** Run `pnpm start` under systemd/pm2/Docker. SIGTERM is
   handled and shuts all three children down; the embedded database is closed
   cleanly so it does not need recovery on the next boot.

6. **Keep `pnpm dev` off production.** `pnpm dev` seeds templates and republishes
   seed games on every boot.

Docker: `docker compose up -d` still starts the original Postgres/Redis/MinIO
stack described in `docs/02-architecture.md`; the app only requires Postgres.

## 4b. Stopping it

```bash
pnpm stop
```

`pnpm dev` and `pnpm start` run three processes behind pnpm/turbo wrappers, and
Next spawns workers of its own: closing the terminal can leave any of them
behind, and the next start then fails with `EADDRINUSE`. `pnpm stop` finds every
node process whose command line points into this repo, stops it, and waits until
ports 3000, 3001 and 5432 are actually free.

`pnpm start` also works from `apps/web`: it runs the same root runner, so the
database and the artifact worker come up with it.

## 5. Using the app

- **Feed** (`/`) — full-bleed vertical snap, one game per gesture (swipe, wheel,
  trackpad, ↑/↓). A card loads paused: tap it to hand touch to the game; `✕`,
  `Esc`, a wheel or scrolling away gives the feed control back. Right rail:
  like, comment, save, share, remix.
- **Create** (`/studio`) — describe a game and press **✨ Vibe**. A planner, an
  art director, a coder, a static gate, a runtime gate (a real browser plays the
  build) and a QA critic work in sequence; you watch each stage and the timings.
  Then **keep talking**: every later message edits the same game (v2, v3, …) and
  the thread survives a reload. Attach an image with 🖼 to use it as an art
  reference.
- **Remix** — from any card; the new game forks the source build and keeps
  provenance.
- **Accounts** — `/login`, handle + password (scrypt). A new handle creates an
  account; an existing handle must match its password. Handles are public (they
  are in every URL), so the password is the credential.
- Other routes: `/explore`, `/t/<tag>`, `/saved`, `/notifications`, `/u/<handle>`,
  `/g/<id>` (share page with OG tags).

Generation takes **3–12 minutes per turn** on a reasoning model — the UI shows
the stage, elapsed time and a progress bar, and the connection is a streaming
SSE that survives the wait.

## 6. Verify

```bash
pnpm typecheck              # 8 packages
pnpm test                   # sdk 37, gamekit 71, ai 21, db 12, recsys 16, worker 9, web 76
pnpm build                  # may run while pnpm dev is up (separate .next dirs)
pnpm smoke:load             # 30 concurrent feed requests, fails on any non-200
node scripts/e2e-studio.mjs # create -> follow-up -> thread, real LLM (~20 min)
node scripts/audit-runtime.mjs  # plays every artifact in Chromium
```

`docs/development_docs/verification.md` explains each layer, the current
pass/fail numbers, and how to recover a corrupted dev database.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE :::3000` | an earlier stack is still running | `pnpm stop`, then start again |
| `/api/feed` answers `503 db_unavailable` | the app was started without its database (`next start` on its own) | run `pnpm start` from the repo root (or `apps/web`, which does the same) |
| `ECONNREFUSED 127.0.0.1:5432` | nothing listens on the database port | start the stack with `pnpm start`; check `pnpm stop` did not leave a port taken |
| the database directory was damaged | the process was hard-killed mid-write | the next boot detects it in a child process, moves it to `.data/pglite.corrupt-<ts>` and restores the newest snapshot from `.data/backups/`; if none opens, it starts empty and reseeds |
| `pnpm build` fails with a locked `.next` | a production server is serving from that directory | `pnpm stop`, build, start again |
| a game ignores taps | a stale shim was cached | reload once; artifacts carry `?v=<shim>` and revalidate (see `docs/development_docs/verification.md`) |

### What the database repair does

PGlite's wasm module cannot be re-initialised in a process after it has aborted,
so an in-process retry was hopeless (the old code did exactly that and left the
stack dead). On boot a **separate** process opens the directory first; if that
fails, the directory is moved aside and the newest snapshot that opens is copied
back before this process touches anything. A snapshot is written on every boot,
so the worst case is the state at the last start. Prefer `pnpm stop` over killing
the process — it lets the database close its files.

## 8. Repo layout

```
apps/web             Next.js app (feed, studio, profiles, API routes)
apps/play-worker     artifact server: /v/:sha256.html + CSP + POST /internal/smoke
packages/sdk         host/guest postMessage protocol, guest shim (input, audio, canvas guards)
packages/gamekit     artifact validator, manifest, 8 template games, smoke harness
packages/db          Drizzle schema, migrations, seed, events + stats rollups
packages/recsys      candidates, ranking, MMR diversity
packages/ai          multi-agent pipeline: planner, art director, coder, QA, repair
scripts/             dev stack (dev.mjs, dev-db.ts), production runner (start.mjs),
                     e2e-studio.mjs, audit-runtime.mjs, load-smoke.mjs
docs/                product + architecture docs (start at docs/00-README.md)
```

## 9. Docs

- `docs/00…14` — product, design and roadmap decisions.
- `docs/development_docs/` — how it actually works: architecture, input pipeline,
  feed/scroll, generation pipeline, data model, debugging, testing, extending,
  **verification**.
- `docs/reviews/` — independent critic reports (feed/social, generation quality,
  platform/security) and the last runtime audit.
