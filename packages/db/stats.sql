-- Hourly engagement rollup powering the trending candidates and the offline
-- replay evaluator (docs/05 + docs/06: game_stats_hourly).
-- Apply with: pnpm --filter @playloop/db db:stats
-- Not part of drizzle-kit migrations on purpose (same as events.sql).

CREATE TABLE IF NOT EXISTS game_stats_hourly (
  game_id     uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  hour        timestamptz NOT NULL,
  impressions integer NOT NULL DEFAULT 0,
  plays       integer NOT NULL DEFAULT 0,
  plays15     integer NOT NULL DEFAULT 0,
  likes       integer NOT NULL DEFAULT 0,
  saves       integer NOT NULL DEFAULT 0,
  remixes     integer NOT NULL DEFAULT 0,
  comments    integer NOT NULL DEFAULT 0,
  skips_fast  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, hour)
);

CREATE INDEX IF NOT EXISTS game_stats_hourly_hour_idx ON game_stats_hourly (hour);
