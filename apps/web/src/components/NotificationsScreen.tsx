'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import Link from 'next/link';
import { api, RequestError } from '../lib/client-api';

type NotificationRow = {
  id: string;
  type: string;
  actorId: string | null;
  gameId: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
};

const COPY: Record<string, string> = {
  like: 'liked your game',
  comment: 'commented on your game',
  follow: 'started following you',
  remix: 'remixed your game',
  system: 'sent you a message',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function NotificationsScreen() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: NotificationRow[]; unread: number }>('/api/notifications'),
    retry: false,
  });

  // Opening the tab is the acknowledgement: mark everything read so the badge
  // can actually clear (nothing used to call this endpoint).
  const unread = data?.unread ?? 0;
  useEffect(() => {
    if (unread === 0) return;
    void api
      .post('/api/notifications/read', { all: true })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['notifications'] });
        void queryClient.invalidateQueries({ queryKey: ['me'] });
      })
      .catch(() => {});
  }, [unread, queryClient]);

  if (isLoading) return <div style={{ padding: '0 12px', opacity: 0.6, fontSize: 14 }}>Loading…</div>;

  if (isError && error instanceof RequestError && error.status === 401) {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Sign in to see notifications</div>
        <Link href="/login?next=/notifications" style={{ display: 'inline-block', marginTop: 14, padding: '12px 20px', borderRadius: 24, background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)', color: '#fff', textDecoration: 'none', fontWeight: 700, fontSize: 14 }}>
          Sign in
        </Link>
      </div>
    );
  }

  if (isError) {
    return (
      <div style={{ padding: '0 12px' }}>
        <button type="button" onClick={() => refetch()} style={{ background: 'none', border: 'none', color: '#8ab4ff', fontSize: 14, padding: 0, cursor: 'pointer' }}>
          Could not load notifications — retry
        </button>
      </div>
    );
  }

  const items = data?.items ?? [];

  if (items.length === 0) {
    return <div style={{ padding: '0 12px', opacity: 0.65, fontSize: 14 }}>No notifications yet. Likes, comments and new followers show up here.</div>;
  }

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((n) => {
        const actor = typeof n.data?.actorHandle === 'string' ? n.data.actorHandle : null;
        const title = typeof n.data?.gameTitle === 'string' ? n.data.gameTitle : null;
        return (
          <li
            key={n.id}
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              padding: '12px 14px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              background: n.readAt ? 'transparent' : 'rgba(123,92,255,0.10)',
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
                display: 'grid',
                placeItems: 'center',
                fontWeight: 700,
                fontSize: 13,
                flexShrink: 0,
              }}
            >
              {(actor ?? 'P').slice(0, 1).toUpperCase()}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, lineHeight: '19px' }}>
                {actor ? (
                  <Link href={`/u/${actor}`} style={{ color: '#fff', fontWeight: 700, textDecoration: 'none' }}>
                    @{actor}
                  </Link>
                ) : (
                  <span style={{ fontWeight: 700 }}>PlayLoop</span>
                )}{' '}
                {COPY[n.type] ?? n.type}
                {title ? <span style={{ opacity: 0.8 }}> · {title}</span> : null}
              </div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>{timeAgo(n.createdAt)}</div>
            </div>
            {n.gameId ? (
              <Link href={`/g/${n.gameId}`} style={{ color: '#8ab4ff', fontSize: 12, textDecoration: 'none', flexShrink: 0 }}>
                Open
              </Link>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
