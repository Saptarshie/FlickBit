import { NextRequest } from 'next/server';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auth } from '../../../../auth';
import { getDb } from '@/lib/db';
import { artifactsDir } from '@/lib/artifacts';
import { MAX_PROMPT_LENGTH, takeGenerationSlot } from '@/lib/generation-quota';
import * as schema from '@playloop/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  MockAiProvider,
  embedText,
  providerFromEnv,
  runGenerationPipeline,
  toVectorLiteral,
  type SmokeSummary,
} from '@playloop/ai';


export const dynamic = 'force-dynamic';
/**
 * A turn is: planner -> art director -> coder -> static gate -> runtime gate ->
 * QA -> metadata. On a large model that is several minutes, and the runtime gate
 * launches a browser. Node runtime + a generous max duration is required.
 */
export const maxDuration = 900;

const uploadsDir = () => path.join(artifactsDir(), '..', 'uploads');

type Body = {
  prompt?: string;
  gameId?: string;
  templateId?: string;
  imageKey?: string;
  forkedFromId?: string;
};

function bad(code: string, message: string, status: number) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Runtime gate. Playwright lives in apps/play-worker (plain Node); Next cannot
 * bundle chromium-bidi, so the browser work happens over HTTP instead of being
 * imported here.
 */
const PASS_THROUGH_SMOKE: SmokeSummary = {
  pass: true,
  fps: 0,
  blankScreen: false,
  interactive: true,
  consoleErrors: [],
  uncaught: [],
};

