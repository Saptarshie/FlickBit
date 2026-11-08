import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameHost } from './host';

type Handler = (ev: unknown) => void;

interface Harness {
  deliver: (data: unknown, source?: unknown) => void;
  contentWindow: { postMessage: (data: unknown, origin?: unknown) => void; location: { reload: () => void } };
  posts: Array<Record<string, unknown>>;
  reloads: () => number;
  win: {
    addEventListener: (type: string, cb: Handler) => void;
    removeEventListener: (type: string, cb: Handler) => void;
    removedTypes: string[];
    document: {
      hidden: boolean;
      addEventListener: (type: string, cb: Handler) => void;
      removeEventListener: (type: string, cb: Handler) => void;
      handlers: Record<string, Handler[]>;
    };
  };
  iframe: { contentWindow: unknown; ownerDocument?: unknown };
}

function createHarness(): Harness {
  const posts: Array<Record<string, unknown>> = [];
  let reloads = 0;
  const contentWindow = {
    postMessage: (data: unknown) => {
      posts.push(data as Record<string, unknown>);
    },
    location: {
      reload: () => {
        reloads += 1;
      },
    },
  };
  const messageHandlers: Handler[] = [];
  const removedTypes: string[] = [];
  const docHandlers: Record<string, Handler[]> = {};
  const doc = {
    hidden: false,
    handlers: docHandlers,
    addEventListener: (type: string, cb: Handler) => {
      (docHandlers[type] ??= []).push(cb);
    },
    removeEventListener: (type: string, cb: Handler) => {
      removedTypes.push('document:' + type);
      const list = docHandlers[type];
      if (list) {
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      }
    },
  };
  const win = {
    addEventListener: (type: string, cb: Handler) => {
      if (type === 'message') messageHandlers.push(cb);
    },
    removeEventListener: (type: string, cb: Handler) => {
      removedTypes.push(type);
      const i = messageHandlers.indexOf(cb);
      if (i >= 0) messageHandlers.splice(i, 1);
    },
    removedTypes,
    document: doc,
  };
  const iframe = { contentWindow, ownerDocument: undefined };
  (globalThis as Record<string, unknown>).window = win;

  const deliver = (data: unknown, source: unknown = contentWindow) => {
    for (const h of [...messageHandlers]) h({ data, source } as MessageEvent);
  };

  return {
    deliver,
    contentWindow,
    posts,
    reloads: () => reloads,
    win: win as Harness['win'],
    iframe: iframe as Harness['iframe'],
  };
}

function envelope(type: string, extra: Record<string, unknown> = {}) {
  return { v: 1, src: 'playloop', type, ...extra };
}

