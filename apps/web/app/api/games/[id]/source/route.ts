import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@playloop/db';
import { getDb } from '../../../../../src/lib/db';
import {
  jsonError,
  jsonOk,
  parseValue,
  wrap,
} from '../../../../../src/lib/api-helpers';

const paramsSchema = z.object({ id: z.uuid() });

/**
 * Returns the artifact HTML of a game's published version so the Studio can
 * prefill a remix with the base code (`baseCode` + `forkedFromId` on
 * POST /api/studio/generate). Artifacts are already public on the play origin,
 * so this adds no new exposure.
 */
export const GET = wrap<{ id: string }>(async (_req, ctx) => {
  const { id: gameId } = parseValue(await ctx.params, paramsSchema);

  const db = getDb();
  const rows = await db
    .select({
      id: schema.games.id,
      title: schema.games.title,
      description: schema.games.description,
      tags: schema.games.tags,
      artifactSha256: schema.gameVersions.artifactSha256,
    })
    .from(schema.games)
    .leftJoin(schema.gameVersions, eq(schema.gameVersions.id, schema.games.publishedVersionId))
    .where(eq(schema.games.id, gameId))
    .limit(1);

  const row = rows[0];
  if (!row || !row.artifactSha256) {
    return jsonError('not_found', 'Game source not found', 404);
  }

  const artifactsDir =
    process.env.ARTIFACTS_DIR || path.resolve(process.cwd(), '../../.artifacts');
  let code: string;
  try {
    code = await readFile(path.join(artifactsDir, `${row.artifactSha256}.html`), 'utf8');
  } catch {
    return jsonError('not_found', 'Game source not found', 404);
  }

  return jsonOk({
    code,
    game: {
      id: row.id,
      title: row.title,
      description: row.description,
      tags: row.tags ?? [],
    },
  });
});
