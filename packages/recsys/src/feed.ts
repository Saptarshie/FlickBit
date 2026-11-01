import { sql } from 'drizzle-orm';
import { explore, fresh, social, trending } from './candidates';
import { mmrRerank, rankCandidates } from './ranker';
import type { Candidate, FeedPage, GameCard } from './types';

export type FetchFeedOptions = {
  userId?: string;
  anonId?: string;
  cursor?: string;
  limit?: number;
  playOrigin?: string;
  seenGameIds?: string[];
};

type CursorPayload = {
  seen: string[];
  lastId: string;
};

function decodeCursor(cursor?: string): CursorPayload | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export async function fetchFeedPage(
  db: any,
  opts: FetchFeedOptions = {}
): Promise<FeedPage> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const playOrigin = opts.playOrigin ?? 'http://play.localhost:3001';

  const decoded = decodeCursor(opts.cursor);
  const seenSet = new Set<string>([
    ...(opts.seenGameIds ?? []),
    ...(decoded?.seen ?? []),
  ]);

  // 1. Generate candidates from multiple streams
  const [trendingCands, freshCands, exploreCands, socialCands] = await Promise.all([
    trending(db, limit * 3, { seenGameIds: seenSet }),
    fresh(db, limit * 2, { seenGameIds: seenSet }),
    explore(db, limit * 2, { seenGameIds: seenSet }),
    opts.userId ? social(db, opts.userId, limit * 2, { seenGameIds: seenSet }) : Promise.resolve([]),
  ]);

  // 2. Deduplicate candidates by gameId (keeping highest score)
  const candMap = new Map<string, Candidate>();
  for (const c of [...socialCands, ...trendingCands, ...freshCands, ...exploreCands]) {
    const existing = candMap.get(c.gameId);
    if (!existing || c.score > existing.score) {
      candMap.set(c.gameId, c);
    }
  }

  const candidates = Array.from(candMap.values());
  if (candidates.length === 0) {
    return { items: [], cursor: null };
  }

  // 3. Rank candidates with heuristic
  const rankedCandidates = rankCandidates(candidates);
  const topCandidates = rankedCandidates.slice(0, limit * 2);
  const topIds = topCandidates.map((c) => c.gameId);

  // 4. Hydrate GameCards from DB
  const idListSql = sql.join(topIds.map((id) => sql`${id}`), sql`, `);
  const hydQuery = sql`
    SELECT
      g.id AS "id",
      g.title AS "title",
      g.description AS "description",
      g.tags AS "tags",
      g.like_count AS "likeCount",
      g.save_count AS "saveCount",
      g.comment_count AS "commentCount",
      g.play_count AS "playCount",
      g.forked_from_game_id AS "forkedFromGameId",
      gv.id AS "versionId",
      gv.artifact_sha256 AS "artifactSha256",
      gv.poster_key AS "posterKey",
      u.id AS "creatorId",
      u.handle AS "creatorHandle",
      u.avatar_url AS "creatorAvatar",
      fg.title AS "forkedFromTitle"
    FROM games g
    JOIN game_versions gv ON gv.id = g.published_version_id
    JOIN users u ON u.id = g.creator_id
    LEFT JOIN games fg ON fg.id = g.forked_from_game_id
    WHERE g.id IN (${idListSql})
  `;

  const rows = await db.execute(hydQuery);
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  const rowMap = new Map<string, any>();
  for (const r of list) {
    const id = String(r.id);
    rowMap.set(id, r);
  }

  // Viewer flags
  const likedSet = new Set<string>();
  const savedSet = new Set<string>();
  const followsSet = new Set<string>();

  if (opts.userId) {
    const [likeRows, saveRows, followRows] = await Promise.all([
      db.execute(sql`SELECT game_id FROM likes WHERE user_id = ${opts.userId} AND game_id IN (${idListSql})`),
      db.execute(sql`SELECT game_id FROM saves WHERE user_id = ${opts.userId} AND game_id IN (${idListSql})`),
      db.execute(sql`
        SELECT followee_id FROM follows
        WHERE follower_id = ${opts.userId}
        AND followee_id IN (SELECT creator_id FROM games WHERE id IN (${idListSql}))
      `),
    ]);
    for (const r of (Array.isArray(likeRows) ? likeRows : likeRows.rows ?? [])) likedSet.add(String(r.game_id));
    for (const r of (Array.isArray(saveRows) ? saveRows : saveRows.rows ?? [])) savedSet.add(String(r.game_id));
    for (const r of (Array.isArray(followRows) ? followRows : followRows.rows ?? [])) followsSet.add(String(r.followee_id));
  }

  const cards: GameCard[] = [];
  for (const cand of topCandidates) {
    const r = rowMap.get(cand.gameId);
    if (!r) continue;

    const sha = String(r.artifactSha256 || '');
    const artifactUrl = `${playOrigin}/v/${sha}.html`;
    const posterUrl = r.posterKey ? `/api/media/${r.posterKey}` : null;

    cards.push({
      id: String(r.id),
      versionId: String(r.versionId),
      title: String(r.title ?? ''),
      description: String(r.description ?? ''),
      tags: Array.isArray(r.tags) ? r.tags : [],
      creator: {
        id: String(r.creatorId),
        handle: String(r.creatorHandle ?? 'creator'),
        avatar: r.creatorAvatar ? String(r.creatorAvatar) : null,
      },
      artifactUrl,
      posterUrl,
      counts: {
        likes: Number(r.likeCount ?? 0),
        saves: Number(r.saveCount ?? 0),
        comments: Number(r.commentCount ?? 0),
        plays: Number(r.playCount ?? 0),
      },
      viewer: {
        liked: likedSet.has(String(r.id)),
        saved: savedSet.has(String(r.id)),
        followsCreator: followsSet.has(String(r.creatorId)),
      },
      forkedFrom: r.forkedFromGameId
        ? { id: String(r.forkedFromGameId), title: String(r.forkedFromTitle ?? 'Original') }
        : null,
    });
  }

  // 5. MMR re-ranking for diversity (empty map for phase 1)
  const reranked = mmrRerank(cards, new Map());
  const pageItems = reranked.slice(0, limit);

  let nextCursor: string | null = null;
  if (pageItems.length > 0 && reranked.length > limit) {
    const lastItem = pageItems[pageItems.length - 1];
    if (lastItem) {
      const updatedSeen = Array.from(new Set([...seenSet, ...pageItems.map((c) => c.id)]));
      nextCursor = encodeCursor({
        seen: updatedSeen,
        lastId: lastItem.id,
      });
    }
  }

  return {
    items: pageItems,
    cursor: nextCursor,
  };
}
