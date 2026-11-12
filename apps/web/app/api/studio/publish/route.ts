import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactsDir } from '@/lib/artifacts';
import { getDb } from '@/lib/db';
import { humanizeDbError } from '@/lib/db-errors';
import { clearPendingBuild, readPendingBuild } from '@/lib/pending-builds';
import { publishArtifact } from '@/lib/publish';
import { resolveViewer, SESSION_STALE } from '@/lib/session';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ sha: z.string().regex(/^[0-9a-f]{64}$/) });

/**
 * Finish publishing a build whose database write failed.
 *
 *   POST /api/studio/publish { sha }
 *
 * The artifact and its metadata are already on disk; this only re-runs the
 * database part, idempotently. It is what the studio's "Retry publishing"
 * button calls, so a transient database error never costs another generation.
 */
export async function POST(req: Request) {
  let sha: string;
  try {
    sha = bodySchema.parse(await req.json()).sha;
  } catch {
    return Response.json({ error: { code: 'validation_error', message: 'Send { sha }' } }, { status: 400 });
  }

  const viewer = await resolveViewer();
  if (viewer.kind === 'anonymous') {
    return Response.json({ error: { code: 'unauthorized', message: 'Sign in to publish' } }, { status: 401 });
  }
  if (viewer.kind === 'stale') {
    return Response.json({ error: SESSION_STALE }, { status: 401 });
  }

  const pending = await readPendingBuild(sha);
  if (!pending) {
    return Response.json(
      { error: { code: 'not_found', message: 'That build is no longer waiting to be published.' } },
      { status: 404 },
    );
  }
  if (pending.creatorId !== viewer.userId) {
    return Response.json({ error: { code: 'forbidden', message: 'That build belongs to someone else.' } }, { status: 403 });
  }

  // The HTML must still be on disk; it is written before the publish attempt.
  try {
    await readFile(path.join(artifactsDir(), `${sha}.html`), 'utf8');
  } catch {
    await clearPendingBuild(sha);
    return Response.json(
      { error: { code: 'missing_source', message: 'The build file is gone — generate it again.' } },
      { status: 409 },
    );
  }

  try {
    const result = await publishArtifact(getDb(), {
      creatorId: viewer.userId,
      sha256: sha,
      bytes: pending.bytes,
      metadata: pending.metadata,
      spec: pending.spec,
      gameId: pending.gameId ?? null,
      forkedFromId: pending.forkedFromId ?? null,
    });
    await clearPendingBuild(sha);
    const playOrigin = process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://localhost:3001';
    return Response.json({
      data: {
        gameId: result.gameId,
        versionId: result.versionId,
        versionNo: result.versionNo,
        artifactUrl: `${playOrigin}/v/${sha}.html`,
      },
    });
  } catch (err) {
    const human = humanizeDbError(err);
    console.error('[publish] retry failed:', human.detail);
    return Response.json(
      { error: { code: human.code, message: human.message, retryable: human.retryable } },
      { status: 500 },
    );
  }
}
