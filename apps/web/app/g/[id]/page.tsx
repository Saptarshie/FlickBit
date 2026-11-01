import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import * as schema from '@playloop/db';
import { getDb } from '@/lib/db';
import { GameShareScreen } from '@/components/GameShareScreen';

export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ id: string }> };

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadGame(id: string) {
  if (!uuidRe.test(id)) return null;
  const db = getDb();
  const rows = await db
    .select({
      game: schema.games,
      creatorHandle: schema.users.handle,
      creatorDisplayName: schema.users.displayName,
      artifactSha256: schema.gameVersions.artifactSha256,
      posterKey: schema.gameVersions.posterKey,
    })
    .from(schema.games)
    .leftJoin(schema.users, eq(schema.users.id, schema.games.creatorId))
    .leftJoin(schema.gameVersions, eq(schema.gameVersions.id, schema.games.publishedVersionId))
    .where(eq(schema.games.id, id))
    .limit(1);
  const row = rows[0];
  if (!row || row.game.deletedAt) return null;

  const playOrigin = process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://play.localhost:3001';

  let forkedFrom: { id: string; title: string } | null = null;
  if (row.game.forkedFromGameId) {
    const parents = await db
      .select({ id: schema.games.id, title: schema.games.title })
      .from(schema.games)
      .where(eq(schema.games.id, row.game.forkedFromGameId))
      .limit(1);
    const parent = parents[0];
    forkedFrom = parent
      ? { id: parent.id, title: parent.title }
      : { id: row.game.forkedFromGameId, title: 'a game' };
  }

  return {
    game: {
      id: row.game.id,
      title: row.game.title,
      description: row.game.description,
      tags: row.game.tags ?? [],
      counts: {
        likes: row.game.likeCount,
        saves: row.game.saveCount,
        comments: row.game.commentCount,
        plays: row.game.playCount,
        remixes: row.game.remixCount,
      },
      creator: {
        id: row.game.creatorId,
        handle: row.creatorHandle ?? 'unknown',
        displayName: row.creatorDisplayName,
      },
      artifactUrl: row.artifactSha256 ? `${playOrigin}/v/${row.artifactSha256}.html` : null,
      posterUrl: row.posterKey ?? null,
      forkedFrom,
      viewer: { liked: false, saved: false, followsCreator: false },
    },
  };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const loaded = await loadGame(id);
  if (!loaded) return { title: 'Game not found — PlayLoop' };
  const { game } = loaded;
  return {
    title: `${game.title} — PlayLoop`,
    description: game.description || `Play ${game.title} on PlayLoop.`,
    openGraph: {
      title: `${game.title} — PlayLoop`,
      description: game.description || `Play ${game.title} on PlayLoop.`,
      type: 'website',
      images: game.posterUrl ? [{ url: game.posterUrl }] : undefined,
    },
    twitter: {
      card: game.posterUrl ? 'summary_large_image' : 'summary',
      title: `${game.title} — PlayLoop`,
      description: game.description || `Play ${game.title} on PlayLoop.`,
    },
  };
}

export default async function GameSharePage({ params }: PageProps) {
  const { id } = await params;
  const loaded = await loadGame(id);
  if (!loaded) notFound();
  return <GameShareScreen game={loaded.game} />;
}
