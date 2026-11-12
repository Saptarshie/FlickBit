'use client';

/**
 * Last-resort boundary: React only reaches this when the ROOT layout throws,
 * which the regular `error.tsx` cannot catch (it renders inside that layout).
 * It must therefore supply its own <html> and <body>.
 *
 * Kept dependency-free on purpose — no theme provider, no fonts, no store.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#f5f5f5',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: 380, textAlign: 'center' }}>
          <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>PlayLoop could not start</p>
          <p style={{ fontSize: 13, color: '#a3a3a3', margin: '0 0 16px', lineHeight: 1.5 }}>
            Something failed while loading the app itself. Reloading usually fixes it.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button
              type="button"
              onClick={reset}
              style={{
                background: '#10b981',
                color: '#04110c',
                border: 0,
                borderRadius: 10,
                padding: '10px 16px',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.href = '/';
              }}
              style={{
                background: '#262626',
                color: '#f5f5f5',
                border: 0,
                borderRadius: 10,
                padding: '10px 16px',
                fontSize: 13,
              }}
            >
              Reload the feed
            </button>
          </div>
          {error.digest ? (
            <p style={{ marginTop: 14, fontSize: 11, color: '#525252' }}>Reference: {error.digest}</p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
