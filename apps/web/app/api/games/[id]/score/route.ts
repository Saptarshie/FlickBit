import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { gameVersions, games, scores } from '@playloop/db';
import { getDb } from '../../../../../src/lib/db';
import { enforceRateLimit } from '@/lib/api-helpers';
import {
  jsonError,
  jsonOk,
  parseBody,
  parseValue,
  requireUser,
  wrap,
} from '../../../../../src/lib/api-helpers';;

const paramsSchema = z.object({ id: z.uuid() });

const scoreSchema = z.object({
  score: z.number().refine((n) => Number.isFinite(n), 'score must be a finite number'),
  versionId: z.uuid().nullish(),
  meta: z.record(z.string(), z.unknown()).nullish(),
});

function scoreJson(row: {
  id: string;
  score: string;
  versionId: string | null;
  meta: unknown;
  createdAt: Date;
}) {
  return {
    id: row.id,
    score: Number(row.score),
    versionId: row.versionId,
    meta: row.meta,
    createdAt: row.createdAt,
  };
}

export const POST = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  enforceRateLimit(userId, 'score', 30, 60_000, 'score submissions');
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);
  const input = await parseBody(req, scoreSchema);

  const db = getDb();
  const gameRows = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);
  if (gameRows.length === 0) return jsonError('not_found', 'Game not found', 404);

  const versionId = input.versionId ?? null;
  if (versionId) {
    // The version must belong to THIS game: a score used to be able to point at
    // another game's build.
    const versionRows = await db
      .select({ id: gameVersions.id })
      .from(gameVersions)
      .where(and(eq(gameVersions.id, versionId), eq(gameVersions.gameId, gameId)))
      .limit(1);
    if (versionRows.length === 0) return jsonError('bad_request', 'Unknown versionId for this game', 400);
  }

  // A leaderboard is only meaningful if the score is plausible: the manifest
  // declares its own scale, and anything outside it is rejected rather than
  // letting one client own every slot with 1e308.
  const MAX_SCORE = Number(process.env.LEADERBOARD_MAX_SCORE ?? 1_000_000);
  if (!Number.isFinite(input.score) || Math.abs(input.score) > MAX_SCORE) {
    return jsonError('validation_error', `Scores must be between -${MAX_SCORE} and ${MAX_SCORE}`, 400);
  }

  const [row] = await db
    .insert(scores)
    .values({
      gameId,
      versionId,
      userId,
      score: String(input.score),
      meta: input.meta ?? null,
    })
    .returning();
  if (!row) return jsonError('internal', 'Failed to store score', 500);

  return jsonOk({ score: scoreJson(row) }, 201);
});

export const GET = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);

  const db = getDb();
  const gameRows = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);
  if (gameRows.length === 0) return jsonError('not_found', 'Game not found', 404);

  const rows = await db
    .select()
    .from(scores)
    .where(and(eq(scores.gameId, gameId), eq(scores.userId, userId)))
    .orderBy(desc(scores.createdAt), desc(scores.id))
    .limit(10);

  return jsonOk({ scores: rows.map(scoreJson) });
});