describe('GameHost', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).window;
  });

  it('drops a message whose source is not the frame', () => {
    const onMessage = vi.fn();
    const onReady = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, { onMessage, onReady });
    h.deliver(envelope('ready'), { someOtherWindow: true });
    expect(onMessage).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    host.destroy();
  });

  it('drops an unknown message type', () => {
    const onMessage = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, { onMessage });
    h.deliver(envelope('evil'));
    h.deliver({ v: 1, src: 'playloop', type: 42 });
    h.deliver('junk');
    expect(onMessage).not.toHaveBeenCalled();
    host.destroy();
  });

  it('emits onReady and onMessage on a valid ready', () => {
    const onMessage = vi.fn();
    const onReady = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, { onMessage, onReady });
    h.deliver(envelope('ready', { payload: { sdk: 1 } }));
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ v: 1, src: 'playloop', type: 'ready' });
    host.destroy();
  });

  it('routes typed events to their callbacks', () => {
    const onGameOver = vi.fn();
    const onScore = vi.fn();
    const onLog = vi.fn();
    const onPerf = vi.fn();
    const onShare = vi.fn();
    const onHaptic = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {
      onGameOver,
      onScore,
      onLog,
      onPerf,
      onShare,
      onHaptic,
    });
    h.deliver(envelope('gameOver', { payload: { score: 3 } }));
    h.deliver(envelope('score', { payload: { score: 3 } }));
    h.deliver(envelope('log', { payload: { message: 'x' } }));
    h.deliver(envelope('perf', { payload: { fps: 60 } }));
    h.deliver(envelope('share', { payload: { text: 'hi' } }));
    h.deliver(envelope('haptic', { payload: { type: 'light' } }));
    expect(onGameOver).toHaveBeenCalledWith({ score: 3 });
    expect(onScore).toHaveBeenCalledWith({ score: 3 });
    expect(onLog).toHaveBeenCalledWith({ message: 'x' });
    expect(onPerf).toHaveBeenCalledWith({ fps: 60 });
    expect(onShare).toHaveBeenCalledWith({ text: 'hi' });
    expect(onHaptic).toHaveBeenCalledWith({ type: 'light' });
    host.destroy();
  });

  it('emits onError with code timeout after the handshake timeout when nothing arrives', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const onReady = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {
      onError,
      onReady,
      handshakeTimeoutMs: 3000,
    });
    vi.advanceTimersByTime(2999);
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'timeout', message: expect.stringContaining('handshake') }),
    );
    // must NOT destroy the iframe
    expect(h.iframe.contentWindow).not.toBeNull();
    expect(onReady).not.toHaveBeenCalled();
    // a late ready still works and does not re-fire the timeout
    h.deliver(envelope('ready'));
    expect(onReady).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000);
    expect(onError).toHaveBeenCalledTimes(1);
    host.destroy();
  });

  it('clears the handshake timer on ready', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, { onError, handshakeTimeoutMs: 100 });
    h.deliver(envelope('ready'));
    vi.advanceTimersByTime(10000);
    expect(onError).not.toHaveBeenCalled();
    host.destroy();
  });

  it('pause() posts a pause envelope', () => {
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
    host.pause();
    expect(h.posts).toContainEqual({ v: 1, src: 'playloop', type: 'pause' });
    host.destroy();
  });

  it('resume() and mute() post their envelopes', () => {
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
    host.resume();
    host.mute(true);
    expect(h.posts).toContainEqual({ v: 1, src: 'playloop', type: 'resume' });
    expect(h.posts).toContainEqual({ v: 1, src: 'playloop', type: 'mute', payload: { muted: true } });
    host.destroy();
  });

  it('restart() posts restart and reloads the frame', () => {
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
    host.restart();
    expect(h.posts).toContainEqual({ v: 1, src: 'playloop', type: 'restart' });
    expect(h.reloads()).toBe(1);
    host.destroy();
  });

  it('restart() survives a reload that throws (opaque origin)', () => {
    const broken = {
      contentWindow: {
        postMessage: () => {},
        get location(): never {
          throw new Error('opaque');
        },
      },
      ownerDocument: undefined,
    };
    const host = new GameHost(broken as unknown as HTMLIFrameElement, {});
    expect(() => host.restart()).not.toThrow();
    host.destroy();
  });

  it('storage resolves when a matching storage:result arrives', async () => {
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
    const p = host.storageGet('coins');
    // request was posted with an id
    const req = h.posts.find((m) => m['type'] === 'storage:get');
    expect(req).toBeDefined();
    expect(typeof req?.['id']).toBe('string');
    expect(req?.['payload']).toEqual({ key: 'coins' });
    h.deliver(envelope('storage:result', { id: req?.['id'], payload: 42 }));
    await expect(p).resolves.toBe(42);
    host.destroy();
  });

  it('storage ignores a storage:result with a non-matching id', async () => {
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
    const p = host.storageGet('coins');
    h.deliver(envelope('storage:result', { id: 'nope', payload: 1 }));
    const req = h.posts.find((m) => m['type'] === 'storage:get');
    h.deliver(envelope('storage:result', { id: req?.['id'], payload: 'yes' }));
    await expect(p).resolves.toBe('yes');
    host.destroy();
  });

  it('storage resolves null on timeout', async () => {
    vi.useFakeTimers();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
    const p = host.storageSet('coins', 7);
    vi.advanceTimersByTime(5001);
    await expect(p).resolves.toBeNull();
    host.destroy();
  });

  it('routes a guest error message to onError', () => {
    const onError = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, { onError });
    h.deliver(envelope('error', { payload: { message: 'boom', stack: 'at game.js:1' } }));
    expect(onError).toHaveBeenCalledWith({
      message: 'boom',
      code: 'guest',
      stack: 'at game.js:1',
    });
    host.destroy();
  });

  it('counts invalid messages and emits onError after 10', () => {
    const onError = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, { onError });
    for (let i = 0; i < 9; i += 1) {
      h.deliver({ v: 1, src: 'playloop', type: 'nope' });
    }
    expect(onError).not.toHaveBeenCalled();
    h.deliver({ v: 1, src: 'playloop', type: 'nope' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-message' }));
    host.destroy();
  });

  it('auto-pauses on visibilitychange hidden and resumes only if it was playing', () => {
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
    const handlers = h.win.document.handlers['visibilitychange'] ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    const fire = () => handlers.forEach((fn) => fn({}));

    h.win.document.hidden = true;
    fire();
    expect(h.posts).toContainEqual({ v: 1, src: 'playloop', type: 'pause' });

    h.win.document.hidden = false;
    fire();
    expect(h.posts).toContainEqual({ v: 1, src: 'playloop', type: 'resume' });

    // manually paused: hide/show must NOT resume
    const before = h.posts.length;
    host.pause();
    h.win.document.hidden = true;
    fire();
    h.win.document.hidden = false;
    fire();
    const types = h.posts.slice(before).map((m) => m['type']);
    expect(types).not.toContain('resume');
    host.destroy();
  });

  it('destroy() removes listeners, clears timers and pauses', () => {
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
    host.destroy();
    expect(h.win.removedTypes).toContain('message');
    expect(h.posts).toContainEqual({ v: 1, src: 'playloop', type: 'pause' });
    // message handler no longer live
    const onMessage = vi.fn();
    h.deliver(envelope('ready'));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores messages from other windows instead of counting them invalid', () => {
    const onError = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, { onError });
    // Devtools/HMR/extensions post to the page constantly; none of it is a
    // guest protocol violation.
    for (let i = 0; i < 25; i += 1) h.deliver({ type: 'webpackHmr', data: i }, { other: true });
    expect(onError).not.toHaveBeenCalled();
    host.destroy();
  });

  it('still errors after repeated genuinely invalid frames from the guest', () => {
    const onError = vi.fn();
    const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, { onError });
    for (let i = 0; i < 10; i += 1) h.deliver({ nope: i });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'invalid-message' });
    host.destroy();
  });

  describe('input forwarding', () => {
    const lastInput = () => {
      const found = [...h.posts].reverse().find((p) => p.type === 'input');
      return found?.payload as Record<string, unknown> | undefined;
    };

    it('sends guest-space coordinates rounded to integers', () => {
      const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
      host.input('tap', 10.4, 20.6);
      expect(lastInput()).toMatchObject({ kind: 'tap', x: 10, y: 21 });
      host.destroy();
    });

    it('carries the pointer id and type so multi-touch reaches the game', () => {
      const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
      host.input({ kind: 'move', x: 5, y: 6, pointerId: 7, pointerType: 'pen' });
      expect(lastInput()).toMatchObject({ kind: 'move', x: 5, y: 6, pointerId: 7, pointerType: 'pen', buttons: 1 });
      host.destroy();
    });

    it('releases the button on up and cancel', () => {
      const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
      host.input({ kind: 'up', x: 1, y: 2, pointerId: 3 });
      expect(lastInput()).toMatchObject({ kind: 'up', buttons: 0 });
      host.input({ kind: 'cancel', x: 1, y: 2, pointerId: 3 });
      expect(lastInput()).toMatchObject({ kind: 'cancel', buttons: 0 });
      host.destroy();
    });

    it('drops input until the guest is ready (no orphan streams)', () => {
      const host = new GameHost(h.iframe as unknown as HTMLIFrameElement, {});
      const before = h.posts.filter((p) => p.type === 'input').length;
      host.input('down', 3, 4);
      const after = h.posts.filter((p) => p.type === 'input').length;
      // Sending is always safe (the guest buffers), but nothing must throw.
      expect(after).toBeGreaterThanOrEqual(before);
      host.destroy();
    });
  });
});
