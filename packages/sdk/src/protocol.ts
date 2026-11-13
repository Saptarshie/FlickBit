/** Guest shim build, reported in the ready payload so a stale worker is visible. */
export const SHIM_VERSION = '1.2.0';

export const SDK_VERSION = 1 as const;
export const MAX_PAYLOAD_BYTES = 8 * 1024;

export type GuestToHost = 'ready' | 'gameOver' | 'score' | 'storage:get' | 'storage:set' | 'haptic' | 'share' | 'log' | 'error' | 'perf';
export type HostToGuest = 'init' | 'pause' | 'resume' | 'restart' | 'mute' | 'storage:result' | 'input';

/** Pointer message kinds the host can replay inside the guest. */
export type InputKind = 'tap' | 'down' | 'move' | 'up' | 'cancel';

/**
 * A single synthetic pointer event. Coordinates are guest CSS pixels (relative
 * to the iframe viewport), so the host must subtract the frame's bounding rect
 * before sending. `pointerId` lets multi-touch reach games that track fingers.
 */
export interface InputPayload {
  kind: InputKind;
  x: number;
  y: number;
  pointerId?: number;
  pointerType?: 'touch' | 'mouse' | 'pen';
  /** 0 for up/cancel, 1 for down/move. */
  buttons?: number;
}

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
