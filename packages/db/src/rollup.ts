import { sql } from 'drizzle-orm';

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/** A rollup window [from, to) in event time (`events.ts`). */
export type RollupWindow = {
  from?: Date;
  to?: Date;
};

export type GameStatRow = {
  gameId: string;
  hour: Date;
  impressions: number;
  plays: number;
  plays15: number;
  likes: number;
  saves: number;
  remixes: number;
  comments: number;
  skipsFast: number;
};

/**
 * Default window: the last few hours.
 *
 * The old default started at the epoch, so every scheduled run re-aggregated the
 * entire event history. Buckets older than the window are already correct —
 * events are appended, never back-dated beyond the window in practice.
 */
const DEFAULT_WINDOW_HOURS = Number(process.env.ROLLUP_WINDOW_HOURS ?? 6);
const DEFAULT_FROM = () => new Date(Date.now() - DEFAULT_WINDOW_HOURS * 3600_000);
const DEFAULT_TO = () => new Date(Date.now() + 3600_000);

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return (rows ?? []) as Record<string, unknown>[];
}

/**
 * Recompute `game_stats_hourly` buckets for events in [from, to) from the
 * event log. Idempotent: each affected (game_id, hour) bucket is REPLACED with
 * the freshly computed counts (ON CONFLICT DO UPDATE), so re-running a window
 * never double-counts and newly arrived events are picked up on the next run.
 *
 * Events without a game_id are ignored. Hours are UTC hour buckets.
 */
export async function rollupGameStats(exec: Exec, window: RollupWindow = {}): Promise<number> {
  const from = window.from ?? DEFAULT_FROM();
  const to = window.to ?? DEFAULT_TO();

  const result = await exec.execute(sql`
    INSERT INTO game_stats_hourly
      (game_id, hour, impressions, plays, plays15, likes, saves, remixes, comments, skips_fast)
    SELECT
      e.game_id,
      to_timestamp(FLOOR(EXTRACT(epoch FROM e.ts) / 3600) * 3600) AS hour,
      COUNT(*) FILTER (WHERE e.type = 'impression'),
      COUNT(*) FILTER (WHERE e.type = 'play_start'),
      COUNT(*) FILTER (WHERE e.type = 'play_15s'),
      COUNT(*) FILTER (WHERE e.type = 'like'),
      COUNT(*) FILTER (WHERE e.type = 'save'),
      COUNT(*) FILTER (WHERE e.type = 'remix'),
      COUNT(*) FILTER (WHERE e.type = 'comment'),
      COUNT(*) FILTER (WHERE e.type = 'skip_fast')
    FROM events e
    WHERE e.game_id IS NOT NULL
      AND e.ts >= ${from}::timestamptz
      AND e.ts < ${to}::timestamptz
    GROUP BY e.game_id, hour
    ON CONFLICT (game_id, hour) DO UPDATE SET
      impressions = EXCLUDED.impressions,
      plays       = EXCLUDED.plays,
      plays15     = EXCLUDED.plays15,
      likes       = EXCLUDED.likes,
      saves       = EXCLUDED.saves,
      remixes     = EXCLUDED.remixes,
      comments    = EXCLUDED.comments,
      skips_fast  = EXCLUDED.skips_fast
    RETURNING game_id
  `);

  const touched = rowsOf(result).length;

  // `games.play15_count` and `remix_count` are read by cards and by the trending
  // weights, but nothing ever wrote them — every game showed 0. Derive them from
  // the rollup (the single source of truth for engagement).
  await exec.execute(sql`
    UPDATE games g
    SET play15_count = s.plays15,
        remix_count  = s.remixes
    FROM (
      SELECT game_id, SUM(plays15)::int AS plays15, SUM(remixes)::int AS remixes
      FROM game_stats_hourly
      GROUP BY game_id
    ) s
    WHERE s.game_id = g.id
      AND (g.play15_count <> s.plays15 OR g.remix_count <> s.remixes)
  `);

  return touched;
}

/** Read rolled-up hourly stats for one game, oldest hour first. */
export async function getGameStats(exec: Exec, gameId: string): Promise<GameStatRow[]> {
  const result = await exec.execute(sql`
    SELECT
      game_id AS "gameId",
      hour,
      impressions,
      plays,
      plays15,
      likes,
      saves,
      remixes,
      comments,
      skips_fast AS "skipsFast"
    FROM game_stats_hourly
    WHERE game_id = ${gameId}::uuid
    ORDER BY hour ASC
  `);

  return rowsOf(result).map((r) => ({
    gameId: String(r.gameId),
    hour: r.hour instanceof Date ? r.hour : new Date(String(r.hour)),
    impressions: Number(r.impressions),
    plays: Number(r.plays),
    plays15: Number(r.plays15),
    likes: Number(r.likes),
    saves: Number(r.saves),
    remixes: Number(r.remixes),
    comments: Number(r.comments),
    skipsFast: Number(r.skipsFast),
  }));
}
