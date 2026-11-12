import { sql } from 'drizzle-orm';
import type { Candidate } from './types';

export type CandidateOptions = {
  seenGameIds?: Set<string> | string[];
};

function toSeenSet(seen?: Set<string> | string[]): Set<string> {
  if (!seen) return new Set();
  return seen instanceof Set ? seen : new Set(seen);
}

/**
 * Trending candidate generator:
 * smoothed engagement rate: (plays15 + 3*likes + 5*remixes) / (impressions + 20)
 * Uses a Bayesian prior of 20 impressions so brand new games are not unfairly penalized.
 *
 * Hybrid event sourcing: completed hour buckets come from `game_stats_hourly`
 * (the rollup), the current partial hour reads raw `events`. The split happens
 * at the same UTC hour boundary the rollup truncates with (epoch-floor math,
 * TZ-independent), so the two sides never double-count or drop an event.
 */
export async function trending(
  db: any,
  limit: number = 50,
  opts: CandidateOptions = {}
): Promise<Candidate[]> {
  const seen = toSeenSet(opts.seenGameIds);
  // Bound the scan: the seen-filter runs after the query, so ask for a little
  // more than we need instead of sorting every published game in the database.
  const fetchLimit = Math.min(limit + seen.size + 10, 500);

  const query = sql`
    WITH h AS (SELECT to_timestamp(FLOOR(EXTRACT(epoch FROM now()) / 3600) * 3600) AS t),
    rolled AS (
      SELECT s.game_id,
        SUM(s.impressions) AS impressions,
        SUM(s.plays15) AS plays15,
        SUM(s.likes) AS likes,
        SUM(s.remixes) AS remixes
      FROM game_stats_hourly s, h
      WHERE s.hour < h.t
      GROUP BY s.game_id
    ),
    live AS (
      SELECT e.game_id,
        COUNT(*) FILTER (WHERE e.type = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE e.type = 'play_15s') AS plays15,
        COUNT(*) FILTER (WHERE e.type = 'like') AS likes,
        COUNT(*) FILTER (WHERE e.type = 'remix') AS remixes
      FROM events e, h
      WHERE e.ts >= h.t AND e.game_id IS NOT NULL
      GROUP BY e.game_id
    )
    SELECT
      g.id AS "gameId",
      g.tags AS "tags",
      g.published_at AS "createdAt",
      gf.quality_score AS "qualityScore",
      (
        COALESCE(rolled.plays15, 0) + COALESCE(live.plays15, 0) +
        3 * (COALESCE(rolled.likes, 0) + COALESCE(live.likes, 0)) +
        5 * (COALESCE(rolled.remixes, 0) + COALESCE(live.remixes, 0))
      )::float /
      (COALESCE(rolled.impressions, 0) + COALESCE(live.impressions, 0) + 20)::float AS "score"
    FROM games g
    LEFT JOIN game_features gf ON gf.game_version_id = g.published_version_id
    LEFT JOIN rolled ON rolled.game_id = g.id
    LEFT JOIN live ON live.game_id = g.id
    WHERE g.status = 'published' AND g.moderation = 'approved'
    ORDER BY "score" DESC, g.published_at DESC
    LIMIT ${fetchLimit}
  `;

  const rows = await db.execute(query);
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  const result: Candidate[] = [];
  for (const row of list) {
    const gameId = String(row.gameId || row.game_id);
    if (seen.has(gameId)) continue;
    result.push({
      gameId,
      source: 'trending',
      score: Number(row.score ?? 0),
      tags: Array.isArray(row.tags) ? row.tags : [],
      createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
      qualityScore: row.qualityScore != null ? Number(row.qualityScore) : undefined,
    });
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Fresh candidate generator:
 * Newest published games first.
 */
export async function fresh(
  db: any,
  limit: number = 50,
  opts: CandidateOptions = {}
): Promise<Candidate[]> {
  const seen = toSeenSet(opts.seenGameIds);
  // Bound the scan: the seen-filter runs after the query, so ask for a little
  // more than we need instead of sorting every published game in the database.
  const fetchLimit = Math.min(limit + seen.size + 10, 500);

  const query = sql`
    SELECT
      g.id AS "gameId",
      g.tags AS "tags",
      g.published_at AS "createdAt",
      gf.quality_score AS "qualityScore"
    FROM games g
    LEFT JOIN game_features gf ON gf.game_version_id = g.published_version_id
    WHERE g.status = 'published' AND g.moderation = 'approved'
    ORDER BY g.published_at DESC NULLS LAST
    LIMIT ${fetchLimit}
  `;

  const rows = await db.execute(query);
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  const result: Candidate[] = [];
  for (const row of list) {
    const gameId = String(row.gameId || row.game_id);
    if (seen.has(gameId)) continue;
    result.push({
      gameId,
      source: 'fresh',
      score: 1.0,
      tags: Array.isArray(row.tags) ? row.tags : [],
      createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
      qualityScore: row.qualityScore != null ? Number(row.qualityScore) : undefined,
    });
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Social candidate generator:
 * Newest games from creators the user follows.
 */
export async function social(
  db: any,
  userId: string,
  limit: number = 50,
  opts: CandidateOptions = {}
): Promise<Candidate[]> {
  if (!userId) return [];
  const seen = toSeenSet(opts.seenGameIds);
  // Bound the scan: the seen-filter runs after the query, so ask for a little
  // more than we need instead of sorting every published game in the database.
  const fetchLimit = Math.min(limit + seen.size + 10, 500);

  const query = sql`
    SELECT
      g.id AS "gameId",
      g.tags AS "tags",
      g.published_at AS "createdAt",
      gf.quality_score AS "qualityScore"
    FROM games g
    JOIN follows f ON f.followee_id = g.creator_id AND f.follower_id = ${userId}
    LEFT JOIN game_features gf ON gf.game_version_id = g.published_version_id
    WHERE g.status = 'published' AND g.moderation = 'approved'
    ORDER BY g.published_at DESC NULLS LAST
    LIMIT ${fetchLimit}
  `;

  const rows = await db.execute(query);
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  const result: Candidate[] = [];
  for (const row of list) {
    const gameId = String(row.gameId || row.game_id);
    if (seen.has(gameId)) continue;
    result.push({
      gameId,
      source: 'social',
      score: 0.9,
      tags: Array.isArray(row.tags) ? row.tags : [],
      createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
      qualityScore: row.qualityScore != null ? Number(row.qualityScore) : undefined,
    });
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Explore candidate generator:
 * Published games with the FEWEST impressions (rollup + current-hour raw, same
 * hybrid split as trending).
 */
export async function explore(
  db: any,
  limit: number = 50,
  opts: CandidateOptions = {}
): Promise<Candidate[]> {
  const seen = toSeenSet(opts.seenGameIds);
  // Bound the scan: the seen-filter runs after the query, so ask for a little
  // more than we need instead of sorting every published game in the database.
  const fetchLimit = Math.min(limit + seen.size + 10, 500);

  const query = sql`
    WITH h AS (SELECT to_timestamp(FLOOR(EXTRACT(epoch FROM now()) / 3600) * 3600) AS t),
    rolled AS (
      SELECT s.game_id, SUM(s.impressions) AS impressions
      FROM game_stats_hourly s, h
      WHERE s.hour < h.t
      GROUP BY s.game_id
    ),
    live AS (
      SELECT e.game_id, COUNT(*) FILTER (WHERE e.type = 'impression') AS impressions
      FROM events e, h
      WHERE e.ts >= h.t AND e.game_id IS NOT NULL
      GROUP BY e.game_id
    )
    SELECT
      g.id AS "gameId",
      g.tags AS "tags",
      g.published_at AS "createdAt",
      gf.quality_score AS "qualityScore",
      COALESCE(rolled.impressions, 0) + COALESCE(live.impressions, 0) AS impressions
    FROM games g
    LEFT JOIN game_features gf ON gf.game_version_id = g.published_version_id
    LEFT JOIN rolled ON rolled.game_id = g.id
    LEFT JOIN live ON live.game_id = g.id
    WHERE g.status = 'published' AND g.moderation = 'approved'
    ORDER BY impressions ASC, g.published_at DESC
    LIMIT ${fetchLimit}
  `;

  const rows = await db.execute(query);
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  const result: Candidate[] = [];
  for (const row of list) {
    const gameId = String(row.gameId || row.game_id);
    if (seen.has(gameId)) continue;
    result.push({
      gameId,
      source: 'explore',
      score: 0.7,
      tags: Array.isArray(row.tags) ? row.tags : [],
      createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
      qualityScore: row.qualityScore != null ? Number(row.qualityScore) : undefined,
    });
    if (result.length >= limit) break;
  }
  return result;
}
