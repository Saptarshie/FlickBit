'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api, RequestError, type MiniGame } from '../lib/client-api';
import GameGrid from './GameGrid';

/** "Saved" tab: the viewer's bookmarked games. */
export default function SavedScreen() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['saved'],
    queryFn: () => api.get<{ games: MiniGame[] }>('/api/me/saved'),
    retry: false,
  });

  if (isLoading) {
    return <div style={{ padding: '0 12px', opacity: 0.6, fontSize: 14 }}>Loading saved games…</div>;
  }

  if (isError && error instanceof RequestError && error.status === 401) {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Sign in to save games</div>
        <div style={{ opacity: 0.65, fontSize: 14, marginTop: 6 }}>Your saves live with your account.</div>
        <Link
          href="/login?next=/saved"
          style={{
            display: 'inline-block',
            marginTop: 14,
            padding: '12px 20px',
            borderRadius: 24,
            background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
            color: '#fff',
            textDecoration: 'none',
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (isError) {
    return (
      <div style={{ padding: '0 12px' }}>
        <button type="button" onClick={() => refetch()} style={{ background: 'none', border: 'none', color: '#8ab4ff', fontSize: 14, padding: 0, cursor: 'pointer' }}>
          Could not load saves — retry
        </button>
      </div>
    );
  }

  return <GameGrid games={data?.games ?? []} emptyMessage="Nothing saved yet. Tap the bookmark on a game." />;
}
