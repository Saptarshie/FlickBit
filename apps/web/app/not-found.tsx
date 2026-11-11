import Link from 'next/link';

/** App-wide 404: never leave the user on Next's unstyled stock page. */
export default function NotFound() {
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
        <div style={{ fontSize: 40, marginBottom: 8 }}>🎮</div>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>This page slid away</h1>
        <p style={{ opacity: 0.65, fontSize: 14, marginTop: 8, lineHeight: '20px' }}>
          The game or profile you were looking for does not exist any more.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20 }}>
          <Link
            href="/"
            style={{
              minHeight: 48,
              display: 'inline-flex',
              alignItems: 'center',
              padding: '0 20px',
              borderRadius: 24,
              background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
              color: '#fff',
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            Back to the feed
          </Link>
          <Link
            href="/explore"
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
            Explore games
          </Link>
        </div>
      </div>
    </main>
  );
}
