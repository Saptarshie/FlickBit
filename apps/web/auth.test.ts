import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { handleFromEmail } from './auth';

describe('handleFromEmail', () => {
  it('slugifies the email local part (jane.doe@example.com -> jane-doe)', () => {
    expect(handleFromEmail('jane.doe@example.com')).toBe('jane-doe');
    expect(handleFromEmail('John..Doe!@example.com')).toBe('john-doe');
    expect(handleFromEmail('UPPER_case@example.com')).toBe('upper-case');
  });

  it('falls back to "user" for empty input', () => {
    expect(handleFromEmail('')).toBe('user');
    expect(handleFromEmail('@example.com')).toBe('user');
    expect(handleFromEmail('!!!@example.com')).toBe('user');
  });

  it('never produces a numeric-leading handle', () => {
    expect(handleFromEmail('2024.player@example.com')).toBe('u-2024-player');
    expect(handleFromEmail('42@example.com')).toBe('u-42');
    expect(handleFromEmail('9lives@example.com')).toBe('u-9lives');
  });
});

describe('authConfig', () => {
  it('parses with zod and declares both providers and jwt strategy', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret');
    vi.resetModules();
    const { authConfig } = await import('./auth');

    const providerSchema = z.looseObject({
      id: z.string(),
      type: z.string(),
    });
    const authConfigSchema = z.looseObject({
      adapter: z.custom((v) => typeof v === 'object' && v !== null),
      providers: z.array(providerSchema),
      session: z.looseObject({ strategy: z.enum(['jwt', 'database']) }),
      pages: z.looseObject({ signIn: z.string() }),
      callbacks: z.looseObject({
        jwt: z.custom((v) => typeof v === 'function'),
        session: z.custom((v) => typeof v === 'function'),
      }),
    });

    const parsed = authConfigSchema.parse(authConfig);
    expect(parsed.session.strategy).toBe('jwt');
    expect(parsed.pages.signIn).toBe('/login');

    const providerIds = parsed.providers.map((p) => p.id);
    expect(providerIds).toContain('google');
    expect(providerIds).toContain('nodemailer');

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('omits Google when its credentials are not configured', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.resetModules();
    const { authConfig } = await import('./auth');
    const providerIds = (authConfig.providers as Array<{ id: string }>).map((p) => p.id);
    expect(providerIds).toContain('nodemailer');
    expect(providerIds).not.toContain('google');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
