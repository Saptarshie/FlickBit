export type GameCard = {
  id: string;
  versionId: string;
  title: string;
  description: string;
  tags: string[];
  creator: { id: string; handle: string; avatar: string | null };
  artifactUrl: string;
  posterUrl: string | null;
  counts: { likes: number; saves: number; comments: number; plays: number };
  viewer: { liked: boolean; saved: boolean; followsCreator: boolean };
  forkedFrom?: { id: string; title: string } | null;
};

export type FeedPage = {
  items: GameCard[];
  cursor: string | null;
};

export type Candidate = {
  gameId: string;
  source: 'content' | 'social' | 'trending' | 'fresh' | 'explore';
  score: number;
  tags?: string[];
  createdAt?: Date;
  qualityScore?: number;
  baseEngagement?: number;
};
