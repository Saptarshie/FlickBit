-- Append-only event log, range-partitioned by month (drizzle-kit cannot express PARTITION BY).
-- Apply with: pnpm --filter @playloop/db db:events
-- Not part of drizzle-kit migrations on purpose.

CREATE TABLE IF NOT EXISTS events (
  id            bigserial,
  ts            timestamptz NOT NULL DEFAULT now(),
  user_id       uuid,
  anon_id       text,
  session_id    text,
  type          text NOT NULL,
  game_id       uuid,
  version_id    uuid,
  position      integer,
  source        text,
  propensity    real,
  model_version text,
  props         jsonb
) PARTITION BY RANGE (ts);

CREATE INDEX IF NOT EXISTS events_user_ts_idx ON events (user_id, ts);
CREATE INDEX IF NOT EXISTS events_game_ts_idx ON events (game_id, ts);
CREATE INDEX IF NOT EXISTS events_type_ts_idx ON events (type, ts);

-- Partitions for the first few months. Add more monthly (or let a cron create them).
DO $$
DECLARE
  m int;
  start_at timestamptz;
  end_at timestamptz;
  name text;
BEGIN
  FOR m IN 0..5 LOOP
    start_at := date_trunc('month', now()) + (m || ' month')::interval;
    end_at   := start_at + '1 month'::interval;
    name     := 'events_' || to_char(start_at, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      name, start_at, end_at
    );
  END LOOP;
END $$;

-- Safety net: without a DEFAULT partition any event whose ts falls outside the
-- pre-created months fails the whole insert ("no partition of relation events
-- found for row"), so a clock skew or a late backfill loses data.
CREATE TABLE IF NOT EXISTS events_default PARTITION OF events DEFAULT;

-- Read paths: the current-hour slice for trending, and per-game history.
-- Created here because this file owns the partitioned table.
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);
CREATE INDEX IF NOT EXISTS events_game_ts_idx ON events (game_id, ts);
