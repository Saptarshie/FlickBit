import type { NextConfig } from 'next';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Load the monorepo-root .env into process.env.
 *
 * Next only auto-loads .env files from the app directory (apps/web), but this
 * repo keeps a single root .env shared by web, play-worker and the db scripts.
 * Loading it here means server code (and NEXT_PUBLIC_ inlining) sees the same
 * values without duplicating the file. Existing env vars always win.
 */
function loadRootEnv(): void {
  const rootEnv = path.resolve(process.cwd(), '../../.env');
  if (!existsSync(rootEnv)) return;
  for (const rawLine of readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadRootEnv();

/**
 * Baseline security headers. The app origin had none at all: no CSP, no
 * nosniff, and it could be framed (click-jacking the Like/Create buttons).
 *
 * The CSP is only applied in production: Next's dev server needs inline eval
 * and a websocket for HMR, and a policy that allows those teaches nobody
 * anything. Prod also gets `frame-ancestors 'none'` because only the game
 * artifacts are meant to be embedded (they are served by apps/play-worker).
 */
const isProd = process.env.NODE_ENV === 'production';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(isProd
    ? [
        {
          key: 'Content-Security-Policy',
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' data: blob:",
            "connect-src 'self'",
            "frame-src 'self' http: https:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
          ].join('; '),
        },
      ]
    : []),
];

const config: NextConfig = {
  transpilePackages: ['@playloop/sdk', '@playloop/gamekit', '@playloop/db', '@playloop/recsys', '@playloop/ai'],
  // Keep Node-only DB/native-ish deps out of the server bundle.
  serverExternalPackages: ['postgres', 'nodemailer'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
