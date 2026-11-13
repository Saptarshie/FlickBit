/**
 * Republish the eight seed games from the templates in packages/gamekit.
 *
 *   npx tsx scripts/republish-templates.ts            # dry run
 *   npx tsx scripts/republish-templates.ts --write    # publish new versions
 *
 * The template games in the feed were seeded once and then drifted: they carry
 * artifacts from before score reporting and before the restart checks, so the
 * playtest sweep flags four of them as "trapped at game over". The templates are
 * the source of truth for those games, so this script brings the feed back in
 * line with the code by publishing a NEW version — never by mutating history.
 *
 * Only games owned by the system account (@playloop) and titled exactly like a
 * template are touched. Anything a person made is left alone.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { gameVersions, games, users } from '@playloop/db';
import { TEMPLATE_IDS, extractManifest, getTemplate } from '@playloop/gamekit';

const write = process.argv.includes('--write');
const root = process.cwd();
const artifactsDir = path.resolve(root, process.env.ARTIFACTS_DIR ?? 'apps/play-worker/artifacts');

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const db = drizzle(client);

  const [owner] = await db.select().from(users).where(eq(users.handle, 'playloop')).limit(1);
  if (!owner) throw new Error('system user @playloop is missing');

  console.log(`${write ? 'PUBLISHING' : 'DRY RUN'} — templates → games owned by @playloop\n`);
  console.log(`${'template'.padEnd(16)}${'title'.padEnd(18)}${'version'.padEnd(10)}verdict`);
  console.log('-'.repeat(64));

  let changed = 0;
  let skipped = 0;

  for (const id of TEMPLATE_IDS) {
    const html = getTemplate(id).code;
    const sha = createHash('sha256').update(Buffer.from(html, 'utf8')).digest('hex');
    const manifest = extractManifest(html);
    const title = manifest?.title ?? id;

    const [game] = await db
      .select()
      .from(games)
      .where(and(eq(games.title, title), eq(games.creatorId, owner.id)))
      .limit(1);

    if (!game) {
      console.log(`${id.padEnd(16)}${title.slice(0, 17).padEnd(18)}${'-'.padEnd(10)}no matching game`);
      skipped += 1;
      continue;
    }

    const [latest] = await db
      .select()
      .from(gameVersions)
      .where(eq(gameVersions.gameId, game.id))
      .orderBy(desc(gameVersions.versionNo))
      .limit(1);

    if (latest?.artifactSha256 === sha) {
      console.log(`${id.padEnd(16)}${title.slice(0, 17).padEnd(18)}${`v${latest.versionNo}`.padEnd(10)}up to date`);
      skipped += 1;
      continue;
    }

    const versionNo = (latest?.versionNo ?? 0) + 1;
    console.log(`${id.padEnd(16)}${title.slice(0, 17).padEnd(18)}${`v${versionNo}`.padEnd(10)}publish`);

    if (!write) {
      changed += 1;
      continue;
    }

    if (!existsSync(artifactsDir)) throw new Error(`artifacts dir missing: ${artifactsDir}`);
    writeFileSync(path.join(artifactsDir, `${sha}.html`), html);

    const [version] = await db
      .insert(gameVersions)
      .values({
        gameId: game.id,
        parentVersionId: latest?.id ?? null,
        versionNo,
        artifactSha256: sha,
        artifactBytes: Buffer.byteLength(html, 'utf8'),
        artifactKey: `${sha}.html`,
        manifest: (manifest ?? {}) as Record<string, unknown>,
        createdBy: 'user',
      })
      .returning();

    await db
      .update(games)
      .set({ publishedVersionId: version!.id, updatedAt: sql`now()` })
      .where(eq(games.id, game.id));

    changed += 1;
  }

  console.log(`\n${changed} ${write ? 'published' : 'would publish'}, ${skipped} skipped`);
  await client.end();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