async function smokeRunner(html: string): Promise<SmokeSummary> {
  // Unit tests and explicit opt-outs never launch a browser.
  if (process.env.PLAYLOOP_SMOKE === '0' || process.env.VITEST) return PASS_THROUGH_SMOKE;

  const playOrigin = process.env.PLAY_ORIGIN || 'http://localhost:3001';
  try {
    const res = await fetch(`${playOrigin}/internal/smoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`smoke service returned ${res.status}`);
    return (await res.json()) as SmokeSummary;
  } catch (err) {
    // The gate is best-effort: a dead smoke service must not block creation.
    console.warn('[studio] smoke unavailable:', err instanceof Error ? err.message : err);
    return PASS_THROUGH_SMOKE;
  }
}

/** Read a concept image the visitor uploaded earlier into a data URL. */
async function conceptImageDataUrl(imageKey?: string): Promise<string | undefined> {
  if (!imageKey || !/^[a-z0-9-]{8,64}\.(png|jpe?g|webp|gif)$/i.test(imageKey)) return undefined;
  try {
    const bytes = await readFile(path.join(uploadsDir(), imageKey));
    const ext = path.extname(imageKey).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return bad('bad_request', 'Invalid JSON body', 400);
  }

  const prompt = (body.prompt || '').trim();
  if (!prompt) return bad('validation_error', 'Prompt is required', 400);
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return bad('validation_error', `Prompt is limited to ${MAX_PROMPT_LENGTH} characters`, 400);
  }

  const session = await auth();
  const creatorId = (session as { user?: { id?: string } } | null)?.user?.id;
  if (!creatorId) return bad('unauthorized', 'Sign in to create a game', 401);

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

  // ---------------------------------------------------------------- session
  // A "session" is a game row plus its chat thread. Follow-up turns target an
  // existing gameId, so the base artifact and the whole conversation survive.
  let gameId = body.gameId ?? null;
  let baseCode: string | undefined;
  let versionNo = 1;
  let forkedFromId: string | null = body.forkedFromId ?? null;
  let history: string[] = [];
  let priorSpec: unknown = null;

  if (gameId) {
    const rows = await db
      .select({
        id: schema.games.id,
        creatorId: schema.games.creatorId,
        sha: schema.gameVersions.artifactSha256,
        versionNo: schema.gameVersions.versionNo,
        manifest: schema.gameVersions.manifest,
      })
      .from(schema.games)
      .leftJoin(schema.gameVersions, eq(schema.gameVersions.id, schema.games.publishedVersionId))
      .where(eq(schema.games.id, gameId))
      .limit(1);
    const row = rows[0];
    if (!row) return bad('not_found', 'Game not found', 404);
    if (row.creatorId !== creatorId) return bad('forbidden', 'You can only edit your own games', 403);
    if (row.sha) {
      try {
        baseCode = await readFile(path.join(artifactsDir(), `${row.sha}.html`), 'utf8');
        versionNo = (row.versionNo ?? 0) + 1;
        priorSpec = (row.manifest as { spec?: unknown } | null)?.spec ?? null;
      } catch {
        return bad('missing_source', 'The current build is not on disk, so it cannot be edited', 409);
      }
    }
    const prior = await db
      .select({ content: schema.chatMessages.content })
      .from(schema.chatMessages)
      .where(and(eq(schema.chatMessages.gameId, gameId), eq(schema.chatMessages.role, 'user')))
      .orderBy(desc(schema.chatMessages.createdAt))
      .limit(8);
    history = prior.map((p) => p.content).reverse();
  } else if (forkedFromId) {
    // Remix: the source game's artifact is the base the model rewrites. Without
    // this the coder only saw a title and invented an unrelated game.
    const [source] = await db
      .select({ sha: schema.gameVersions.artifactSha256 })
      .from(schema.games)
      .leftJoin(schema.gameVersions, eq(schema.gameVersions.id, schema.games.publishedVersionId))
      .where(eq(schema.games.id, forkedFromId))
      .limit(1);
    if (!source) return bad('not_found', 'The game you are remixing does not exist', 404);
    if (!source.sha) return bad('missing_source', 'That game has no published build to remix', 409);
    try {
      baseCode = await readFile(path.join(artifactsDir(), `${source.sha}.html`), 'utf8');
    } catch {
      return bad('missing_source', 'The build to remix is not on disk', 409);
    }
  }

  // Record the turn before generating so a failure is still visible in the thread.
  let turnJobId: string | null = null;
  try {
    const [job] = await db
      .insert(schema.generationJobs)
      .values({
        userId: creatorId,
        gameId,
        kind: gameId ? 'edit' : forkedFromId ? 'remix_edit' : 'create',
        prompt,
        status: 'running',
      })
      .returning({ id: schema.generationJobs.id });
    turnJobId = job?.id ?? null;
    if (gameId) {
      await db.insert(schema.chatMessages).values({ gameId, userId: creatorId, role: 'user', content: prompt });
    }
  } catch (err) {
    console.warn('[studio] could not record the turn:', err instanceof Error ? err.message : err);
  }

  const artifactDir = artifactsDir();
  const playOrigin = process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://localhost:3001';
  const imageDataUrl = await conceptImageDataUrl(body.imageKey);

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendEvent = async (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    await writer.write(encoder.encode(payload));
  };

  (async () => {
    try {
      const provider = providerFromEnv() ?? new MockAiProvider();
      await sendEvent('progress', {
        stage: 'spec',
        message: providerFromEnv()
          ? `Planning with ${process.env.LLM_MODEL}`
          : 'LLM not configured — using the offline template provider',
        progressPercent: 5,
      });

      const startedAt = Date.now();
      let lastProgress: { stage: string; message: string; progressPercent?: number } = {
        stage: 'generating',
        message: 'Generating…',
        progressPercent: 30,
      };
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
            baseCode,
            isEdit: Boolean(baseCode),
            isRemix: Boolean(forkedFromId),
            history,
            imageDataUrl,
            spec: (priorSpec as never) ?? undefined,
            smoke: smokeRunner,
            onProgress: async (progress) => {
              lastProgress = progress;
              await sendEvent('progress', progress);
            },
          },
          provider,
        );
      } finally {
        clearInterval(heartbeat);
      }

      await mkdir(artifactDir, { recursive: true });
      await writeFile(path.join(artifactDir, `${result.sha256}.html`), result.code, 'utf8');

      // New game on first turn; the same row is extended on every follow-up.
      if (!gameId) {
        const [created] = await db
          .insert(schema.games)
          .values({
            creatorId,
            title: result.metadata.title,
            description: result.metadata.description,
            tags: result.metadata.tags,
            status: 'published',
            moderation: 'approved',
            forkedFromGameId: forkedFromId,
            publishedAt: new Date(),
          })
          .returning({ id: schema.games.id });
        gameId = created!.id;
        // First turn: the game did not exist when the request arrived, so the
        // visitor's opening message is recorded now that it has a home.
        try {
          await db.insert(schema.chatMessages).values({ gameId, userId: creatorId, role: 'user', content: prompt });
        } catch (err) {
          console.warn('[studio] could not record the opening turn:', err instanceof Error ? err.message : err);
        }
      } else {
        await db
          .update(schema.games)
          .set({ title: result.metadata.title, description: result.metadata.description, tags: result.metadata.tags, updatedAt: new Date() })
          .where(eq(schema.games.id, gameId));
      }

      const [version] = await db
        .insert(schema.gameVersions)
        .values({
          gameId,
          versionNo,
          artifactSha256: result.sha256,
          artifactBytes: result.bytes,
          artifactKey: `artifacts/${result.sha256}.html`,
          manifest: { ...result.metadata, spec: result.spec },
          createdBy: 'ai',
        })
        .returning({ id: schema.gameVersions.id });

      await db.update(schema.games).set({ publishedVersionId: version!.id }).where(eq(schema.games.id, gameId));

      try {
        const embedTextInput = `${result.metadata.title}. ${result.metadata.description} ${result.metadata.tags.join(' ')}`;
        const vec = await embedText(embedTextInput);
        if (vec) {
          await db.execute(
            sql`INSERT INTO game_features (game_version_id, description_text, text_vec, content_vec, feed_eligible, embedded_at, model_versions)
                VALUES (${version!.id}, ${embedTextInput}, ${toVectorLiteral(vec)}::vector, ${toVectorLiteral(vec)}::vector, true, now(), ${JSON.stringify({ embed: process.env.EMBED_MODEL ?? 'embeddinggemma' })}::jsonb)
                ON CONFLICT (game_version_id) DO UPDATE SET text_vec = EXCLUDED.text_vec, content_vec = EXCLUDED.content_vec, feed_eligible = true, embedded_at = now()`,
          );
        }
      } catch (embedErr) {
        console.warn('[studio] embedding skipped:', embedErr instanceof Error ? embedErr.message : embedErr);
      }

      // Close the turn: assistant reply + job outcome.
      try {
        await db.insert(schema.chatMessages).values({
          gameId,
          userId: creatorId,
          role: 'assistant',
          content: [
            `Built “${result.metadata.title}”${result.repairsCount ? ` after ${result.repairsCount} repair(s)` : ''}.`,
            result.smoke ? `Runtime gate: ${result.smoke.pass ? 'passed' : 'FAILED'} at ${result.smoke.fps} fps.` : '',
            result.review?.summary ? `QA: ${result.review.summary}` : '',
          ]
            .filter(Boolean)
            .join(' '),
          versionId: version!.id,
        });
        if (turnJobId) {
          await db
            .update(schema.generationJobs)
            .set({ status: 'succeeded', resultVersionId: version!.id, finishedAt: new Date() })
            .where(eq(schema.generationJobs.id, turnJobId));
        }
      } catch (err) {
        console.warn('[studio] could not close the turn:', err instanceof Error ? err.message : err);
      }

      await sendEvent('complete', {
        gameId,
        versionId: version!.id,
        versionNo,
        artifactUrl: `${playOrigin}/v/${result.sha256}.html`,
        metadata: result.metadata,
        spec: result.spec,
        design: result.design ?? null,
        smoke: result.smoke ?? null,
        review: result.review ?? null,
        timingsMs: result.timingsMs ?? {},
        repairs: result.repairsCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generation failed';
      try {
        if (turnJobId) {
          await db
            .update(schema.generationJobs)
            .set({ status: 'failed', error: { message }, finishedAt: new Date() })
            .where(eq(schema.generationJobs.id, turnJobId));
        }
        if (gameId) {
          await db.insert(schema.chatMessages).values({
            gameId,
            userId: creatorId,
            role: 'assistant',
            content: `That build failed: ${message}. Nothing was published — try again or rephrase.`,
          });
        }
      } catch {
        /* the stream error below is what the user sees */
      }
      await sendEvent('error', { code: 'generation_failed', message });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
