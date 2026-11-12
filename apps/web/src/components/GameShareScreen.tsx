'use client';

import { SHIM_VERSION } from '@playloop/sdk';
import { artifactSrc } from '../lib/artifact-url';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import CommentsSheet from './CommentsSheet';
import { BottomNav } from './AppNav';
import { api } from '../lib/client-api';

type ShareGame = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  counts: { likes: number; saves: number; comments: number; plays: number; remixes: number };
  creator: { id: string; handle: string; displayName: string | null };
  artifactUrl: string | null;
  posterUrl: string | null;
  forkedFrom: { id: string; title: string } | null;
  viewer: { liked: boolean; saved: boolean; followsCreator: boolean };
};

/**
 * Share / detail page shell: a 9:16 playable frame with a tap-to-play overlay
 * (audio needs a gesture), creator + provenance block, and remix CTA.
 * The iframe keeps the same sandbox as the feed: allow-scripts only.
 */
export function GameShareScreen({ game }: { game: ShareGame }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [started, setStarted] = useState(false);

  // A shared link is where most first-time visitors land, so it needs the same
  // actions as the feed card — it used to offer only Remix and Report.
  const [liked, setLiked] = useState(game.viewer.liked);
  const [likeCount, setLikeCount] = useState(game.counts.likes);
  const [saved, setSaved] = useState(game.viewer.saved);
  const [saveCount, setSaveCount] = useState(game.counts.saves);
  const [commentCount, setCommentCount] = useState(game.counts.comments);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2200);
  };

  const likeMutation = useMutation({
    mutationFn: (next: boolean) =>
      next ? api.post(`/api/games/${game.id}/like`) : api.del(`/api/games/${game.id}/like`),
    onMutate: (next: boolean) => {
      setLiked(next);
      setLikeCount((c) => Math.max(0, c + (next ? 1 : -1)));
    },
    onError: (_err, next: boolean) => {
      setLiked(!next);
      setLikeCount((c) => Math.max(0, c + (next ? -1 : 1)));
      flash('Sign in to like this game');
    },
  });

  const readyRef = useRef(false);
  const pendingStartRef = useRef(false);
  const startTimerRef = useRef<number | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [loadIssue, setLoadIssue] = useState<string | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { src?: string; type?: string } | null;
      if (!data || data.src !== 'playloop') return;
      if (data.type === 'ready') {
        readyRef.current = true;
        if (startTimerRef.current) {
          window.clearTimeout(startTimerRef.current);
          startTimerRef.current = null;
        }
        setLoadIssue(null);
        if (pendingStartRef.current) {
          pendingStartRef.current = false;
          resumeGuest();
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (startTimerRef.current) window.clearTimeout(startTimerRef.current);
    };
  }, []);

  const saveMutation = useMutation({
    mutationFn: (next: boolean) =>
      next ? api.post(`/api/games/${game.id}/save`) : api.del(`/api/games/${game.id}/save`),
    onMutate: (next: boolean) => {
      setSaved(next);
      setSaveCount((c) => Math.max(0, c + (next ? 1 : -1)));
    },
    onError: (_err, next: boolean) => {
      setSaved(!next);
      setSaveCount((c) => Math.max(0, c + (next ? -1 : 1)));
      flash('Sign in to save this game');
    },
  });

  const share = async () => {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    try {
      if (navigator.share) await navigator.share({ title: game.title, url });
      else {
        await navigator.clipboard.writeText(url);
        flash('Link copied');
      }
    } catch (err) {
      // Cancelling the native sheet is not a failure.
      if ((err as { name?: string })?.name === 'AbortError') return;
      flash('Could not share');
    }
  };

  /**
   * The guest posts `ready` when its shim is live. Until then a `resume` goes
   * nowhere, so the old code could hand the visitor a dead black frame with no
   * way back — on the main inbound landing page.
   */
  const resumeGuest = () => {
    iframeRef.current?.contentWindow?.postMessage({ src: 'playloop', type: 'resume' }, '*');
  };

  const start = () => {
    setStarted(true);
    setLoadIssue(null);
    if (readyRef.current) {
      resumeGuest();
      return;
    }
    pendingStartRef.current = true;
    startTimerRef.current = window.setTimeout(() => {
      setLoadIssue('This game did not start. It may be offline or still building.');
    }, 10_000);
  };

  const retry = () => {
    if (startTimerRef.current) window.clearTimeout(startTimerRef.current);
    readyRef.current = false;
    pendingStartRef.current = false;
    setLoadIssue(null);
    setStarted(false);
    setFrameKey((k) => k + 1);
  };

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: '#0b0b10',
        color: '#fff',
        maxWidth: 480,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
      }}
    >
      {/* 9:16 game frame */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '9 / 16', maxHeight: '80dvh', background: '#000', overflow: 'hidden' }}>
        {game.artifactUrl ? (
          <iframe
            key={frameKey}
            ref={iframeRef}
            src={artifactSrc(game.artifactUrl, SHIM_VERSION)}
            title={game.title}
            sandbox="allow-scripts"
            allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"
            referrerPolicy="no-referrer"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              border: 'none',
              // Before play the page must scroll (a shared link was unscrollable
              // because the iframe swallowed every drag); after the tap the game
              // owns touch so in-game gestures work.
              touchAction: started ? 'none' : 'pan-y',
            }}
          />
        ) : null}
        {loadIssue ? (
          <div
            role="alert"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              padding: 24,
              textAlign: 'center',
              background: 'rgba(11,11,16,0.92)',
              color: '#f5f5f5',
            }}
          >
            <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>This game would not load</p>
            <p style={{ fontSize: 13, color: '#a3a3a3', margin: 0, lineHeight: 1.5 }}>{loadIssue}</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={retry}
                style={{
                  minHeight: 48,
                  padding: '0 18px',
                  borderRadius: 12,
                  border: 'none',
                  background: '#10b981',
                  color: '#04110c',
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                Try again
              </button>
              <a
                href="/"
                style={{
                  minHeight: 48,
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '0 18px',
                  borderRadius: 12,
                  background: '#262626',
                  color: '#f5f5f5',
                  fontSize: 14,
                  textDecoration: 'none',
                }}
              >
                More games
              </a>
            </div>
          </div>
        ) : null}

        {!started ? (
          <button
            type="button"
            onClick={start}
            aria-label={`Tap to play ${game.title}`}
            style={{
              position: 'absolute',
              inset: 0,
              border: 'none',
              background: 'linear-gradient(160deg, rgba(23,32,58,0.92) 0%, rgba(11,11,16,0.88) 70%)',
              color: '#fff',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              cursor: 'pointer',
            }}
          >
            <div style={{ width: 72, height: 72, borderRadius: 36, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
              ▶
            </div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{game.title}</div>
            <div style={{ fontSize: 14, opacity: 0.85 }}>Tap to play</div>
          </button>
        ) : null}
      </div>

      {/* Actions: the same social surface as a feed card. */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 16px 0' }}>
        {[
          {
            key: 'like',
            label: liked ? '♥' : '♡',
            text: String(likeCount),
            active: liked,
            onClick: () => likeMutation.mutate(!liked),
            aria: liked ? 'Unlike' : 'Like',
          },
          {
            key: 'comment',
            label: '💬',
            text: String(commentCount),
            active: false,
            onClick: () => setCommentsOpen(true),
            aria: 'Comments',
          },
          {
            key: 'save',
            label: saved ? '🔖' : '📑',
            text: String(saveCount),
            active: saved,
            onClick: () => saveMutation.mutate(!saved),
            aria: saved ? 'Remove from saved' : 'Save',
          },
        ].map((action) => (
          <button
            key={action.key}
            type="button"
            aria-label={action.aria}
            onClick={action.onClick}
            style={{
              minHeight: 48,
              minWidth: 64,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '0 14px',
              borderRadius: 24,
              border: '1px solid rgba(255,255,255,0.14)',
              background: action.active ? 'rgba(255,59,141,0.18)' : 'rgba(255,255,255,0.06)',
              color: '#fff',
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            <span aria-hidden>{action.label}</span>
            <span style={{ fontSize: 13, opacity: 0.8 }}>{action.text}</span>
          </button>
        ))}
        <button
          type="button"
          aria-label="Share this game"
          onClick={share}
          style={{
            minHeight: 48,
            minWidth: 48,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 24,
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'rgba(255,255,255,0.06)',
            color: '#fff',
            fontSize: 15,
            cursor: 'pointer',
          }}
        >
          ↗
        </button>
      </div>

      {notice ? (
        <div role="status" style={{ padding: '8px 16px 0', fontSize: 12, color: '#ffb3c9' }}>
          {notice}
        </div>
      ) : null}

      {/* Meta block */}
      <section style={{ padding: '16px 16px 8px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>{game.title}</h1>
        <p style={{ fontSize: 14, opacity: 0.85, margin: '6px 0 0', lineHeight: 1.5 }}>{game.description}</p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {game.tags.map((tag) => (
            <span key={tag} style={{ fontSize: 12, background: 'rgba(255,255,255,0.12)', borderRadius: 999, padding: '3px 10px' }}>
              #{tag}
            </span>
          ))}
        </div>

        {game.forkedFrom ? (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 10 }}>
            🔁 remix of <Link href={`/g/${game.forkedFrom.id}`} style={{ color: '#fff', textDecoration: 'underline' }}>{game.forkedFrom.title}</Link>
          </div>
        ) : null}

        {/* Counts */}
        <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 13, opacity: 0.8 }}>
          <span>♥ {game.counts.likes}</span>
          <span>▶ {game.counts.plays}</span>
          <span>💬 {game.counts.comments}</span>
          <span>🔁 {game.counts.remixes}</span>
        </div>
      </section>

      {/* Creator + actions */}
      <section style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <a
          href={`/u/${game.creator.handle}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flex: 1,
            minWidth: 0,
            textDecoration: 'none',
            color: '#fff',
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              background: 'linear-gradient(140deg, #6366f1, #ec4899)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              flexShrink: 0,
            }}
            aria-hidden
          >
            {game.creator.handle.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {game.creator.displayName ?? game.creator.handle}
            </div>
            <div style={{ fontSize: 12, opacity: 0.65 }}>@{game.creator.handle}</div>
          </div>
        </a>

        <Link
          href={`/studio?remix=${game.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 48,
            padding: '0 20px',
            borderRadius: 24,
            background: 'linear-gradient(90deg, #6366f1, #ec4899)',
            color: '#fff',
            fontSize: 15,
            fontWeight: 700,
            textDecoration: 'none',
            flexShrink: 0,
          }}
        >
          🔁 Remix
        </Link>
      </section>

      <div style={{ padding: '8px 16px' }}>
        <Link
          href="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 48,
            borderRadius: 24,
            background: 'rgba(255,255,255,0.1)',
            color: '#fff',
            fontSize: 15,
            fontWeight: 700,
            textDecoration: 'none',
          }}
        >
          More games on PlayLoop →
        </Link>
      </div>

      <div style={{ padding: '4px 16px 24px' }}>
        <ReportGame gameId={game.id} />
      </div>

      <CommentsSheet
        gameId={game.id}
        open={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        onCountChange={(count) => setCommentCount(count)}
      />

      <BottomNav />
    </main>
  );
}

