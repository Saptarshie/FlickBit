import { NextRequest } from 'next/server';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auth } from '../../../../auth';
import { getDb } from '@/lib/db';
import { artifactsDir } from '@/lib/artifacts';
import { MAX_PROMPT_LENGTH, takeGenerationSlot } from '@/lib/generation-quota';
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
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return new Response(
      JSON.stringify({
        error: { code: 'validation_error', message: `Prompt is limited to ${MAX_PROMPT_LENGTH} characters` },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  // Generation costs a multi-minute LLM completion, so it requires an account:
  // anonymous callers used to publish games attributed to the system user.
  const session = await auth();
  const creatorId = session?.user?.id;
  if (!creatorId) {
    return new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in to create a game' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }

  const quota = takeGenerationSlot(creatorId);
  if (!quota.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'rate_limited',
          message: `You have reached ${quota.limit} generations this hour. Try again later.`,
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(quota.retryAfterSeconds) } },
    );
  }

  const db = getDb();

  // Shared resolver: ARTIFACTS_DIR is relative to the repo root, not to
  // apps/web (see src/lib/artifacts.ts).
  const artifactDir = artifactsDir();
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

      const startedAt = Date.now();
      let lastProgress: { stage: string; message: string; progressPercent?: number } = {
        stage: 'generating',
        message: 'Generating…',
        progressPercent: 40,
      };
      // Long generations can sit in one stage for minutes; a periodic tick keeps
      // the UI alive and proves the job is not hung.
      const heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        void sendEvent('progress', {
          ...lastProgress,
          message: `${lastProgress.message.replace(/ \(\d+s\)$/, '')} (${elapsed}s)`,
        }).catch(() => undefined);
      }, 5000);

      let result;
      try {
        result = await runGenerationPipeline(
          {
            prompt,
            templateId: body.templateId,
            baseCode: body.baseCode,
            isRemix: Boolean(body.forkedFromId),
            onProgress: async (progress) => {
              lastProgress = progress;
              await sendEvent('progress', progress);
            },
          },
          provider
        );
      } finally {
        clearInterval(heartbeat);
      }

      // Write artifact to disk for play-worker
      await mkdir(artifactDir, { recursive: true });
      await writeFile(path.join(artifactDir, `${result.sha256}.html`), result.code, 'utf8');

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
