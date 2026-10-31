import { describe, it, expect } from 'vitest';
import { parseGuestMessage } from './protocol';

describe('parseGuestMessage', () => {
  it('accepts a valid message', () => {
    expect(parseGuestMessage({ v: 1, src: 'playloop', type: 'ready' })).not.toBeNull();
  });
  it('rejects unknown types, wrong version, junk, and oversized payloads', () => {
    expect(parseGuestMessage({ v: 1, src: 'playloop', type: 'evil' })).toBeNull();
    expect(parseGuestMessage({ v: 2, src: 'playloop', type: 'ready' })).toBeNull();
    expect(parseGuestMessage('x')).toBeNull();
    expect(parseGuestMessage(null)).toBeNull();
    expect(parseGuestMessage({ v: 1, src: 'playloop', type: 'log', payload: 'a'.repeat(9000) })).toBeNull();
  });
});
