'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type MiniGame } from '../lib/client-api';
import GameGrid from './GameGrid';

type SearchResponse = {
  games: MiniGame[];
  creators: Array<{ id: string; handle: string; displayName: string | null }>;
  tags: Array<{ tag: string; count: number }>;
  q: string;
  tag: string;
};

type Props = {
  /** Fixed tag (from /t/[tag]); hides the search box hero copy. */
  initialTag?: string;
  initialQuery?: string;
};

/** Discovery: search games and creators, browse tags. */
export default function ExploreScreen({ initialTag = '', initialQuery = '' }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);
  const [tag, setTag] = useState(initialTag);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const { data, isLoading, isError, refetch } = useQuery<SearchResponse>({
    queryKey: ['search', debounced, tag],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debounced) params.set('q', debounced);
      if (tag) params.set('tag', tag);
      return api.get<SearchResponse>(`/api/search?${params.toString()}`);
    },
    staleTime: 20_000,
  });

  const games = data?.games ?? [];
  const creators = data?.creators ?? [];
  const tags = data?.tags ?? [];

  return (
    <div>
      <div style={{ padding: '0 12px 12px' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search games, tags, creators"
          aria-label="Search"
          style={{
            width: '100%',
            minHeight: 46,
            borderRadius: 23,
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'rgba(255,255,255,0.06)',
            color: '#fff',
            fontSize: 15,
            padding: '0 16px',
            boxSizing: 'border-box',
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingTop: 10, paddingBottom: 2, scrollbarWidth: 'none' }}>
          <button
            type="button"
            onClick={() => setTag('')}
            style={{
              flexShrink: 0,
              minHeight: 32,
              padding: '0 14px',
              borderRadius: 16,
              border: 'none',
              background: tag === '' ? '#fff' : 'rgba(255,255,255,0.1)',
              color: tag === '' ? '#0b0b10' : '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            All
          </button>
          {tags.map((t) => (
            <button
              key={t.tag}
              type="button"
              onClick={() => setTag(t.tag === tag ? '' : t.tag)}
              style={{
                flexShrink: 0,
                minHeight: 32,
                padding: '0 14px',
                borderRadius: 16,
                border: 'none',
                background: t.tag === tag ? '#fff' : 'rgba(255,255,255,0.1)',
                color: t.tag === tag ? '#0b0b10' : '#fff',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              #{t.tag}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div style={{ padding: '0 12px', opacity: 0.6, fontSize: 14 }}>Searching…</div>
      ) : isError ? (
        <div style={{ padding: '0 12px' }}>
          <button type="button" onClick={() => refetch()} style={{ background: 'none', border: 'none', color: '#8ab4ff', fontSize: 14, padding: 0, cursor: 'pointer' }}>
            Search failed — retry
          </button>
        </div>
      ) : (
        <>
          {creators.length > 0 ? (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, opacity: 0.6, padding: '0 12px 8px', textTransform: 'uppercase', letterSpacing: 0.6 }}>Creators</div>
              <div style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '0 12px 4px', scrollbarWidth: 'none' }}>
                {creators.map((creator) => (
                  <Link
                    key={creator.id}
                    href={`/u/${creator.handle}`}
                    style={{
                      flexShrink: 0,
                      width: 92,
                      textDecoration: 'none',
                      color: '#fff',
                      background: 'rgba(255,255,255,0.06)',
                      borderRadius: 14,
                      padding: '12px 8px',
                      textAlign: 'center',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        margin: '0 auto 8px',
                        background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
                        display: 'grid',
                        placeItems: 'center',
                        fontWeight: 700,
                      }}
                    >
                      {creator.handle.slice(0, 1).toUpperCase()}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      @{creator.handle}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ fontSize: 13, opacity: 0.6, padding: '0 12px 8px', textTransform: 'uppercase', letterSpacing: 0.6 }}>
            {tag ? `#${tag}` : debounced ? `Results for “${debounced}”` : 'New games'}
          </div>
          <GameGrid games={games} emptyMessage="No games match yet. Try another tag." />
        </>
      )}
    </div>
  );
}
