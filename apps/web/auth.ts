import NextAuth, {
  type NextAuthConfig,
  type NextAuthResult,
  type DefaultSession,
  type NextAuthRequest,
} from 'next-auth';
import Google from 'next-auth/providers/google';
import Nodemailer from 'next-auth/providers/nodemailer';
import PostgresAdapter from '@auth/pg-adapter';
import postgres from 'postgres';
import nodemailer from 'nodemailer';

declare module 'next-auth' {
  interface Session {
    user: { id: string; handle: string } & DefaultSession['user'];
  }
}

const DEV_FALLBACK_DATABASE_URL = 'postgres://playloop:playloop@localhost:5432/playloop';
const DEV_FALLBACK_EMAIL_SERVER = 'smtp://localhost:1025';
const DEV_FALLBACK_EMAIL_FROM = 'PlayLoop <noreply@playloop.local>';

/**
 * Derive a handle-style slug from an email address: the lowercased local part
 * with non-alphanumerics collapsed to dashes (jane.doe@example.com -> jane-doe).
 * Never empty (falls back to "user") and never numeric-leading (prefixed "u-").
 */
export function handleFromEmail(email: string | null | undefined): string {
  const localPart = (email ?? '').split('@')[0] ?? '';
  const slug = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') return 'user';
  return /^[0-9]/.test(slug) ? `u-${slug}` : slug;
}

/**
 * Bridge a postgres.js client to the pg-style `query(sql, params) -> { rows }`
 * Pool interface that @auth/pg-adapter calls.
 */
function pgPoolShim(sql: ReturnType<typeof postgres>): Parameters<typeof PostgresAdapter>[0] {
  return {
    query: async (text: string, params: unknown[] = []) => {
      const rows = await sql.unsafe(text, params as never[]);
      return { rows, rowCount: rows.length };
    },
  } as unknown as Parameters<typeof PostgresAdapter>[0];
}

const providers: NextAuthConfig['providers'] = [];

// Google OAuth is only enabled when its credentials are configured.
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  );
}

// Magic-link email provider, pointed at Mailpit in development.
providers.push(
  Nodemailer({
    server: process.env.EMAIL_SERVER ?? DEV_FALLBACK_EMAIL_SERVER,
    from: process.env.EMAIL_FROM ?? DEV_FALLBACK_EMAIL_FROM,
    sendVerificationRequest: async ({ identifier, url, provider }) => {
      const host = new URL(url).host;
      const subjectPrefix = process.env.NODE_ENV === 'production' ? '' : '[dev] ';
      const transport = nodemailer.createTransport(provider.server ?? DEV_FALLBACK_EMAIL_SERVER);
      await transport.sendMail({
        to: identifier,
        from: provider.from ?? DEV_FALLBACK_EMAIL_FROM,
        subject: `${subjectPrefix}Sign in to ${host}`,
        text: `Sign in to ${host}:\n${url}\n`,
        html: `<p>Sign in to <a href="${url}">${host}</a></p>`,
      });
    },
  }),
);

export const authConfig: NextAuthConfig = {
  adapter: PostgresAdapter(
    pgPoolShim(postgres(process.env.DATABASE_URL ?? DEV_FALLBACK_DATABASE_URL)),
  ),
  providers,
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.handle =
          (user as { handle?: string | null }).handle ?? handleFromEmail(user.email);
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = typeof token.id === 'string' ? token.id : (token.sub ?? '');
        session.user.handle =
          typeof token.handle === 'string' ? token.handle : handleFromEmail(session.user.email);
      }
      return session;
    },
  },
};

const nextAuth = NextAuth(authConfig);
export const handlers: NextAuthResult['handlers'] = nextAuth.handlers;
export const auth: NextAuthResult['auth'] = nextAuth.auth;
export const signIn: NextAuthResult['signIn'] = nextAuth.signIn;
export const signOut: NextAuthResult['signOut'] = nextAuth.signOut;
export type { NextAuthRequest };
