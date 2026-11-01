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
 */
export async function trending(
  db: any,
  limit: number = 50,
  opts: CandidateOptions = {}
): Promise<Candidate[]> {
  const seen = toSeenSet(opts.seenGameIds);

  const query = sql`
    SELECT
      g.id AS "gameId",
      g.tags AS "tags",
      g.published_at AS "createdAt",
      gf.quality_score AS "qualityScore",
      (
        COALESCE(SUM(CASE WHEN e.type = 'play_15s' THEN 1 ELSE 0 END), 0) +
        3 * COALESCE(SUM(CASE WHEN e.type = 'like' THEN 1 ELSE 0 END), 0) +
        5 * COALESCE(SUM(CASE WHEN e.type = 'remix' THEN 1 ELSE 0 END), 0)
      )::float /
      (COALESCE(SUM(CASE WHEN e.type = 'impression' THEN 1 ELSE 0 END), 0) + 20)::float AS "score"
    FROM games g
    LEFT JOIN game_features gf ON gf.game_version_id = g.published_version_id
    LEFT JOIN events e ON e.game_id = g.id
    WHERE g.status = 'published' AND g.moderation = 'approved'
    GROUP BY g.id, g.tags, g.published_at, gf.quality_score
    ORDER BY "score" DESC, g.published_at DESC
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
 * Published games with the FEWEST impressions.
 */
export async function explore(
  db: any,
  limit: number = 50,
  opts: CandidateOptions = {}
): Promise<Candidate[]> {
  const seen = toSeenSet(opts.seenGameIds);

  const query = sql`
    SELECT
      g.id AS "gameId",
      g.tags AS "tags",
      g.published_at AS "createdAt",
      gf.quality_score AS "qualityScore",
      COALESCE(SUM(CASE WHEN e.type = 'impression' THEN 1 ELSE 0 END), 0) AS impressions
    FROM games g
    LEFT JOIN game_features gf ON gf.game_version_id = g.published_version_id
    LEFT JOIN events e ON e.game_id = g.id
    WHERE g.status = 'published' AND g.moderation = 'approved'
    GROUP BY g.id, g.tags, g.published_at, gf.quality_score
    ORDER BY impressions ASC, g.published_at DESC
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
