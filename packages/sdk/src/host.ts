import {
  parseGuestMessage,
  SDK_VERSION,
  SHIM_VERSION,
  MAX_PAYLOAD_BYTES,
  type Envelope,
  type HostToGuest,
  type InputKind,
  type InputPayload,
} from './protocol';

/** Storage requests reuse the guest-side request type names when proxied. */
type PostedType = HostToGuest | 'storage:get' | 'storage:set';

export interface GameHostError {
  message: string;
  code?: string;
  stack?: string;
}

export interface GameHostOptions {
  onMessage?: (env: Envelope) => void;
  onReady?: (payload?: unknown) => void;
  onGameOver?: (payload: unknown) => void;
  onError?: (error: GameHostError) => void;
  onScore?: (payload: unknown) => void;
  onLog?: (payload: unknown) => void;
  onPerf?: (payload: unknown) => void;
  onShare?: (payload: unknown) => void;
  onHaptic?: (payload: unknown) => void;
  handshakeTimeoutMs?: number;
}

export type GameHostEvent =
  | 'message'
  | 'ready'
  | 'gameOver'
  | 'error'
  | 'score'
  | 'log'
  | 'perf'
  | 'share'
  | 'haptic';

export type HostListener = (arg: unknown) => void;

interface MessageLike {
  source?: unknown;
  data?: unknown;
}

interface DocumentLike {
  hidden?: boolean;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

interface WindowLike {
  addEventListener(type: string, cb: (ev: MessageLike) => void): void;
  removeEventListener(type: string, cb: (ev: MessageLike) => void): void;
  document?: DocumentLike | null;
}

interface PendingStorage {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 12_000;
const STORAGE_TIMEOUT_MS = 5000;

/**
 * `storage:result` is a host->guest type, so it never passes parseGuestMessage
 * (which only accepts guest->host types). The storage service answers the
 * host's proxied requests over the same window message channel, so the reply is
 * validated here with the same envelope rules; the request id acts as the
 * capability token.
 */
function parseStorageResult(data: unknown): { id: string; payload: unknown } | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.v !== SDK_VERSION || d.src !== 'playloop' || d.type !== 'storage:result') return null;
  if (typeof d.id !== 'string') return null;
  let size = 0;
  try {
    size = JSON.stringify(d.payload ?? null).length;
  } catch {
    return null;
  }
  if (size > MAX_PAYLOAD_BYTES) return null;
  return { id: d.id, payload: d.payload };
}

/**
 * Host side of the PlayLoop SDK. Owns one sandboxed game iframe: validates and
 * dispatches guest messages, drives pause/resume/restart/mute, proxies storage,
 * and enforces the handshake timeout. A sandboxed iframe has an opaque origin,
 * so `event.source` (not `event.origin`) is what validates a message.
 */
export class GameHost {
  readonly iframe: HTMLIFrameElement;

  private readonly opts: GameHostOptions;
  private readonly win: WindowLike | null;
  private readonly doc: DocumentLike | null;
  private readonly listeners = new Map<GameHostEvent, Set<HostListener>>();
  private readonly pendingStorage = new Map<string, PendingStorage>();

  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private idSeq = 0;
  private invalidCount = 0;
  private playing = true;
  /** Sticky `init` payload, replayed so late settings changes take effect. */
  private initState: { safeArea?: { top: number; bottom: number }; muted?: boolean; seed?: number } = {};
  private autoPaused = false;
  private destroyed = false;

