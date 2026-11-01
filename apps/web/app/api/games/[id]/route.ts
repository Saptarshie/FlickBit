import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@playloop/db';
import { getDb } from '../../../../src/lib/db';
import {
  jsonError,
  jsonOk,
  parseValue,
  requireUser,
  wrap,
} from '../../../../src/lib/api-helpers';

const paramsSchema = z.object({ id: z.uuid() });

const patchSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(10).optional(),
  status: z.enum(['published', 'unlisted', 'draft']).optional(),
});

/**
 * Creator self-service edit: metadata (title/description/tags) and lifecycle
 * (publish/unpublish). Publish requires an attached artifact version; unpublish
 * keeps publishedAt so re-publishing does not reset provenance.
 */
export const PATCH = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);
  const input = parseValue(await req.json().catch(() => null), patchSchema);

  const db = getDb();
  const rows = await db.select().from(schema.games).where(eq(schema.games.id, gameId)).limit(1);
  const game = rows[0];
  if (!game || game.deletedAt) return jsonError('not_found', 'Game not found', 404);
  if (game.creatorId !== userId) return jsonError('forbidden', 'Not your game', 403);

  const updates: Partial<typeof schema.games.$inferInsert> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.tags !== undefined) updates.tags = input.tags;
  if (input.status !== undefined) {
    if (input.status === 'published') {
      if (!game.publishedVersionId) {
        return jsonError('no_version', 'Game has no artifact version to publish', 400);
      }
      updates.status = 'published';
      if (!game.publishedAt) updates.publishedAt = new Date();
    } else {
      updates.status = input.status;
    }
  }
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(schema.games)
    .set(updates)
    .where(eq(schema.games.id, gameId))
    .returning();

  return jsonOk({
    id: updated!.id,
    title: updated!.title,
    description: updated!.description,
    tags: updated!.tags ?? [],
    status: updated!.status,
    publishedAt: updated!.publishedAt,
  });
});
