'use client';

import Link from 'next/link';
import type { MiniGame } from '../lib/client-api';

type Props = {
  games: MiniGame[];
  emptyMessage?: string;
};

function initials(text: string): string {
  return text.slice(0, 2).toUpperCase();
}

/** 2-up poster grid used by explore, saved and tag pages. */
export default function GameGrid({ games, emptyMessage = 'Nothing here yet.' }: Props) {
  if (games.length === 0) {
    return <div style={{ opacity: 0.6, fontSize: 14, padding: '8px 2px' }}>{emptyMessage}</div>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, padding: '0 12px' }}>
      {games.map((game) => (
        <Link
          key={game.id}
          href={`/g/${game.id}`}
          style={{
            textDecoration: 'none',
            color: '#fff',
            borderRadius: 14,
            overflow: 'hidden',
            background: 'linear-gradient(160deg,#1b2340,#0e0f16)',
            border: '1px solid rgba(255,255,255,0.07)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 150,
          }}
        >
          <div
            style={{
              aspectRatio: '3 / 4',
              display: 'grid',
              placeItems: 'center',
              background: 'radial-gradient(120% 90% at 50% 0%, #2a2350 0%, #0d0e14 70%)',
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: 1,
              color: 'rgba(255,255,255,0.75)',
            }}
          >
            {initials(game.title)}
          </div>
          <div style={{ padding: '8px 10px 10px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{game.title}</div>
            <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>@{game.creatorHandle}</div>
            <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>
              ♥ {game.counts.likes} · ▶ {game.counts.plays}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
