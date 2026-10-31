'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { GameHost, type GameHostError } from '@playloop/sdk';
import type { GameCard } from '../lib/feed';
import { useFeedStore } from '../lib/feed-store';

type Props = {
  card: GameCard;
  /** True for the active card and its immediate neighbours (iframe allowed). */
  live: boolean;
  isActive: boolean;
  /** Advance to the next card (Next chevron, game-over Next, error skip). */
  onNext: () => void;
};

/** Min touch target per docs (48px used; >= 44px required). */
const RAIL_BUTTON: CSSProperties = {
  width: 48,
  height: 48,
  minWidth: 48,
  minHeight: 48,
  borderRadius: 24,
  border: 'none',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,0.45)',
  color: '#fff',
  cursor: 'pointer',
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
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.8} strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  comment: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z',
  bookmark: 'M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z',
  remix: 'M12 4V1L8 5l4 4V6a6 6 0 0 1 5.6 8.1l2.2.9A8 8 0 0 0 12 4zm0 14a6 6 0 0 1-5.6-8.1l-2.2-.9A8 8 0 0 0 12 20v3l4-4-4-4v3z',
  share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 1 0-3-3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9a3 3 0 1 0 0 6c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65a2.92 2.92 0 1 0 2.92-2.92z',
  chevron: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  replay: 'M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z',
} as const;

/**
 * One full-bleed feed card: sandboxed game iframe driven by GameHost, poster /
 * tap-to-play overlay (audio unlock), thumb-zone right rail, title block that
 * stays clear of the device safe areas (the same insets PlayLoop.safeArea
 * mirrors for the guest), and the game-over Replay/Next actions.
 */
