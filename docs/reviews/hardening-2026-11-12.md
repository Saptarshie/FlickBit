# Hardening pass — 2026-11-12

Three independent read-only audits (API surface, data layer, client lifecycle)
were run against the tree at `698e592`, then every finding was reproduced or
reasoned from the code and fixed. This file records what was found, what was
done, and what is deliberately left.

## The incident that started it

A ten-minute generation ended with this in the studio chat:

```
Failed query: insert into "games" (...) values (...) params: ...
```

Cause: the session cookie came from a database that had been reset. `/studio`
rendered, the build ran to completion, and the insert died on
`games_creator_id_users_id_fk`. Two defects, not one: stale sessions were never
detected, and a finished build had no path back.

## What changed

### Sessions and recovery

- `resolveViewer()` proves the signed-in account still exists; `requireUser()`
  uses it, so **every** authenticated route answers `401 session_stale` at the
  door instead of failing inside a write.
- Publishing is its own idempotent step (`lib/publish.ts`, keyed by
  `(game, sha256)`).
- A failed publish keeps a marker and the artifact; `POST /api/studio/publish`
  finishes the job, and the studio offers **Retry publishing**.
- `humanizeDbError()` turns driver errors into one actionable sentence and keeps
  the SQL in the server log. `wrap()` and the studio catch use it, so no query
  text can reach a user.
- `app/global-error.tsx` covers a crash in the root layout.

### API surface

- `/internal/smoke` (headless Chromium over caller HTML) was reachable from
  anywhere the worker was, and the worker bound `0.0.0.0`. Now loopback-only,
  optionally token-checked, and bound to `127.0.0.1`.
- The worker had no error middleware: an oversized body produced an Express HTML
  stack trace. It now returns the JSON envelope (413 for size).
- `studio/generate` validates its body with zod (a non-uuid `gameId` used to
  reach Postgres as 22P02 and surface as a bare 500).
- `studio/upload`: `Content-Length` pre-check before buffering, magic-byte
  sniffing instead of the client-declared type, per-user quota, storage failures
  mapped to 507.
- `events`: unknown game ids are dropped instead of failing the whole batch on an
  FK; `props`/`source` are bounded; 256 KB body cap; `play_15s` counts once per
  identity per game per minute so play counts cannot be inflated.
- `games/[id]` and `.../source` refuse drafts, rejected and soft-deleted games.
- `studio/thread` answers 400 (not 500) for a bad `gameId`.
- Social writes are rate limited (comments 10/min, likes 60/min, saves 60/min,
  reports 5/h, scores 30/min) with `retry-after`.
- Scores must reference a version of *that* game and stay inside
  `±LEADERBOARD_MAX_SCORE`.
- Comments are capped at 300 per game, creator grids at 60.

### Data layer

- **Deletion was impossible**: `generation_jobs`, `chat_messages`, `scores` and
  `games` referenced parents with `ON DELETE no action`, so no game could be
  removed and no account purged. Migration `0003_hardening` sets `SET NULL` where
  history should survive and `CASCADE` where it should not.
- Indexes for the queries actually run: trigram search (where `pg_trgm` exists),
  published-at feed scan, unread notifications (partial), one-unread-per
  (user, type, actor, game), per-user scores, `events(ts)` and
  `events(game_id, ts)`, `game_stats_hourly(game_id, hour)`.
- The publish path is a single transaction: a game row can no longer exist
  without its version (it passed every candidate query and was then dropped by
  the hydration join — a silently missing card).
- Like / save / comment move the row and the counter together.
- `insertEvents` writes the batch in one statement instead of one round trip per
  event.
- `trending` reads a 72-hour window instead of all history, and the raw-event
  side starts where the rollup ends — a lagging rollup used to read as zero
  engagement. Verified: rolling up no longer double counts.
- The rollup defaults to the last 6 hours, not the epoch.
- `play15_count` / `remix_count` were never written; they are now derived from
  the rollup.
- `notify()` relies on the unique index instead of read-then-insert.

### Client

- The share page can no longer present a dead black frame: it waits for the
  guest's `ready`, times out after 10 s, and offers **Try again / More games**.
- The "Link copied" toast no longer writes into the frame-error state (its Retry
  destroyed a running game); cancelled shares no longer copy anyway.
- Like/save/follow surface non-401 failures and 429s instead of silently
  reverting.
- A failed feed prefetch says so, with a working Retry; an empty feed no longer
  offers "Retry".
- Keys are ignored while a dialog is open; the comments sheet closes on Escape,
  is `inert` when closed, announces `aria-modal`, keeps focus timers cleaned up,
  and reports post failures.
- The studio aborts its stream on unmount, revokes blob URLs, previews through
  the cache-busted artifact URL, and no longer leaves `saveDetails` unguarded.
- `error.tsx` shows a human sentence instead of a raw JS message.

## Deliberately left

- **PGlite vs real Postgres**: the dev database is one socket, so the app keeps
  one connection even under load. The production path now gets a pool
  (`PLAYLOOP_SINGLE_SOCKET=0`), but that path is unverified here — Docker is not
  available on this machine, so all verification runs against PGlite.
- **Focus trap in dialogs**: Escape, `aria-modal` and `inert`-when-closed are in;
  a full Tab-cycling trap is not. The sheet is one input and one button, and the
  platform's own focus order is acceptable there.
- **Cross-instance state**: the rate limiter and the upload quota are per
  process. A multi-instance deployment should move `takeRateLimit` to Redis; the
  call sites do not change.
- **Trending at 20k games**: bounded now, but the score is still computed per
  request over a 72-hour window. The next step is a materialised
  `games.trending_score` written by the rollup and indexed; not done here because
  it needs a backfill and a scheduled writer.
