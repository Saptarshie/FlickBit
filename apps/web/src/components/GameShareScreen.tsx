'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';

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

  const start = () => {
    setStarted(true);
    // Kick the guest into running state once the user gesture unlocked audio.
    iframeRef.current?.contentWindow?.postMessage({ src: 'playloop', type: 'resume' }, '*');
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
            ref={iframeRef}
            src={game.artifactUrl}
            title={game.title}
            sandbox="allow-scripts"
            allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"
            referrerPolicy="no-referrer"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', touchAction: 'none' }}
          />
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
    </main>
  );
}
