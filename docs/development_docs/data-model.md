# Data model

Schema: `packages/db/src/schema/*.ts` → Drizzle → `packages/db/migrations/*.sql`.
Two hand-written DDL files sit outside the migration: `events.sql` (partitioned
event log) and `stats.sql` (hourly rollups).

## Tables

| Table | Purpose | Notes |
| --- | --- | --- |
| `users` | identity | `id uuid`, `handle` (unique, lowercase), `display_name`, `avatar_url`, `bio` |
| `sessions`, `accounts`, `verification_tokens` | Auth.js adapter | not used by the handle provider, kept for Google/email |
| `games` | one row per game | `creator_id`, `title`, `description`, `tags text[]`, `status (draft|published|unlisted)`, `moderation`, `published_version_id`, `forked_from_game_id`, `deleted_at` |
| `game_versions` | immutable artifacts | `artifact_sha256` (unique content address), `artifact_bytes`, `artifact_key`, `manifest jsonb`, `version_no`, `created_by` |
| `game_features` | vector index | `game_version_id` (PK), `embedding vector`, `model` |
| `likes`, `saves`, `comments`, `follows`, `reports`, `notifications` | social graph | see `social.ts` |
| `events` | append-only telemetry | partitioned by month, `type in (impressions, plays, plays15, likes, saves, remixes, comments, skips_fast)` |
| `game_stats_hourly` | rollups for ranking | PK `(game_id, hour)`, counters mirroring event types |
| `user_taste`, `experiments` | personalisation scaffolding | not wired yet |

## Invariants

- **Content addressing:** a version's `artifact_sha256` is the sha256 of the bytes
  in `apps/play-worker/artifacts/<sha>.html`. Two games can share bytes; the
  artifact is written once (idempotent write).
- **Publish ordering:** insert `games` with `published_version_id = null` →
  insert `game_versions` → update `games.published_version_id`. Doing it in one
  statement violates the circular FK.
- **Soft delete:** `games.deleted_at` — every read path must filter
  `isNull(games.deletedAt)`.
- **`follows` columns are `follower_id` / `followee_id`** (not `following_id`).
- **`game_features` keys on `game_version_id`**, not `game_id`; join
  `gf.game_version_id = g.published_version_id`.

## Rollups

`packages/db/src/rollup.ts`

```ts
rollupGameStats(db, { hours?: number })   // UTC hour buckets, ON CONFLICT DO UPDATE
getGameStats(db, gameId, { hours?: number })
```

Trending/explore read **completed hours** from `game_stats_hourly` and the
**current hour** from raw `events`, split at
`to_timestamp(FLOOR(EXTRACT(epoch FROM now())/3600)*3600)` — timezone independent,
no double counting. Apply `packages/db/stats.sql` in any test that exercises the
candidate queries.

## Score

```
trendingScore = (plays15 + 3*likes + 5*remixes) / (impressions + 20)
```

Bayesian prior of 20 impressions so a single play cannot top the chart. Freshness
uses a 72-hour half-life; ranking ties break on `gameId.localeCompare` for
deterministic output (tests depend on it).

## Feed composition

`packages/recsys/src/candidates.ts` mixes four sources — trending, fresh, social
(followed creators), explore (vector neighbours) — then `ranker.ts` sorts and
`mmrRerank` enforces at most 2 consecutive cards from the same primary tag.
`feed.ts` hydrates cards and encodes the cursor.

## Adding a column or table

1. Edit the TS schema.
2. `pnpm --filter @playloop/db exec drizzle-kit generate --name <change>`.
3. Hand-edit the SQL only for things Drizzle cannot express (extensions,
   partitions) — and note it in this file.
4. Update `seed.ts` if the table is seeded.
5. Add a test in `packages/db/src/*.test.ts` that runs the migration on PGlite.

## Hardening notes (migration 0003)

- **Deletion is possible now.** `games.creator_id` cascades, `games.published_version_id`,
  `games.forked_from_game_id`, `generation_jobs.game_id`, `generation_jobs.base_version_id`,
  `generation_jobs.result_version_id`, `scores.version_id` and
  `chat_messages.version_id` are `SET NULL`. Before this, a single `generation_jobs`
  row made every studio game undeletable and no account could be purged.
- **Indexes match the queries.** Trigram GIN on title/description (only where
  `pg_trgm` exists — PGlite has no such extension, so dev falls back to a scan),
  `games(published_at)` for published rows, partial unread index on
  `notifications`, a unique unread index per `(user, type, actor, game)`,
  `scores(game_id, user_id, created_at)`, `events(ts)` / `events(game_id, ts)` and
  `game_stats_hourly(game_id, hour)`.
- **Counters are derived, not guessed.** `play15_count` and `remix_count` are
  written by `rollupGameStats` from `game_stats_hourly`; `like_count`,
  `save_count` and `comment_count` move inside the same transaction as the row
  they count.
