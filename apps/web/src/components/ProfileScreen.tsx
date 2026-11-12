'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { BottomNav, TopBar } from './AppNav';

type ProfileGame = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  counts: { likes: number; saves: number; comments: number; plays: number; remixes: number };
  artifactUrl: string | null;
  posterUrl: string | null;
  forkedFrom: { id: string; title: string } | null;
};

type ProfileData = {
  user: { id: string; handle: string; displayName: string | null; avatarUrl: string | null; bio: string | null };
  counts: { followers: number; following: number; games: number };
  viewer: { following: boolean; isSelf: boolean };
  games: ProfileGame[];
};

async function fetchProfile(handle: string): Promise<ProfileData> {
  const res = await fetch(`/api/users/${encodeURIComponent(handle)}`);
  // Parse only after the status is known: a proxy error page is HTML, and
  // `res.json()` on it threw "Unexpected token '<'" at the user.
  if (res.status === 404) throw new ProfileError('not_found', 'No such creator.');
  if (!res.ok) throw new ProfileError('unavailable', 'Couldn’t load this profile.');
  const body = (await res.json()) as { data?: ProfileData; error?: { message?: string } };
  if (!body.data) throw new ProfileError('unavailable', body.error?.message ?? 'Couldn’t load this profile.');
  return body.data;
}

class ProfileError extends Error {
  constructor(public code: 'not_found' | 'unavailable', message: string) {
    super(message);
  }
}

