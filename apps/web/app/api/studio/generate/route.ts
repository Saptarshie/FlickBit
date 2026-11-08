import { NextRequest } from 'next/server';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auth } from '../../../../auth';
import { getDb } from '@/lib/db';
import * as schema from '@playloop/db';
import { eq, sql } from 'drizzle-orm';
import { MockAiProvider, providerFromEnv, runGenerationPipeline, embedText, toVectorLiteral } from '@playloop/ai';

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

  // ARTIFACTS_DIR may be relative ("./apps/play-worker/artifacts" from the repo
  // root); Next's cwd is apps/web, so resolve relative paths against the repo.
  const repoRoot = path.resolve(process.cwd(), '../..');
  const artifactsDir = process.env.ARTIFACTS_DIR
    ? path.resolve(repoRoot, process.env.ARTIFACTS_DIR)
    : path.resolve(process.cwd(), '../play-worker/artifacts');
  const playOrigin =
    process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://localhost:3001';

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
      const provider = providerFromEnv() ?? new MockAiProvider();
      const usingRealLlm = provider instanceof Object && !(provider instanceof MockAiProvider);
      await sendEvent('progress', {
        stage: 'spec',
        message: usingRealLlm
          ? `Using ${process.env.LLM_MODEL}`
          : 'LLM not configured — using the offline template provider',
        progressPercent: 5,
      });

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

      // Embed the description for recommendations. Best-effort: when Ollama is
      // down the game still publishes, it just stays out of the vector index.
      try {
        const embedTextInput = `${result.metadata.title}. ${result.metadata.description} ${result.metadata.tags.join(' ')}`;
        const vec = await embedText(embedTextInput);
        if (vec) {
          await db.execute(
            sql`INSERT INTO game_features (game_version_id, description_text, text_vec, content_vec, feed_eligible, embedded_at, model_versions)
                VALUES (${v!.id}, ${embedTextInput}, ${toVectorLiteral(vec)}::vector, ${toVectorLiteral(vec)}::vector, true, now(), ${JSON.stringify({ embed: process.env.EMBED_MODEL ?? 'embeddinggemma' })}::jsonb)
                ON CONFLICT (game_version_id) DO UPDATE SET text_vec = EXCLUDED.text_vec, content_vec = EXCLUDED.content_vec, feed_eligible = true, embedded_at = now()`
          );
        }
      } catch (embedErr) {
        console.warn('[studio] embedding skipped:', embedErr instanceof Error ? embedErr.message : embedErr);
      }

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
