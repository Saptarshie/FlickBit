'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GameHost, type GameHostError } from '@playloop/sdk';
import type { GameCard } from '../lib/feed';
import { useFeedStore } from '../lib/feed-store';
import { api, RequestError } from '../lib/client-api';
import CommentsSheet from './CommentsSheet';
import { chromeBottom } from './AppNav';

type Props = {
  card: GameCard;
  /** True for the active card and its immediate neighbours (iframe allowed). */
  live: boolean;
  isActive: boolean;
  onNext: () => void;
  onPrev: () => void;
};

const RAIL_BUTTON: CSSProperties = {
  width: 46,
  height: 46,
  minWidth: 46,
  minHeight: 46,
  borderRadius: 23,
  border: 'none',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,0.42)',
  color: '#fff',
  cursor: 'pointer',
  backdropFilter: 'blur(6px)',
  WebkitTapHighlightColor: 'transparent',
};

const RAIL_LABEL: CSSProperties = {
  fontSize: 11,
  lineHeight: '14px',
  color: '#fff',
  textAlign: 'center',
  marginTop: 2,
  textShadow: '0 1px 2px rgba(0,0,0,0.7)',
};

function Icon({ path, filled }: { path: string; filled?: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.8} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const ICONS = {
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  comment: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z',
  bookmark: 'M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z',
  remix: 'M12 4V1L8 5l4 4V6a6 6 0 0 1 5.6 8.1l2.2.9A8 8 0 0 0 12 4zm0 14a6 6 0 0 1-5.6-8.1l-2.2-.9A8 8 0 0 0 12 20v3l4-4-4-4v3z',
  share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 1 0-3-3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9a3 3 0 1 0 0 6c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65a2.92 2.92 0 1 0 2.92-2.92z',
  chevronUp: 'M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z',
  chevronDown: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  replay: 'M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z',
} as const;

/** Vertical travel (px) before a drag is treated as a feed scroll, not a game gesture. */
const SCROLL_THRESHOLD = 34;
/** Ignore wheel bursts for this long after one card change. */
const WHEEL_COOLDOWN_MS = 380;

export default function GameCardView({ card, live, isActive, onNext, onPrev }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<GameHost | null>(null);
  const isActiveRef = useRef(isActive);
  const gameOverRef = useRef(false);

  const [gameOver, setGameOver] = useState(false);
  const [liked, setLiked] = useState(card.viewer.liked);
  const [likeCount, setLikeCount] = useState(card.counts.likes);
  const [saved, setSaved] = useState(card.viewer.saved);
  const [follows, setFollows] = useState(card.viewer.followsCreator);
  const [commentCount, setCommentCount] = useState(card.counts.comments);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [loadIssue, setLoadIssue] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  const isPlaying = useFeedStore((s) => s.isPlaying);
  const muted = useFeedStore((s) => s.muted);
  const audioUnlocked = useFeedStore((s) => s.audioUnlocked);

  isActiveRef.current = isActive;
  gameOverRef.current = gameOver;

  const handleAuthError = useCallback(
    (err: unknown) => {
      if (err instanceof RequestError && err.status === 401) {
        router.push(`/login?next=${encodeURIComponent('/')}`);
        return true;
      }
      return false;
    },
    [router],
  );

  const likeMutation = useMutation({
    mutationFn: (next: boolean) => (next ? api.post(`/api/games/${card.id}/like`) : api.del(`/api/games/${card.id}/like`)),
    onError: (err, next) => {
      setLiked(!next);
      setLikeCount((c) => Math.max(0, c + (next ? -1 : 1)));
      handleAuthError(err);
    },
  });

  const saveMutation = useMutation({
    mutationFn: (next: boolean) => (next ? api.post(`/api/games/${card.id}/save`) : api.del(`/api/games/${card.id}/save`)),
    onError: (err, next) => {
      setSaved(!next);
      handleAuthError(err);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['saved'] }),
  });

  const followMutation = useMutation({
    mutationFn: (next: boolean) =>
      next ? api.post(`/api/users/${card.creator.id}/follow`) : api.del(`/api/users/${card.creator.id}/follow`),
    onError: (err, next) => {
      setFollows(!next);
      handleAuthError(err);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profile', card.creator.handle] }),
  });

  const toggleLike = () => {
    const next = !liked;
    setLiked(next);
    setLikeCount((c) => Math.max(0, c + (next ? 1 : -1)));
    likeMutation.mutate(next);
  };

  const toggleSave = () => {
    const next = !saved;
    setSaved(next);
    saveMutation.mutate(next);
  };

  const toggleFollow = () => {
    const next = !follows;
    setFollows(next);
    followMutation.mutate(next);
  };

  const share = async () => {
    const url = `${window.location.origin}/g/${card.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: card.title, text: card.description, url });
        return;
      }
    } catch {
      /* user cancelled */
    }
    try {
      await navigator.clipboard.writeText(url);
      setLoadIssue('Link copied');
      setTimeout(() => setLoadIssue(null), 1600);
    } catch {
      router.push(`/g/${card.id}`);
    }
  };

  /** Single source of truth for pause/resume: active + playing. Audio stays
   *  locked until the first tap (browser policy) but the game itself runs right
   *  away — a Reels feed never shows a poster waiting for a gesture. */
  const syncPlayback = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = useFeedStore.getState();
    const hidden = typeof document !== 'undefined' && document.hidden;
    const shouldPlay = isActiveRef.current && state.isPlaying && !gameOverRef.current && !hidden;
    if (shouldPlay) host.resume();
    else host.pause();
  }, []);

  // Create/destroy the GameHost with the iframe (only while the card is live).
  useEffect(() => {
    if (!live) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const host = new GameHost(iframe, {
      onReady: () => {
        setLoadIssue(null);
        syncPlayback();
      },
      onGameOver: () => {
        gameOverRef.current = true;
        setGameOver(true);
        hostRef.current?.pause();
      },
      onError: (error: GameHostError) => {
        // A handshake timeout is NOT fatal: games can take seconds to boot.
        // Never auto-skip a game the viewer is watching — offer Retry instead.
        if (error.code === 'timeout') setLoadIssue('Still loading…');
        else setLoadIssue('Game error');
      },
    });
    hostRef.current = host;
    syncPlayback();

    return () => {
      host.destroy();
      hostRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, card.artifactUrl, frameKey]);

  // Re-drive playback whenever the view state changes.
  useEffect(() => {
    syncPlayback();
  }, [live, isActive, isPlaying, audioUnlocked, gameOver, syncPlayback]);

  // Mute follows the global toggle.
  useEffect(() => {
    if (!live) return;
    hostRef.current?.mute(muted);
  }, [live, muted]);

  useEffect(() => {
    const onVisibility = () => syncPlayback();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [syncPlayback]);

  /* ------------------------------------------------------------------ */
  /* Gesture layer: vertical swipes scroll the feed; taps and other      */
  /* drags are replayed inside the sandboxed game as real pointer events.*/
  /* ------------------------------------------------------------------ */

  const gesture = useRef({
    active: false,
    startX: 0,
    startY: 0,
    mode: 'undecided' as 'undecided' | 'scroll' | 'game',
    moved: false,
    lastWheel: 0,
  });

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isActive) return;
    gesture.current = {
      ...gesture.current,
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      mode: 'undecided',
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.active) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) g.moved = true;

    if (g.mode === 'undecided') {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx) * 1.15) {
        g.mode = 'scroll';
      } else if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        g.mode = 'game';
        hostRef.current?.input('down', g.startX, g.startY);
      } else {
        return;
      }
    }
    if (g.mode === 'game') hostRef.current?.input('move', event.clientX, event.clientY);
  };

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.active) return;
    g.active = false;
    const dy = event.clientY - g.startY;

    if (g.mode === 'scroll') {
      if (dy <= -SCROLL_THRESHOLD) onNext();
      else if (dy >= SCROLL_THRESHOLD) onPrev();
      return;
    }
    if (g.mode === 'game') {
      hostRef.current?.input('up', event.clientX, event.clientY);
      return;
    }
    if (!g.moved) {
      // A tap unlocks audio (first gesture) and is replayed inside the game.
      const state = useFeedStore.getState();
      if (!state.audioUnlocked) state.unlockAudio();
      if (!state.isPlaying) state.setPlaying(true);
      hostRef.current?.input('tap', event.clientX, event.clientY);
      syncPlayback();
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const now = Date.now();
    if (now - gesture.current.lastWheel < WHEEL_COOLDOWN_MS) return;
    if (Math.abs(event.deltaY) < 18) return;
    gesture.current.lastWheel = now;
    if (event.deltaY > 0) onNext();
    else onPrev();
  };

  const retryFrame = () => {
    setLoadIssue(null);
    setGameOver(false);
    gameOverRef.current = false;
    setFrameKey((k) => k + 1);
  };

  if (!live) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(160deg, #17203a 0%, #0b0b10 70%)',
          display: 'flex',
          alignItems: 'flex-end',
          padding: '16px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)',
          boxSizing: 'border-box',
        }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{card.title}</div>
          <div style={{ fontSize: 14, opacity: 0.7, marginTop: 4 }}>@{card.creator.handle}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000', userSelect: 'none', WebkitTouchCallout: 'none' }}>
      {/* Backdrop behind the iframe: until the game paints you see its cover,
          never a black void. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(120% 80% at 50% 0%, #1d2547 0%, #0b0b10 68%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: loadIssue ? 1 : 0.9,
          zIndex: 0,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.3 }}>{card.title}</div>
        <div style={{ fontSize: 12, opacity: 0.6 }}>@{card.creator.handle}</div>
      </div>

      <iframe
        key={frameKey}
        ref={iframeRef}
        src={card.artifactUrl}
        title={card.title}
        sandbox="allow-scripts"
        allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"
        referrerPolicy="no-referrer"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', pointerEvents: 'none' }}
      />

      {/* Gesture layer sits above the poster so scroll works immediately; taps
          both unlock audio and are replayed inside the sandboxed game. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onWheel={onWheel}
        style={{ position: 'absolute', inset: 0, zIndex: 2, touchAction: 'pan-x' }}
      />

      {/* Creator row + follow, top of the card. */}
      <div
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 54px)',
          left: 12,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          zIndex: 4,
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
            display: 'grid',
            placeItems: 'center',
            fontWeight: 700,
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          {card.creator.handle.slice(0, 1).toUpperCase()}
        </div>
        <Link
          href={`/u/${card.creator.handle}`}
          style={{ color: '#fff', textDecoration: 'none', fontWeight: 600, fontSize: 14, pointerEvents: 'auto', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}
        >
          @{card.creator.handle}
        </Link>
        <button
          type="button"
          onClick={toggleFollow}
          aria-pressed={follows}
          style={{
            pointerEvents: 'auto',
            border: '1px solid rgba(255,255,255,0.5)',
            background: follows ? 'rgba(255,255,255,0.18)' : 'transparent',
            color: '#fff',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            padding: '5px 12px',
            cursor: 'pointer',
          }}
        >
          {follows ? 'Following' : 'Follow'}
        </button>
      </div>

      {/* Title / description / tags — clear of the bottom nav. */}
      <div
        style={{
          position: 'absolute',
          left: 'calc(env(safe-area-inset-left, 0px) + 12px)',
          right: 74,
          bottom: `calc(${chromeBottom}px + env(safe-area-inset-bottom, 0px) + 10px)`,
          color: '#fff',
          textShadow: '0 1px 3px rgba(0,0,0,0.85)',
          pointerEvents: 'none',
          zIndex: 3,
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700 }}>{card.title}</div>
        <div
          style={{
            fontSize: 13,
            opacity: 0.9,
            marginTop: 3,
            lineHeight: '18px',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {card.description}
        </div>
        {card.forkedFrom ? <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>🔁 remix of {card.forkedFrom.title}</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {card.tags.slice(0, 3).map((tag) => (
            <Link
              key={tag}
              href={`/t/${encodeURIComponent(tag)}`}
              style={{ fontSize: 11, background: 'rgba(255,255,255,0.18)', borderRadius: 999, padding: '3px 9px', color: '#fff', textDecoration: 'none', pointerEvents: 'auto' }}
            >
              #{tag}
            </Link>
          ))}
        </div>
      </div>

      {/* Right rail: thumb zone. */}
      <div
        style={{
          position: 'absolute',
          right: 'calc(env(safe-area-inset-right, 0px) + 8px)',
          bottom: `calc(${chromeBottom}px + env(safe-area-inset-bottom, 0px) + 16px)`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          zIndex: 4,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <button type="button" aria-label="Like" aria-pressed={liked} onClick={toggleLike} style={{ ...RAIL_BUTTON, color: liked ? '#ff4b6e' : '#fff' }}>
            <Icon path={ICONS.heart} filled={liked} />
          </button>
          <div style={RAIL_LABEL}>{likeCount}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <button type="button" aria-label="Comments" onClick={() => setCommentsOpen(true)} style={RAIL_BUTTON}>
            <Icon path={ICONS.comment} />
          </button>
          <div style={RAIL_LABEL}>{commentCount}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <button type="button" aria-label="Save" aria-pressed={saved} onClick={toggleSave} style={{ ...RAIL_BUTTON, color: saved ? '#ffd166' : '#fff' }}>
            <Icon path={ICONS.bookmark} filled={saved} />
          </button>
          <div style={RAIL_LABEL}>{card.counts.saves + (saved && !card.viewer.saved ? 1 : 0)}</div>
        </div>

        <button type="button" aria-label="Share" onClick={share} style={RAIL_BUTTON}>
          <Icon path={ICONS.share} />
        </button>

        <button type="button" aria-label="Remix this game" onClick={() => router.push(`/studio?remix=${card.id}`)} style={RAIL_BUTTON}>
          <Icon path={ICONS.remix} />
        </button>

        <button type="button" aria-label="Previous game" onClick={onPrev} style={RAIL_BUTTON}>
          <Icon path={ICONS.chevronUp} />
        </button>

        <button type="button" aria-label="Next game" onClick={onNext} style={RAIL_BUTTON}>
          <Icon path={ICONS.chevronDown} />
        </button>
      </div>

      {/* Non-blocking status chip with Retry — never auto-skips. */}
      {loadIssue ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0px) + 100px)',
            left: 12,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            zIndex: 5,
          }}
        >
          <span style={{ background: 'rgba(0,0,0,0.66)', color: '#fff', fontSize: 12, borderRadius: 8, padding: '6px 10px' }}>
            {loadIssue}
          </span>
          <button
            type="button"
            onClick={retryFrame}
            style={{ border: 'none', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 700, background: '#fff', color: '#0b0b10', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Game over: Replay + Next. */}
      {gameOver ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            zIndex: 6,
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700 }}>Game over</div>
          <button
            type="button"
            onClick={() => {
              gameOverRef.current = false;
              setGameOver(false);
              useFeedStore.getState().setPlaying(true);
              setFrameKey((k) => k + 1);
            }}
            style={{ ...RAIL_BUTTON, width: 150, height: 48, borderRadius: 24, fontSize: 16, fontWeight: 700, background: '#fff', color: '#0b0b10', gap: 8 }}
          >
            <Icon path={ICONS.replay} filled /> Replay
          </button>
          <button
            type="button"
            onClick={onNext}
            style={{ ...RAIL_BUTTON, width: 150, height: 48, borderRadius: 24, fontSize: 16, fontWeight: 700, background: 'rgba(255,255,255,0.2)', color: '#fff', gap: 8 }}
          >
            Next <Icon path={ICONS.chevronDown} />
          </button>
        </div>
      ) : !isPlaying ? (
        <button
          type="button"
          onClick={() => {
            useFeedStore.getState().setPlaying(true);
            syncPlayback();
          }}
          aria-label={`Resume ${card.title}`}
          style={{ position: 'absolute', inset: 0, border: 'none', background: 'rgba(0,0,0,0.3)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 1, pointerEvents: 'none' }}
        >
          <div style={{ ...RAIL_BUTTON, width: 68, height: 68, borderRadius: 34, background: 'rgba(255,255,255,0.22)' }}>
            <Icon path={ICONS.play} filled />
          </div>
        </button>
      ) : null}

      <CommentsSheet gameId={card.id} open={commentsOpen} onClose={() => setCommentsOpen(false)} onCountChange={setCommentCount} />
    </div>
  );
}
