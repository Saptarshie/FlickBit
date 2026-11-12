-- Hardening migration (0003).
--
-- Two classes of defect, both found by auditing the live tree:
--   1. delete paths were impossible: generation_jobs/chats/scores referenced
--      rows with ON DELETE no action, so a game could never be removed and an
--      account could never be purged (no takedown path at all).
--   2. the hot read paths had no usable index: an ILIKE search, a tag filter,
--      unread counts and a per-user score list were all sequential scans.

-- ---------------------------------------------------------------------------
-- 1. make deletion possible without losing history
-- ---------------------------------------------------------------------------

-- A job outlives its game (kept for billing/debugging); the reference goes away.
ALTER TABLE "generation_jobs" DROP CONSTRAINT IF EXISTS "generation_jobs_game_id_games_id_fk";
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_game_id_games_id_fk"
  FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Chat/message history belongs to the game; deleting the game removes it.
-- (annotated in chat_messages_game_id above: cascade already)

-- A score points at the version it was played on; deleting that version keeps
-- the score, it just loses the exact build.
ALTER TABLE "scores" DROP CONSTRAINT IF EXISTS "scores_version_id_game_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_version_id_game_versions_id_fk"
  FOREIGN KEY ("version_id") REFERENCES "public"."game_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS "chat_messages_version_id_game_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_version_id_game_versions_id_fk"
  FOREIGN KEY ("version_id") REFERENCES "public"."game_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Deleting an account now takes its games (and everything cascading from them).
ALTER TABLE "games" DROP CONSTRAINT IF EXISTS "games_creator_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_creator_id_users_id_fk"
  FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "games" DROP CONSTRAINT IF EXISTS "games_published_version_id_game_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_published_version_id_game_versions_id_fk"
  FOREIGN KEY ("published_version_id") REFERENCES "public"."game_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- A remix without its parent is still a game.
ALTER TABLE "games" DROP CONSTRAINT IF EXISTS "games_forked_from_game_id_games_id_fk";
--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_forked_from_game_id_games_id_fk"
  FOREIGN KEY ("forked_from_game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generation_jobs" DROP CONSTRAINT IF EXISTS "generation_jobs_base_version_id_game_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_base_version_id_game_versions_id_fk"
  FOREIGN KEY ("base_version_id") REFERENCES "public"."game_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generation_jobs" DROP CONSTRAINT IF EXISTS "generation_jobs_result_version_id_game_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_result_version_id_game_versions_id_fk"
  FOREIGN KEY ("result_version_id") REFERENCES "public"."game_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 2. indexes for the queries the app actually runs
-- ---------------------------------------------------------------------------

-- Feed candidates: published games newest-first.
CREATE INDEX IF NOT EXISTS "games_published_idx" ON "games" ("published_at" DESC)
  WHERE "status" = 'published' AND "deleted_at" IS NULL;
--> statement-breakpoint
-- Search: ILIKE '%q%' cannot use a btree; a trigram GIN can.
-- Optional: the dev database (PGlite) ships without pg_trgm. Production gets
-- the index; anywhere else the query still works, just as a scan.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable; search falls back to a sequential scan';
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "games_title_trgm_idx" ON "games" USING gin ("title" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "games_description_trgm_idx" ON "games" USING gin ("description" gin_trgm_ops);
  END IF;
END $$;
--> statement-breakpoint
-- (events indexes live in events.sql: that file owns the partitioned table and
-- runs after migrations, so an index here would be created before the table.)
-- Unread badge is loaded with the app shell; answer it from a partial index.
CREATE INDEX IF NOT EXISTS "notifications_unread_idx" ON "notifications" ("user_id")
  WHERE "read_at" IS NULL;
--> statement-breakpoint
-- One unread notification per (user, type, actor, game): the notifier reads
-- before it inserts, and two concurrent likes used to create duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_unread_uq"
  ON "notifications" ("user_id", "type", "actor_id", "game_id")
  WHERE "read_at" IS NULL;
--> statement-breakpoint
-- A player's own scores for one game.
CREATE INDEX IF NOT EXISTS "scores_game_user_idx" ON "scores" ("game_id", "user_id", "created_at" DESC);
--> statement-breakpoint
-- (game_stats_hourly's index lives in stats.sql, which creates that table.)
--> statement-breakpoint