import 'dotenv/config';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { games, gameVersions, users } from '@playloop/db';
import { extractManifest, validateGame } from '@playloop/gamekit';

/**
 * Publish generated seed games.
 *
 *   npx tsx scripts/publish-seeds.ts [--dry]
 *
 * Reads `.artifacts/seeds/<slug>.html`, validates it, copies it into the
 * artifact store and upserts a published game. Idempotent: re-running replaces
 * the version of the same title instead of duplicating the card.
 */
const dry = process.argv.includes('--dry');
const root = process.cwd();
const seedsDir = path.join(root, '.artifacts', 'seeds');
const artifactsDir = path.resolve(root, process.env.ARTIFACTS_DIR ?? 'apps/play-worker/artifacts');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');
const sql = postgres(url, { max: 1, prepare: false });
const db = drizzle(sql);

const SEEDS = ['neon-drift', 'orbit-miner'];

async function main(): Promise<void> {
  const [owner] = await db.select().from(users).where(eq(users.handle, 'playloop')).limit(1);
  if (!owner) throw new Error('system user @playloop not found — run the seed first');

  for (const slug of SEEDS) {
    const file = path.join(seedsDir, `${slug}.html`);
    if (!existsSync(file)) {
      console.log(`skip ${slug}: no artifact`);
      continue;
    }
    const code = readFileSync(file, 'utf8');
    const validation = validateGame(code);
    if (validation.errors.length > 0) {
      console.log(`SKIP ${slug}: ${validation.errors.join('; ')}`);
      continue;
    }
    const manifest = extractManifest(code);
    if (!manifest) {
      console.log(`SKIP ${slug}: no manifest`);
      continue;
    }

    const sha = createHash('sha256').update(Buffer.from(code, 'utf8')).digest('hex');
    console.log(`${slug}: ${manifest.title} (${Buffer.byteLength(code)} bytes, sha ${sha.slice(0, 10)})`);
    if (dry) continue;

    copyFileSync(file, path.join(artifactsDir, `${sha}.html`));

    const existing = await db.select({ id: games.id }).from(games).where(eq(games.title, manifest.title)).limit(1);
    let gameId = existing[0]?.id;

    if (!gameId) {
      const [created] = await db
        .insert(games)
        .values({
          creatorId: owner.id,
          title: manifest.title,
          description: manifest.description,
          tags: manifest.tags,
          status: 'published',
          moderation: 'approved',
          publishedAt: new Date(),
        })
        .returning({ id: games.id });
      gameId = created!.id;
    } else {
      await db
        .update(games)
        .set({ description: manifest.description, tags: manifest.tags, status: 'published', deletedAt: null })
        .where(eq(games.id, gameId));
    }

    const [version] = await db
      .insert(gameVersions)
      .values({
        gameId,
        versionNo: 1,
        artifactSha256: sha,
        artifactBytes: Buffer.byteLength(code),
        artifactKey: `artifacts/${sha}.html`,
        manifest,
        createdBy: 'ai',
      })
      .returning({ id: gameVersions.id });

    await db.update(games).set({ publishedVersionId: version!.id }).where(eq(games.id, gameId));
    console.log(`  published as ${gameId}`);
  }

  const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from games where status = 'published' and deleted_at is null`;
  console.log(`published games: ${count}`);
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
