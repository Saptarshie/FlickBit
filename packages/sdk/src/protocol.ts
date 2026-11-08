export const SDK_VERSION = 1 as const;
export const MAX_PAYLOAD_BYTES = 8 * 1024;

export type GuestToHost = 'ready' | 'gameOver' | 'score' | 'storage:get' | 'storage:set' | 'haptic' | 'share' | 'log' | 'error' | 'perf';
export type HostToGuest = 'init' | 'pause' | 'resume' | 'restart' | 'mute' | 'storage:result' | 'input';

export interface Envelope<T = unknown> { v: 1; src: 'playloop'; type: string; id?: string; payload?: T }

const GUEST_TYPES = new Set<string>(['ready','gameOver','score','storage:get','storage:set','haptic','share','log','error','perf']);

/** Validate an untrusted guest message. Returns the envelope or null. */
export function parseGuestMessage(data: unknown): Envelope | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.v !== SDK_VERSION || d.src !== 'playloop' || typeof d.type !== 'string') return null;
  if (!GUEST_TYPES.has(d.type)) return null;
  if (d.id !== undefined && typeof d.id !== 'string') return null;
  let size = 0;
  try { size = JSON.stringify(d.payload ?? null).length; } catch { return null; }
  if (size > MAX_PAYLOAD_BYTES) return null;
  return d as unknown as Envelope;
}