/** Mobile-first creator profile: header, follow CTA, remix-aware game grid. */
export function ProfileScreen({ handle }: { handle: string }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['profile', handle],
    queryFn: () => fetchProfile(handle),
    retry: (count, err) => !(err instanceof ProfileError && err.code === 'not_found') && count < 2,
  });
  const [following, setFollowing] = useState<boolean | null>(null);
  const [followBusy, setFollowBusy] = useState(false);

  const isFollowing = following ?? data?.viewer.following ?? false;

  const toggleFollow = async () => {
    if (!data || followBusy) return;
    setFollowBusy(true);
    const next = !isFollowing;
    setFollowing(next); // optimistic
    try {
      const res = await fetch(`/api/users/${data.user.id}/follow`, { method: next ? 'POST' : 'DELETE' });
      if (!res.ok) throw new Error('follow failed');
    } catch {
      setFollowing(!next); // rollback
    } finally {
      setFollowBusy(false);
    }
  };

  if (isLoading) {
    return (
      <main style={{ minHeight: '100dvh', background: '#0b0b10', color: '#fff', padding: 24 }}>
        <div style={{ width: 240, height: 22, borderRadius: 6, background: 'rgba(255,255,255,0.14)' }} />
        <div style={{ width: 320, height: 16, borderRadius: 6, background: 'rgba(255,255,255,0.10)', marginTop: 10 }} />
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main style={{ minHeight: '100dvh', background: '#0b0b10', color: '#fff', display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {(error as ProfileError | null)?.code === 'not_found' ? 'Profile not found' : 'Couldn’t load this profile'}
          </div>
          <p style={{ marginTop: 6, fontSize: 14, opacity: 0.7 }}>
            {(error as ProfileError | null)?.code === 'not_found'
              ? 'That creator does not exist — the link may be old.'
              : 'Check your connection and try again.'}
          </p>
          <button
            type="button"
            onClick={() => refetch()}
            style={{ marginTop: 16, minWidth: 120, minHeight: 48, borderRadius: 24, border: 'none', background: '#fff', color: '#0b0b10', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: '#0b0b10',
        color: '#fff',
        maxWidth: 560,
        margin: '0 auto',
        paddingTop: 'calc(48px + env(safe-area-inset-top, 0px))',
        paddingBottom: 'calc(56px + env(safe-area-inset-bottom, 0px) + 24px)',
      }}
    >
      <TopBar title={`@${data.user.handle}`} />
      {/* Header */}
      <header
        style={{
          padding: '16px 16px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 36,
              background: 'linear-gradient(140deg, #6366f1, #ec4899)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
              fontWeight: 800,
              flexShrink: 0,
            }}
            aria-hidden
          >
            {data.user.handle.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {data.user.displayName ?? data.user.handle}
            </div>
            <div style={{ fontSize: 14, opacity: 0.7 }}>@{data.user.handle}</div>
          </div>
        </div>

        {data.user.bio ? <p style={{ fontSize: 14, opacity: 0.85, margin: 0, lineHeight: 1.5 }}>{data.user.bio}</p> : null}

        {data.viewer.isSelf ? (
          <button
            type="button"
            onClick={async () => {
              const { signOut } = await import('next-auth/react');
              await signOut({ redirect: false });
              window.location.href = '/';
            }}
            style={{
              alignSelf: 'flex-start',
              minHeight: 36,
              padding: '0 14px',
              borderRadius: 18,
              border: '1px solid rgba(255,255,255,0.16)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.7)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Sign out
          </button>
        ) : null}

        {/* Counts */}
        <div style={{ display: 'flex', gap: 20 }}>
          {[
            ['games', data.counts.games],
            ['followers', data.counts.followers],
            ['following', data.counts.following],
          ].map(([label, n]) => (
            <div key={String(label)} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{n}</div>
              <div style={{ fontSize: 12, opacity: 0.65 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Follow / own-profile CTAs */}
        {data.viewer.isSelf ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <Link
              href="/studio"
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 48,
                borderRadius: 24,
                background: 'linear-gradient(90deg, #6366f1, #ec4899)',
                color: '#fff',
                fontSize: 15,
                fontWeight: 700,
                textDecoration: 'none',
              }}
            >
              ✨ Create a game
            </Link>
            <Link
              href="/saved"
              aria-label="Saved games"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 48,
                minHeight: 48,
                borderRadius: 24,
                background: 'rgba(255,255,255,0.12)',
                color: '#fff',
                textDecoration: 'none',
                fontSize: 18,
              }}
            >
              🔖
            </Link>
          </div>
        ) : (
          <button
            type="button"
            onClick={toggleFollow}
            disabled={followBusy}
            style={{
              minHeight: 48,
              borderRadius: 24,
              border: 'none',
              background: isFollowing ? 'rgba(255,255,255,0.12)' : 'linear-gradient(90deg, #6366f1, #ec4899)',
              color: '#fff',
              fontSize: 15,
              fontWeight: 700,
              cursor: 'pointer',
              opacity: followBusy ? 0.6 : 1,
            }}
          >
            {isFollowing ? '✓ Following' : '+ Follow'}
          </button>
        )}
      </header>

      {/* Game grid */}
      <section style={{ padding: '8px 16px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        {data.games.map((game) => (
          <Link
            key={game.id}
            href={`/g/${game.id}`}
            style={{
              background: 'rgba(255,255,255,0.06)',
              borderRadius: 14,
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#fff',
              textDecoration: 'none',
            }}
          >
            <div
              style={{
                aspectRatio: '9 / 12',
                background: 'linear-gradient(160deg, #17203a 0%, #0b0b10 80%)',
                display: 'flex',
                alignItems: 'flex-end',
                padding: 10,
                boxSizing: 'border-box',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{game.title}</div>
            </div>
            <div style={{ padding: '8px 10px 10px' }}>
              {game.forkedFrom ? (
                <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 4 }}>🔁 remix of {game.forkedFrom.title}</div>
              ) : null}
              <div style={{ display: 'flex', gap: 10, fontSize: 11, opacity: 0.7 }}>
                <span>♥ {game.counts.likes}</span>
                <span>▶ {game.counts.plays}</span>
                <span>🔁 {game.counts.remixes}</span>
              </div>
            </div>
          </Link>
        ))}
        {data.games.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '32px 0', opacity: 0.6, fontSize: 14 }}>
            No published games yet.
          </div>
        ) : null}
      </section>
      <BottomNav />
    </main>
  );
}
