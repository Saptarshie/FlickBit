'use client';

import { useEffect } from 'react';

/**
 * Route error boundary. A crash must always leave a way out — the old behaviour
 * was a bare white "Internal Server Error" page with no chrome and no links.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] render error:', error.message, error.digest ?? '');
  }, [error]);

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'radial-gradient(120% 80% at 50% 0%, #191436 0%, #0b0b10 60%)',
        color: '#fff',
        textAlign: 'center',
      }}
    >
      <div>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🛠️</div>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Something broke on our side</h1>
        <p style={{ opacity: 0.65, fontSize: 14, marginTop: 8, lineHeight: '20px', maxWidth: 320 }}>
          {/* A stack message like "Cannot read properties of undefined" means
              nothing to a player and can leak internals; keep it in the log. */}
          {'This screen hit an unexpected error. Reloading usually fixes it.'}
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20 }}>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 48,
              padding: '0 22px',
              borderRadius: 24,
              border: 'none',
              background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
              color: '#fff',
              fontWeight: 700,
              fontSize: 15,
              cursor: 'pointer',
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
              padding: '0 20px',
              borderRadius: 24,
              border: '1px solid rgba(255,255,255,0.18)',
              color: '#fff',
              textDecoration: 'none',
            }}
          >
            Back to the feed
          </a>
        </div>
      </div>
    </main>
  );
}
