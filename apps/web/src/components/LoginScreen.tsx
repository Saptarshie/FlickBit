'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { signInWithHandle } from '../lib/client-api';

/** One-tap handle sign-in. No password, no email loop. */
export default function LoginScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await signInWithHandle(handle);
      if (!ok) {
        setError('Pick a handle with at least 3 letters or numbers.');
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError('Could not sign in. Is the server running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: 'radial-gradient(120% 80% at 50% 0%, #191436 0%, #0b0b10 60%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '24px 20px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: 420, width: '100%', margin: '0 auto' }}>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: -0.6 }}>PlayLoop</div>
        <p style={{ opacity: 0.72, marginTop: 8, lineHeight: '22px' }}>
          Scroll. Play. Remix. Pick a handle to like, comment, follow creators and publish your own games.
        </p>

        <form onSubmit={submit} style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label htmlFor="handle" style={{ fontSize: 13, opacity: 0.7 }}>
            Your handle
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ opacity: 0.5, fontSize: 18 }}>@</span>
            <input
              id="handle"
              name="handle"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="pixelpanda"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              style={{
                flex: 1,
                minHeight: 48,
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.16)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff',
                fontSize: 16,
                padding: '0 14px',
                outline: 'none',
              }}
            />
          </div>
          <button
            type="submit"
            disabled={busy || handle.trim().length < 3}
            style={{
              minHeight: 48,
              borderRadius: 12,
              border: 'none',
              background: busy ? 'rgba(255,255,255,0.2)' : 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
              color: '#fff',
              fontSize: 16,
              fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy ? 'Signing in…' : 'Continue'}
          </button>
          {error ? <div style={{ color: '#ff8fa3', fontSize: 13 }}>{error}</div> : null}
        </form>

        <Link href="/" style={{ display: 'inline-block', marginTop: 20, color: 'rgba(255,255,255,0.65)', fontSize: 14 }}>
          Browse without an account →
        </Link>
      </div>
    </main>
  );
}