  constructor(iframe: HTMLIFrameElement, opts: GameHostOptions = {}) {
    this.iframe = iframe;
    this.opts = opts;

    const ownerView = (iframe.ownerDocument ?? null)?.defaultView ?? null;
    this.win =
      (ownerView as unknown as WindowLike | null) ??
      ((globalThis as { window?: WindowLike }).window ?? null);
    this.doc = this.win?.document ?? null;

    this.win?.addEventListener('message', this.handleMessage);
    this.doc?.addEventListener('visibilitychange', this.handleVisibility);

    const timeout = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      this.raiseError({
        message: 'handshake timeout: guest never sent ready',
        code: 'timeout',
      });
    }, timeout);
  }

  /** Subscribe to a host event. Returns an unsubscribe function. */
  on(event: GameHostEvent, cb: HostListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set<HostListener>();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }

  /** Pause the guest (fire-and-forget). */
  pause(): void {
    this.playing = false;
    this.post('pause');
  }

  /** Resume the guest (fire-and-forget). */
  resume(): void {
    this.playing = true;
    this.post('resume');
  }

  /** Ask the guest to restart, then reload the frame (opaque origin may throw). */
  restart(): void {
    this.post('restart');
    try {
      const loc = this.iframe.contentWindow?.location;
      if (loc) loc.reload();
    } catch {
      /* cross-origin reload is not allowed for opaque origins; the restart
         message already told the guest, and the container can replace the frame */
    }
  }

  /** Mute or unmute the guest's audio. */
  mute(muted: boolean): void {
    this.post('mute', { muted });
  }

  /**
   * Send the `init` envelope the shim reads: safe-area insets and mute state.
   *
   * Without it a game sees `PlayLoop.safeArea = {top:0,bottom:0}` and draws its
   * HUD underneath the feed's bottom navigation. Send it on every `ready`
   * (the host keeps a mutable `init` that is replayed).
   */
  configure(settings: { safeArea?: { top: number; bottom: number }; muted?: boolean; seed?: number }): void {
    this.initState = { ...this.initState, ...settings };
    this.post('init', this.initState);
  }

  /**
   * Forward a pointer event into the guest.
   *
   * The host renders a transparent gesture layer above the iframe so the feed
   * keeps its own vertical scroll. When a card is engaged for play, every
   * pointer message is replayed inside the game as a real pointer/touch event,
   * which keeps sandboxed games fully playable without same-origin access.
   *
   * `x`/`y` MUST be guest CSS pixels: subtract the iframe's bounding rect on
   * the host side (the frame is rendered 1:1, so no scale factor is needed).
   */
  input(payload: InputPayload | InputKind, x?: number, y?: number): void {
    const message: InputPayload =
      typeof payload === 'string'
        ? { kind: payload, x: Number(x) || 0, y: Number(y) || 0 }
        : payload;
    this.post('input', {
      kind: message.kind,
      x: Math.round(message.x),
      y: Math.round(message.y),
      ...(message.pointerId === undefined ? {} : { pointerId: message.pointerId }),
      ...(message.pointerType === undefined ? {} : { pointerType: message.pointerType }),
      buttons: message.buttons ?? (message.kind === 'up' || message.kind === 'cancel' ? 0 : 1),
    });
  }

  /** Re-arm the handshake timer (used when a frame is reloaded/retried). */
  armHandshake(timeoutMs: number = DEFAULT_HANDSHAKE_TIMEOUT_MS): void {
    this.clearHandshake();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      this.raiseError({ message: 'handshake timeout: guest never sent ready', code: 'timeout' });
    }, timeoutMs);
  }

  /** Resolve a guest storage key through the host. Resolves null on timeout. */
  storageGet<T = unknown>(key: string): Promise<T | null> {
    return this.storageRequest('storage:get', { key: String(key) }) as Promise<T | null>;
  }

  /** Persist a guest storage key through the host. Resolves null on timeout. */
  storageSet(key: string, value: unknown): Promise<unknown> {
    return this.storageRequest('storage:set', { key: String(key), value });
  }

  /** Tear down: pause the guest, drop listeners, clear timers. */
  destroy(): void {
    if (this.destroyed) return;
    this.pause();
    this.destroyed = true;
    this.clearHandshake();
    for (const [, pending] of this.pendingStorage) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingStorage.clear();
    this.win?.removeEventListener('message', this.handleMessage);
    this.doc?.removeEventListener('visibilitychange', this.handleVisibility);
    this.listeners.clear();
  }

  private storageRequest(type: 'storage:get' | 'storage:set', payload: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const id = 'h' + String(++this.idSeq);
      const timer = setTimeout(() => {
        this.pendingStorage.delete(id);
        resolve(null);
      }, STORAGE_TIMEOUT_MS);
      this.pendingStorage.set(id, { resolve, timer });
      this.post(type, payload, id);
    });
  }

  private post(type: PostedType, payload?: unknown, id?: string): void {
    const cw = this.iframe.contentWindow;
    if (!cw) return;
    const env: Envelope = { v: SDK_VERSION, src: 'playloop', type };
    if (id !== undefined) env.id = id;
    if (payload !== undefined) env.payload = payload;
    try {
      cw.postMessage(env, '*');
    } catch {
      /* dead or detached frame */
    }
  }

  private clearHandshake(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private raiseError(error: GameHostError): void {
    this.opts.onError?.(error);
    this.emit('error', error);
  }

  private emit(event: GameHostEvent, arg: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) cb(arg);
  }

  private countInvalid(): void {
    this.invalidCount += 1;
    if (this.invalidCount === 10) {
      this.raiseError({
        message: 'too many invalid messages from guest',
        code: 'invalid-message',
      });
    }
  }

  private handleMessage = (event: MessageLike): void => {
    if (this.destroyed) return;
    const cw = this.iframe.contentWindow;
    // Only our frame may talk to us. Everything else (React DevTools, HMR,
    // extensions, other iframes) is noise and must NOT be counted as a guest
    // protocol violation — doing that killed live cards after 10 stray posts.
    const fromFrame = cw != null && (event.source as unknown) === (cw as unknown);
    if (!fromFrame) return;

    const env = parseGuestMessage(event.data);
    if (env) {
      this.invalidCount = 0;
      this.dispatch(env);
      return;
    }

    const result = parseStorageResult(event.data);
    if (result) {
      const pending = this.pendingStorage.get(result.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingStorage.delete(result.id);
        pending.resolve(result.payload ?? null);
      }
      return;
    }

    this.countInvalid();
  };

  private dispatch(env: Envelope): void {
    this.opts.onMessage?.(env);
    this.emit('message', env);

    switch (env.type) {
      case 'ready': {
        this.clearHandshake();
        const shim = (env.payload as { shim?: string } | undefined)?.shim;
        if (shim && shim !== SHIM_VERSION) {
          // A stale play-worker serves the old shim: the game renders but can
          // look frozen because input replay changed. Say so loudly.
          console.warn(`[playloop] guest shim ${shim} != sdk ${SHIM_VERSION} — restart the play-worker`);
        }
        // Replay the sticky init before anything else: safe-area and mute state
        // must be known before the guest draws its first HUD frame.
        if (Object.keys(this.initState).length > 0) this.post('init', this.initState);
        this.opts.onReady?.(env.payload);
        this.emit('ready', env.payload);
        break;
      }
      case 'gameOver': {
        this.opts.onGameOver?.(env.payload);
        this.emit('gameOver', env.payload);
        break;
      }
      case 'score': {
        this.opts.onScore?.(env.payload);
        this.emit('score', env.payload);
        break;
      }
      case 'log': {
        this.opts.onLog?.(env.payload);
        this.emit('log', env.payload);
        break;
      }
      case 'perf': {
        this.opts.onPerf?.(env.payload);
        this.emit('perf', env.payload);
        break;
      }
      case 'share': {
        this.opts.onShare?.(env.payload);
        this.emit('share', env.payload);
        break;
      }
      case 'haptic': {
        this.opts.onHaptic?.(env.payload);
        this.emit('haptic', env.payload);
        break;
      }
      case 'error': {
        const p = (env.payload ?? {}) as { message?: unknown; stack?: unknown };
        this.raiseError({
          message: typeof p.message === 'string' ? p.message : 'guest error',
          code: 'guest',
          stack: typeof p.stack === 'string' ? p.stack : undefined,
        });
        break;
      }
      default:
        break;
    }
  }

  private handleVisibility = (): void => {
    const hidden = this.doc?.hidden === true;
    if (hidden) {
      if (this.playing) {
        this.autoPaused = true;
        this.pause();
      }
    } else if (this.autoPaused) {
      this.autoPaused = false;
      this.resume();
    }
  };
}
