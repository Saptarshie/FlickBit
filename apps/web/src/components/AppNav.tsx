'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { CSSProperties, ReactNode } from 'react';
import { api, type MeResponse } from '../lib/client-api';

const NAV_HEIGHT = 56;
const BAR_HEIGHT = 48;

function icon(d: string, filled = false) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={d}
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  search: 'M11 4a7 7 0 1 0 4.19 12.6l4.11 4.1 1.4-1.4-4.1-4.11A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  bookmark: 'M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z',
  bell: 'M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 1 0-14 0v5l-2 2v1h18v-1z',
  user: 'M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z',
} as const;

export const chromeTop = BAR_HEIGHT;
export const chromeBottom = NAV_HEIGHT;

/** Fetch the viewer once per session; the chrome reacts to sign-in/out. */
export function useMe() {
  return useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/api/me'),
    staleTime: 30_000,
  });
}

type NavProps = {
  /** Transparent over the feed; opaque on content pages. */
  transparent?: boolean;
};

export function BottomNav({ transparent = false }: NavProps) {
  const pathname = usePathname();
  const { data } = useMe();
  const handle = data?.viewer?.handle;
  const unread = data?.unread ?? 0;

  const item = (href: string, label: string, d: string, active: boolean, badge = 0): ReactNode => (
    <Link
      key={href}
      href={href}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      style={{
        flex: 1,
        height: NAV_HEIGHT,
        minHeight: 44,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        color: active ? '#fff' : 'rgba(255,255,255,0.62)',
        textDecoration: 'none',
        position: 'relative',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{ position: 'relative', display: 'flex' }}>
        {icon(d, active)}
        {badge > 0 ? (
          <span
            style={{
              position: 'absolute',
              top: -4,
              right: -8,
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              background: '#ff3b5c',
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              display: 'grid',
              placeItems: 'center',
              padding: '0 4px',
            }}
          >
            {badge > 9 ? '9+' : badge}
          </span>
        ) : null}
      </span>
      <span style={{ fontSize: 10, lineHeight: '12px' }}>{label}</span>
    </Link>
  );

  return (
    <nav
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: `calc(${NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        display: 'flex',
        alignItems: 'stretch',
        background: transparent ? 'linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))' : '#0d0d13',
        borderTop: transparent ? 'none' : '1px solid rgba(255,255,255,0.08)',
        zIndex: 40,
      }}
    >
      {item('/', 'Home', ICONS.home, pathname === '/')}
      {item('/explore', 'Explore', ICONS.search, pathname.startsWith('/explore'))}
      <Link
        href="/studio"
        aria-label="Create a game"
        style={{
          flex: 1,
          height: NAV_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textDecoration: 'none',
        }}
      >
        <span
          style={{
            width: 44,
            height: 34,
            borderRadius: 10,
            background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          {icon(ICONS.plus)}
        </span>
      </Link>
      {item('/saved', 'Saved', ICONS.bookmark, pathname.startsWith('/saved'))}
      {item('/notifications', 'Activity', ICONS.bell, pathname.startsWith('/notifications'), unread)}
      {item(
        handle ? `/u/${handle}` : '/login',
        handle ? 'Profile' : 'Sign in',
        ICONS.user,
        Boolean(handle && pathname.startsWith(`/u/${handle}`)),
      )}
    </nav>
  );
}

export function TopBar({ title = 'PlayLoop', right }: { title?: string; right?: ReactNode }) {
  return (
    <header
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: `calc(${BAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
        paddingTop: 'env(safe-area-inset-top, 0px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 14,
        paddingRight: 14,
        zIndex: 40,
        background: '#0b0b10',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        boxSizing: 'border-box',
      }}
    >
      <Link href="/" style={{ color: '#fff', textDecoration: 'none', fontWeight: 800, fontSize: 18, letterSpacing: -0.3 }}>
        {title}
      </Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>
    </header>
  );
}

/** Page frame for content screens (non-feed): offsets the fixed chrome. */
export function Screen({ children, title, right }: { children: ReactNode; title?: string; right?: ReactNode }) {
  const outer: CSSProperties = {
    minHeight: '100dvh',
    background: '#0b0b10',
    color: '#fff',
    paddingTop: `calc(${BAR_HEIGHT}px + env(safe-area-inset-top, 0px) + 12px)`,
    paddingBottom: `calc(${NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px) + 16px)`,
    boxSizing: 'border-box',
  };
  return (
    <div style={outer}>
      <TopBar title={title} right={right} />
      {children}
      <BottomNav />
    </div>
  );
}