export default function GameCardView({ card, live, isActive, onNext }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<GameHost | null>(null);
  const isActiveRef = useRef(isActive);
  const gameOverRef = useRef(false);
  const errorCountRef = useRef(0);
  const skippedRef = useRef(false);

  const [gameOver, setGameOver] = useState(false);
  const [errored, setErrored] = useState(false);
  const [liked, setLiked] = useState(card.viewer.liked);
  const [saved, setSaved] = useState(card.viewer.saved);
  const [following, setFollowing] = useState(card.viewer.followsCreator);

  const isPlaying = useFeedStore((s) => s.isPlaying);
  const muted = useFeedStore((s) => s.muted);
  const audioUnlocked = useFeedStore((s) => s.audioUnlocked);

  isActiveRef.current = isActive;
  gameOverRef.current = gameOver;

  /** Single source of truth for pause/resume: active + playing + unlocked. */
  const syncPlayback = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = useFeedStore.getState();
    const hidden = typeof document !== 'undefined' && document.hidden;
    const shouldPlay =
      isActiveRef.current && state.isPlaying && state.audioUnlocked && !gameOverRef.current && !hidden;
    if (shouldPlay) host.resume();
    else host.pause();
  }, []);

  const skipAfterError = useCallback(() => {
    if (skippedRef.current || !isActiveRef.current) return;
    skippedRef.current = true;
    console.error('game_error', { gameId: card.id, artifactUrl: card.artifactUrl });
    onNext();
  }, [card.artifactUrl, card.id, onNext]);

  // Create/destroy the GameHost with the iframe (only while the card is live).
  useEffect(() => {
    if (!live) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const host = new GameHost(iframe, {
      onReady: () => {
        errorCountRef.current = 0;
        setErrored(false);
        syncPlayback();
      },
      onGameOver: () => {
        gameOverRef.current = true;
        setGameOver(true);
        hostRef.current?.pause();
      },
      onError: (error: GameHostError) => {
        errorCountRef.current += 1;
        setErrored(true);
        // Doc 08: handshake failure or >3 errors -> skip and log game_error.
        if (error.code === 'timeout' || errorCountRef.current > 3) skipAfterError();
      },
    });
    hostRef.current = host;
    syncPlayback();

    return () => {
      host.destroy();
      hostRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, card.artifactUrl]);

  // Re-drive playback whenever the view state changes.
  useEffect(() => {
    syncPlayback();
  }, [live, isActive, isPlaying, audioUnlocked, gameOver, syncPlayback]);

  // Mute follows the global toggle.
  useEffect(() => {
    if (!live) return;
    hostRef.current?.mute(muted);
  }, [live, muted]);

  // Pause when the tab is hidden (GameHost also self-pauses; belt and braces).
  useEffect(() => {
    const onVisibility = () => syncPlayback();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [syncPlayback]);

  const handlePosterTap = () => {
    const state = useFeedStore.getState();
    state.unlockAudio();
    state.setPlaying(true);
    hostRef.current?.resume();
    syncPlayback();
  };

  const handleReplay = () => {
    gameOverRef.current = false;
    setGameOver(false);
    skippedRef.current = false;
    errorCountRef.current = 0;
    const state = useFeedStore.getState();
    state.setPlaying(true);
    hostRef.current?.restart();
    syncPlayback();
  };

  if (!live) {
    // Memory rule: outside active ±1 only a poster placeholder exists — no
    // iframe, no host. Poster images land here once generated (posterUrl).
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(160deg, #17203a 0%, #0b0b10 70%)',
          display: 'flex',
          alignItems: 'flex-end',
          padding: 'calc(env(safe-area-inset-top, 0px) + 16px) 16px calc(env(safe-area-inset-bottom, 0px) + 16px)',
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
      <iframe
        ref={iframeRef}
        src={card.artifactUrl}
        title={card.title}
        sandbox="allow-scripts"
        allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"
        referrerPolicy="no-referrer"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          border: 'none',
          // The game owns touches inside its frame while playing (doc 12 §15).
          touchAction: 'none',
        }}
      />

      {/* Title / description / tags — kept inside the device safe areas
          (the insets PlayLoop.safeArea mirrors for the guest). */}
      <div
        style={{
          position: 'absolute',
          left: 'calc(env(safe-area-inset-left, 0px) + 12px)',
          right: 88,
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
          color: '#fff',
          textShadow: '0 1px 3px rgba(0,0,0,0.8)',
          pointerEvents: 'none',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700 }}>{card.title}</div>
        <div style={{ fontSize: 14, opacity: 0.85, marginTop: 4 }}>{card.description}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {card.tags.map((tag) => (
            <span key={tag} style={{ fontSize: 12, background: 'rgba(255,255,255,0.18)', borderRadius: 999, padding: '3px 10px' }}>
              #{tag}
            </span>
          ))}
        </div>
      </div>

      {/* Right rail: thumb zone (right edge, bottom 40%). 48px targets. */}
      <div
        style={{
          position: 'absolute',
          right: 'calc(env(safe-area-inset-right, 0px) + 10px)',
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, marginBottom: 4 }}>
          <button
            type="button"
            aria-label={following ? 'Unfollow' : 'Follow'}
            onClick={() => setFollowing((f) => !f)}
            style={{
              ...RAIL_BUTTON,
              background: following ? 'rgba(255,255,255,0.25)' : 'rgba(255,72,116,0.9)',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {following ? '✓' : '+'}
          </button>
          <div style={RAIL_LABEL}>@{card.creator.handle}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <button type="button" aria-label="Like" aria-pressed={liked} onClick={() => setLiked((l) => !l)} style={{ ...RAIL_BUTTON, color: liked ? '#ff4b6e' : '#fff' }}>
            <Icon path={ICONS.heart} filled={liked} />
          </button>
          <div style={RAIL_LABEL}>{card.counts.likes + (liked ? 1 : 0)}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <button type="button" aria-label="Comment" style={RAIL_BUTTON}>
            <Icon path={ICONS.comment} />
          </button>
          <div style={RAIL_LABEL}>{card.counts.comments}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <button type="button" aria-label="Save" aria-pressed={saved} onClick={() => setSaved((s) => !s)} style={{ ...RAIL_BUTTON, color: saved ? '#ffd166' : '#fff' }}>
            <Icon path={ICONS.bookmark} filled={saved} />
          </button>
          <div style={RAIL_LABEL}>{card.counts.saves + (saved ? 1 : 0)}</div>
        </div>

        <button type="button" aria-label="Remix" style={RAIL_BUTTON}>
          <Icon path={ICONS.remix} />
        </button>

        <button type="button" aria-label="Share" style={RAIL_BUTTON}>
          <Icon path={ICONS.share} />
        </button>

        {/* Documented fallback for the scroll-vs-play gesture conflict (doc 12 §15). */}
        <button type="button" aria-label="Next game" onClick={onNext} style={{ ...RAIL_BUTTON, background: 'rgba(255,255,255,0.22)' }}>
          <Icon path={ICONS.chevron} />
        </button>
      </div>

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
            gap: 16,
          }}
        >
          <div style={{ fontSize: 24, fontWeight: 700 }}>Game over</div>
          <button type="button" onClick={handleReplay} style={{ ...RAIL_BUTTON, width: 160, height: 52, borderRadius: 26, fontSize: 18, fontWeight: 700, background: '#fff', color: '#0b0b10', gap: 8 }}>
            <Icon path={ICONS.replay} filled /> Replay
          </button>
          <button type="button" onClick={onNext} style={{ ...RAIL_BUTTON, width: 160, height: 52, borderRadius: 26, fontSize: 18, fontWeight: 700, background: 'rgba(255,255,255,0.2)', color: '#fff', gap: 8 }}>
            Next <Icon path={ICONS.chevron} />
          </button>
        </div>
      ) : !audioUnlocked ? (
        // Poster + tap-to-play: browsers need a user gesture to unlock audio.
        <button
          type="button"
          onClick={handlePosterTap}
          aria-label={`Tap to play ${card.title}`}
          style={{
            position: 'absolute',
            inset: 0,
            border: 'none',
            padding: 0,
            width: '100%',
            background: 'linear-gradient(160deg, rgba(23,32,58,0.92) 0%, rgba(11,11,16,0.88) 70%)',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <div style={{ ...RAIL_BUTTON, width: 72, height: 72, borderRadius: 36, background: 'rgba(255,255,255,0.2)' }}>
            <Icon path={ICONS.play} filled />
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{card.title}</div>
          <div style={{ fontSize: 14, opacity: 0.85 }}>Tap to play</div>
        </button>
      ) : !isPlaying ? (
        <button
          type="button"
          onClick={() => {
            useFeedStore.getState().setPlaying(true);
            syncPlayback();
          }}
          aria-label={`Resume ${card.title}`}
          style={{
            position: 'absolute',
            inset: 0,
            border: 'none',
            background: 'rgba(0,0,0,0.35)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <div style={{ ...RAIL_BUTTON, width: 72, height: 72, borderRadius: 36, background: 'rgba(255,255,255,0.2)' }}>
            <Icon path={isPlaying ? ICONS.pause : ICONS.play} filled />
          </div>
        </button>
      ) : null}

      {errored && !gameOver ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
            left: 'calc(env(safe-area-inset-left, 0px) + 12px)',
            background: 'rgba(180,40,40,0.85)',
            color: '#fff',
            fontSize: 12,
            borderRadius: 8,
            padding: '6px 10px',
            pointerEvents: 'none',
          }}
        >
          Game failed to load — skipping
        </div>
      ) : null}
    </div>
  );
}
