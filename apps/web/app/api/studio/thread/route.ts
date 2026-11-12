import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import * as schema from '@playloop/db';
import { getDb } from '@/lib/db';
import { jsonError, jsonOk, parseValue, wrap } from '@/lib/api-helpers';
import { resolveViewer, SESSION_STALE } from '@/lib/session';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ gameId: z.string().uuid() });

/**
 * The studio thread for one game: every turn the player asked for, the build
 * that came out of it, and the versions so a follow-up can continue from the
 * latest artifact instead of starting over.
 */
export const GET = wrap(async (req) => {
  const url = new URL(req.url);
  // parseValue throws the 400 envelope; a bare .parse() was caught by wrap() and
  // reported as a 500 "something went wrong while saving".
  const gameId = parseValue({ gameId: url.searchParams.get('gameId') ?? '' }, querySchema).gameId;

  const viewer = await resolveViewer();
  if (viewer.kind === 'anonymous') return jsonError('unauthorized', 'Sign in to open a studio session', 401);
  if (viewer.kind === 'stale') return jsonError(SESSION_STALE.code, SESSION_STALE.message, 401);
  const userId = viewer.userId;

  const db = getDb();
  const [game] = await db
    .select({
      id: schema.games.id,
      title: schema.games.title,
      creatorId: schema.games.creatorId,
      publishedVersionId: schema.games.publishedVersionId,
    })
    .from(schema.games)
    .where(and(eq(schema.games.id, gameId), eq(schema.games.creatorId, userId)))
    .limit(1);

  if (!game) return jsonError('not_found', 'Session not found', 404);

  const messages = await db
    .select({
      id: schema.chatMessages.id,
      role: schema.chatMessages.role,
      content: schema.chatMessages.content,
      versionId: schema.chatMessages.versionId,
      createdAt: schema.chatMessages.createdAt,
    })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.gameId, gameId))
    .orderBy(asc(schema.chatMessages.createdAt))
    .limit(100);

  const versions = await db
    .select({
      id: schema.gameVersions.id,
      versionNo: schema.gameVersions.versionNo,
      sha: schema.gameVersions.artifactSha256,
      createdAt: schema.gameVersions.createdAt,
    })
    .from(schema.gameVersions)
    .where(eq(schema.gameVersions.gameId, gameId))
    .orderBy(desc(schema.gameVersions.versionNo))
    .limit(20);

  const playOrigin = process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://localhost:3001';

  return jsonOk({
    game: { id: game.id, title: game.title, publishedVersionId: game.publishedVersionId },
    messages,
    versions: versions.map((v) => ({ ...v, artifactUrl: `${playOrigin}/v/${v.sha}.html` })),
  });
});
