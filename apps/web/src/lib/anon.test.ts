import { describe, it, expect } from 'vitest';
import { makeAnonId, verifyAnonId, setAnonCookie, type AnonCookieStore } from './anon';

describe('anon id', () => {
  it('round-trips: value.signature verifies', () => {
    const raw = makeAnonId('abc-123');
    expect(raw.startsWith('abc-123.')).toBe(true);
    expect(verifyAnonId(raw)).toBe(true);
  });

  it('round-trips values containing dots', () => {
    const raw = makeAnonId('a.b.c');
    expect(verifyAnonId(raw)).toBe(true);
  });

  it('rejects a tampered value', () => {
    const raw = makeAnonId('abc-123');
    expect(verifyAnonId(`other-value.${raw.split('.')[1]}`)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const raw = makeAnonId('abc-123');
    const [value, sig] = raw.split('.');
    const flipped = sig!.split('');
    flipped[0] = flipped[0] === '0' ? '1' : '0';
    expect(verifyAnonId(`${value}.${flipped.join('')}`)).toBe(false);
    expect(verifyAnonId(`${value}.${sig}00`)).toBe(false);
    expect(verifyAnonId(`${value}.`)).toBe(false);
  });

  it('rejects empty or malformed input', () => {
    expect(verifyAnonId('')).toBe(false);
    expect(verifyAnonId('.')).toBe(false);
    expect(verifyAnonId('nodot')).toBe(false);
    expect(verifyAnonId('.deadbeef')).toBe(false);
    expect(() => makeAnonId('')).toThrow();
  });
});

describe('setAnonCookie', () => {
  it('sets the pl_anon cookie httpOnly/lax for one year', () => {
    const calls: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
    const store: AnonCookieStore = {
      set(name, value, options) {
        calls.push({ name, value, options: options as unknown as Record<string, unknown> });
      },
    };

    setAnonCookie(store, 'abc-123.signature');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('pl_anon');
    expect(calls[0]!.value).toBe('abc-123.signature');
    expect(calls[0]!.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  });
});
