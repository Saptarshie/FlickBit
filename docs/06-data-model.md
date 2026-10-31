# 06 — Data Model (Postgres + pgvector, Drizzle)

Conventions: ids = uuid v7 (`uuid` default `gen_random_uuid()` acceptable), `created_at timestamptz default now()`, soft delete via `deleted_at`. Enable extensions: `vector`, `pg_trgm`.

## Identity
```
users(id, handle unique citext, display_name, avatar_url, bio, email unique, email_verified_at,
      role enum[user,mod,admin], age_gate bool, onboarding_vibes text[], created_at, deleted_at)
accounts / sessions / verification_tokens   -- Auth.js adapter tables
follows(follower_id, followee_id, created_at, PK(follower_id, followee_id))
blocks(user_id, blocked_user_id, created_at)
```

## Games
```
games(id, creator_id→users, title, description, tags text[], status enum[draft,processing,published,unlisted,removed],
      published_version_id→game_versions, forked_from_game_id→games null, forked_from_version_id null,
      moderation enum[pending,approved,rejected,review], orientation, controls,
      counts: like_count, save_count, comment_count, remix_count, play_count, play15_count (denormalised, updated by worker),
      published_at, created_at, updated_at, deleted_at)
  idx: (status, published_at desc), (creator_id), GIN(tags), trigram(title)

game_versions(id, game_id, parent_version_id null, version_no int, artifact_sha256, artifact_bytes int,
      artifact_key text,   -- R2 key, e.g. artifacts/<sha>.html
      poster_key, preview_key null, manifest jsonb, validate_report jsonb, test_report jsonb,
      created_by enum[ai,user], gen_job_id null, created_at)
  unique(game_id, version_no)

game_features(game_version_id PK, code_summary jsonb, description_text text, frame_captions text[],
      text_vec vector(1024), visual_vec vector(768), content_vec vector(1024),
      quality jsonb {fps, ttfi_ms, interactivity, size, repairs}, quality_score real, embedded_at, model_versions jsonb)
  idx: HNSW(content_vec vector_cosine_ops) WHERE moderation approved (use partial via join table or a materialised `feed_eligible` bool column on game_features)

game_stats_hourly(game_id, hour, impressions, plays, plays15, likes, saves, remixes, comments, skips_fast)  -- rollup for trending
```

## Social
```
likes(user_id, game_id, created_at, PK(user_id, game_id))
saves(user_id, game_id, collection_id null, created_at, PK(user_id, game_id))
collections(id, user_id, name, is_private)
comments(id, game_id, user_id, parent_id null, body text(<=500), like_count, created_at, deleted_at)  idx(game_id, created_at)
comment_likes(user_id, comment_id)
notifications(id, user_id, type enum[like,comment,reply,follow,remix,system], actor_id, game_id null, data jsonb, read_at, created_at)
scores(id, game_id, version_id, user_id null, score numeric, meta jsonb, created_at)  idx(game_id, score desc)
game_storage(user_id, game_id, key, value jsonb, updated_at, PK(user_id, game_id, key))   -- <=16KB per row, 64 keys max
reports(id, reporter_id, target_type enum[game,comment,user], target_id, reason, details, status, created_at, resolved_by)
```

## AI creation
```
generation_jobs(id, user_id, game_id null, kind enum[create,edit,remix_edit,polish], prompt text, base_version_id null,
      status enum[queued,running,succeeded,failed,canceled], stage text, attempts int, error jsonb,
      result_version_id null, cost_usd numeric, tokens_in, tokens_out, prompt_versions jsonb, created_at, finished_at)
gen_events(job_id, seq int, type, payload jsonb, created_at, PK(job_id, seq))     -- for SSE resume
chat_messages(id, game_id, user_id, role enum[user,assistant,system], content text, version_id null, created_at)
model_runs(id, job_id, stage, model, tokens_in, tokens_out, cost_usd, latency_ms, ok bool, created_at)
credit_ledger(id, user_id, delta int, reason enum[daily_grant,generate,edit,refund,purchase,admin], job_id null, created_at)  -- balance = SUM; cache in Redis
```

## Events (append-only; partition by month)
```
events(id bigserial, ts timestamptz, user_id null, anon_id text, session_id text, type text,
       game_id null, version_id null, position int null, source text null, propensity real null,
       model_version text null, props jsonb, device jsonb)
  idx(user_id, ts desc), idx(game_id, ts desc); partition BY RANGE(ts)
user_taste(user_id PK, long_vec vector(1024), short_vec vector(1024), genre_affinity jsonb, updated_at)
seen_games -- Redis set per user (zset w/ ts), not Postgres
experiments(id, name, variants jsonb, active) ; experiment_assignments(user_key, exp_id, variant)
```

## Rules
- Counts are eventually consistent; never trust for money/authz.
- `published_version_id` swap is atomic (single UPDATE) and invalidates feed caches by `game_id`.
- Delete user = anonymise events (`user_id` null), delete PII, keep games only if user opts (else status removed).
- Migrations only forward via drizzle-kit; seed script `pnpm db:seed` inserts templates as published games by a `@playloop` account.
