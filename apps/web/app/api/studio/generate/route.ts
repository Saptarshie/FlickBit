import { NextRequest } from 'next/server';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auth } from '../../../../auth';
import { getDb } from '@/lib/db';
import { schema } from '@playloop/db';
import { eq } from 'drizzle-orm';
import { MockAiProvider, runGenerationPipeline } from '@playloop/ai';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { prompt?: string; templateId?: string; forkedFromId?: string; baseCode?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: { code: 'bad_request', message: 'Invalid JSON body' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return new Response(JSON.stringify({ error: { code: 'validation_error', message: 'Prompt is required' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const session = await auth();
  // For studio generation, require user or use default test user
  let creatorId = session?.user?.id;
  const db = getDb();

  if (!creatorId) {
    // Fall back to system or demo user for anonymous studio trials
    const [systemUser] = await db.select().from(schema.users).where(eq(schema.users.handle, 'playloop'));
    creatorId = systemUser?.id;
    if (!creatorId) {
      const [u] = await db.insert(schema.users).values({
        handle: 'creator',
        displayName: 'Creator',
        email: 'creator@playloop.local',
        role: 'user',
      }).returning();
      creatorId = u!.id;
    }
  }

  const artifactsDir =
    process.env.ARTIFACTS_DIR || path.resolve(process.cwd(), '../../.artifacts');
  const playOrigin =
    process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://play.localhost:3001';

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendEvent = async (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    await writer.write(encoder.encode(payload));
  };

  // Run background generation pipeline while streaming SSE
  (async () => {
    try {
      const provider = new MockAiProvider();

      const result = await runGenerationPipeline(
        {
          prompt,
          templateId: body.templateId,
          baseCode: body.baseCode,
          isRemix: Boolean(body.forkedFromId),
          onProgress: async (progress) => {
            await sendEvent('progress', progress);
          },
        },
        provider
      );

      // Write artifact to disk for play-worker
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(path.join(artifactsDir, `${result.sha256}.html`), result.code, 'utf8');

      // Insert game & version into DB (game -> version -> update game)
      const [g] = await db.insert(schema.games).values({
        creatorId: creatorId!,
        title: result.metadata.title,
        description: result.metadata.description,
        tags: result.metadata.tags,
        status: 'published',
        moderation: 'approved',
        forkedFromGameId: body.forkedFromId || null,
        publishedAt: new Date(),
      }).returning();

      const [v] = await db.insert(schema.gameVersions).values({
        gameId: g!.id,
        versionNo: 1,
        artifactSha256: result.sha256,
        artifactBytes: result.bytes,
        artifactKey: `artifacts/${result.sha256}.html`,
        manifest: result.metadata,
        createdBy: 'ai',
      }).returning();

      await db.update(schema.games)
        .set({ publishedVersionId: v!.id })
        .where(eq(schema.games.id, g!.id));

      const artifactUrl = `${playOrigin}/v/${result.sha256}.html`;

      await sendEvent('complete', {
        gameId: g!.id,
        versionId: v!.id,
        artifactUrl,
        metadata: result.metadata,
        spec: result.spec,
      });
    } catch (err: any) {
      await sendEvent('error', {
        code: 'generation_failed',
        message: err.message || 'Generation failed',
      });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