/** Report control for the share page (writes a row the moderation queue reads). */
function ReportGame({ gameId }: { gameId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error' | 'auth'>('idle');

  const submit = async () => {
    if (!reason.trim()) return;
    setState('sending');
    try {
      const res = await fetch(`/api/games/${gameId}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (res.status === 401) {
        setState('auth');
        return;
      }
      if (!res.ok) throw new Error('failed');
      setState('sent');
      setOpen(false);
    } catch {
      setState('error');
    }
  };

  if (state === 'sent') {
    return <div style={{ fontSize: 13, opacity: 0.6 }}>Thanks — this game was reported for review.</div>;
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', fontSize: 13, padding: 0, cursor: 'pointer' }}
      >
        ⚑ Report this game
      </button>
      {open ? (
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What's wrong with it?"
            maxLength={200}
            style={{
              flex: 1,
              minHeight: 42,
              borderRadius: 21,
              border: '1px solid rgba(255,255,255,0.16)',
              background: 'rgba(255,255,255,0.06)',
              color: '#fff',
              fontSize: 14,
              padding: '0 14px',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={state === 'sending' || !reason.trim()}
            style={{
              minHeight: 42,
              padding: '0 16px',
              borderRadius: 21,
              border: 'none',
              background: reason.trim() ? '#fff' : 'rgba(255,255,255,0.15)',
              color: reason.trim() ? '#0b0b10' : '#fff',
              fontSize: 14,
              fontWeight: 700,
              cursor: reason.trim() ? 'pointer' : 'default',
            }}
          >
            {state === 'sending' ? '…' : 'Send'}
          </button>
        </div>
      ) : null}
      {state === 'auth' ? (
        <div style={{ fontSize: 12, color: '#ff8fa3', marginTop: 6 }}>
          <a href="/login?next=/" style={{ color: '#8ab4ff' }}>
            Sign in
          </a>{' '}
          to report a game.
        </div>
      ) : null}
      {state === 'error' ? <div style={{ fontSize: 12, color: '#ff8fa3', marginTop: 6 }}>Could not send the report — try again.</div> : null}
    </div>
  );
}
