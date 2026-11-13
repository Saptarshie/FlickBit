import { describe, it, expect, afterEach } from 'vitest';
import { SHIM_SOURCE } from './shim-source';

describe('SHIM_SOURCE', () => {
  it('parses as a function body', () => {
    expect(() => new Function(SHIM_SOURCE)).not.toThrow();
  });

  it('contains no backticks and no dollar-brace sequences', () => {
    expect(SHIM_SOURCE).not.toContain('`');
    expect(SHIM_SOURCE).not.toContain('${');
  });

  it('contains the required markers', () => {
    expect(SHIM_SOURCE).toContain('ready');
    expect(SHIM_SOURCE).toContain('gameOver');
    expect(SHIM_SOURCE).toContain('requestAnimationFrame');
    expect(SHIM_SOURCE).toContain("src: 'playloop'");
    expect(SHIM_SOURCE).toContain('mulberry32');
  });

  it('never touches cookie, localStorage, fetch, XHR or WebSocket', () => {
    expect(SHIM_SOURCE).not.toContain('document.cookie');
    expect(SHIM_SOURCE).not.toContain('localStorage');
    expect(SHIM_SOURCE).not.toContain('fetch(');
    expect(SHIM_SOURCE).not.toContain('XMLHttpRequest');
    expect(SHIM_SOURCE).not.toContain('WebSocket');
  });

  it('wraps timers and rAF and suspends AudioContext', () => {
    expect(SHIM_SOURCE).toContain('setTimeout');
    expect(SHIM_SOURCE).toContain('setInterval');
    expect(SHIM_SOURCE).toContain('cancelAnimationFrame');
    expect(SHIM_SOURCE).toContain('AudioContext');
  });
});

interface FakeMsg {
  data: unknown;
  origin?: string;
}

function makeFakeWindow() {
  const posted: FakeMsg[] = [];
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const timeouts: Record<number, unknown> = {};
  const fakeWin: Record<string, unknown> = {
    parent: {
      postMessage: (data: unknown, origin?: string) => {
        posted.push({ data, origin });
      },
    },
    location: { search: '?seed=42', ancestorOrigins: ['http://host.test'] },
    addEventListener: (type: string, cb: (ev: unknown) => void) => {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener: () => {},
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: unknown) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
    setInterval: (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id: unknown) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
    requestAnimationFrame: (fn: (t: number) => void) => globalThis.setTimeout(() => fn(Date.now()), 16),
    cancelAnimationFrame: (id: unknown) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
    performance: { now: () => Date.now() },
  };
  return { fakeWin, posted, listeners, timeouts };
}

function makeFakeDocument() {
  return {
    head: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
    createElement: () => ({ textContent: '' }),
  };
}

describe('canvas guard', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  });

  it('clamps non-finite gradient arguments instead of throwing', () => {
    const { fakeWin } = makeFakeWindow();
    const calls: number[][] = [];
    // Mimic the real 2D context: throw on a non-finite argument.
    function FakeCtx() {}
    (FakeCtx as unknown as { prototype: Record<string, unknown> }).prototype = {
      createRadialGradient: function (x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) {
        const args = [x0, y0, r0, x1, y1, r1];
        if (args.some((n) => !Number.isFinite(n))) {
          throw new TypeError('The provided double value is non-finite.');
        }
        calls.push(args);
        return { addColorStop: () => {} };
      },
      arc: function (x: number, y: number, r: number) {
        if (![x, y, r].every(Number.isFinite) || r < 0) throw new Error('bad arc');
        calls.push([x, y, r]);
      },
    };
    fakeWin['CanvasRenderingContext2D'] = FakeCtx;
    (globalThis as Record<string, unknown>).window = fakeWin;
    (globalThis as Record<string, unknown>).document = makeFakeDocument();

    new Function(SHIM_SOURCE)();

    const proto = (FakeCtx as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> }).prototype;
    expect(() => proto.createRadialGradient!(NaN, 0, 4, 0, 0, Infinity)).not.toThrow();
    expect(() => proto.arc!(10, 10, Number.NEGATIVE_INFINITY)).not.toThrow();

    // Every argument the real context saw was finite and radii non-negative.
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.every(Number.isFinite)).toBe(true);
      expect(call.every((n) => n >= 0 || call.length === 6 ? true : n >= 0)).toBe(true);
    }
  });
});

describe('SHIM_SOURCE execution smoke', () => {
  const originalDateNow = Date.now;

  afterEach(() => {
    Date.now = originalDateNow;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  });

  it('installs window.PlayLoop and posts ready on window load', () => {
    const { fakeWin, posted, listeners } = makeFakeWindow();
    (globalThis as Record<string, unknown>).window = fakeWin;
    (globalThis as Record<string, unknown>).document = makeFakeDocument();

    new Function(SHIM_SOURCE)();

    const api = fakeWin['PlayLoop'] as Record<string, unknown>;
    expect(api).toBeDefined();
    expect(typeof api['ready']).toBe('function');
    expect(typeof api['gameOver']).toBe('function');
    expect(typeof api['submitScore']).toBe('function');
    expect(typeof (api['storage'] as Record<string, unknown>)['get']).toBe('function');
    expect(typeof (api['storage'] as Record<string, unknown>)['set']).toBe('function');
    expect(typeof api['rng']).toBe('function');
    expect(typeof api['haptic']).toBe('function');
    expect(typeof api['share']).toBe('function');
    expect(typeof api['log']).toBe('function');
    // Defaults describe the app chrome, so a game that reads them in its
    // constructor still draws somewhere visible.
    expect(api['safeArea']).toEqual({ top: 80, right: 72, bottom: 70 });
    expect(typeof api['onPause']).toBe('function');
    expect(typeof api['onResume']).toBe('function');
    expect(typeof api['onRestart']).toBe('function');

    // no ready yet, then window load fires -> ready posted
    expect(posted.length).toBe(0);
    for (const fn of listeners['load'] ?? []) fn({});
    expect(posted).toContainEqual({
      data: { v: 1, src: 'playloop', type: 'ready', payload: { shim: '1.2.0' } },
      origin: '*',
    });
  });

  it('pauses a running game and resumes it on host resume', async () => {
    const { fakeWin, listeners } = makeFakeWindow();
    (globalThis as Record<string, unknown>).window = fakeWin;
    (globalThis as Record<string, unknown>).document = makeFakeDocument();
    new Function(SHIM_SOURCE)();
    const fire = (type: string) => {
      for (const fn of listeners['message'] ?? []) fn({ data: { v: 1, src: 'playloop', type }, origin: 'http://host.test', source: fakeWin['parent'] });
    };

    // Paint one frame so a pause is honoured (never freeze before first paint).
    await new Promise<void>((resolve) => {
      (fakeWin['requestAnimationFrame'] as (cb: () => void) => number)(() => resolve());
    });

    fire('pause');
    let ranWhilePaused = false;
    (fakeWin['setTimeout'] as (cb: () => void, ms: number) => number)(() => { ranWhilePaused = true; }, 0);
    await new Promise((r) => setTimeout(r, 25));
    expect(ranWhilePaused).toBe(false);

    fire('resume');
    let ranAfterResume = false;
    (fakeWin['setTimeout'] as (cb: () => void, ms: number) => number)(() => { ranAfterResume = true; }, 0);
    await new Promise((r) => setTimeout(r, 25));
    expect(ranAfterResume).toBe(true);
  });

  it('a resume cancels a pause that arrived before the first frame', async () => {
    const { fakeWin, listeners } = makeFakeWindow();
    (globalThis as Record<string, unknown>).window = fakeWin;
    (globalThis as Record<string, unknown>).document = makeFakeDocument();
    new Function(SHIM_SOURCE)();
    const fire = (type: string) => {
      for (const fn of listeners['message'] ?? []) fn({ data: { v: 1, src: 'playloop', type }, origin: 'http://host.test', source: fakeWin['parent'] });
    };

    // Mount order: the host pauses before the game ever painted, then the card
    // becomes active and resumes. The deferred pause must not survive.
    fire('pause');
    fire('resume');

    let ran = false;
    (fakeWin['setTimeout'] as (cb: () => void, ms: number) => number)(() => { ran = true; }, 0);
    await new Promise((r) => setTimeout(r, 25));
    expect(ran).toBe(true);
  });

  it('a game calling ready() earlier suppresses the load fallback', () => {
    const { fakeWin, posted, listeners } = makeFakeWindow();
    (globalThis as Record<string, unknown>).window = fakeWin;
    (globalThis as Record<string, unknown>).document = makeFakeDocument();
    new Function(SHIM_SOURCE)();
    (fakeWin['PlayLoop'] as { ready: () => void }).ready();
    for (const fn of listeners['load'] ?? []) fn({});
    const readies = posted.filter((m) => (m.data as { type?: string }).type === 'ready');
    expect(readies.length).toBe(1);
  });

  it('storage.get resolves from a matching storage:result and null on timeout', async () => {
    const { fakeWin, posted, listeners } = makeFakeWindow();
    (globalThis as Record<string, unknown>).window = fakeWin;
    (globalThis as Record<string, unknown>).document = makeFakeDocument();
    new Function(SHIM_SOURCE)();
    const api = fakeWin['PlayLoop'] as { storage: { get: (k: string) => Promise<unknown> } };

    const p = api.storage.get('coins');
    const req = posted.find((m) => (m.data as { type?: string }).type === 'storage:get');
    expect(req).toBeDefined();
    const id = (req?.data as { id?: string }).id;
    expect(typeof id).toBe('string');
    for (const fn of listeners['message'] ?? []) {
      fn({ source: fakeWin['parent'], origin: 'http://host.test', data: { v: 1, src: 'playloop', type: 'storage:result', id, payload: 7 } });
    }
    await expect(p).resolves.toBe(7);

    // timeout path
    const p2 = api.storage.get('other');
    await new Promise((r) => setTimeout(r, 3100));
    await expect(p2).resolves.toBeNull();
  }, 10000);

  it('pause queues rAF callbacks and fires them on resume', () => {
    const { fakeWin, listeners } = makeFakeWindow();
    (globalThis as Record<string, unknown>).window = fakeWin;
    (globalThis as Record<string, unknown>).document = makeFakeDocument();
    new Function(SHIM_SOURCE)();

    const fire = (type: string, data: unknown) => {
      for (const fn of listeners['message'] ?? []) fn({ source: fakeWin['parent'], origin: 'http://host.test', data });
    };

    let fired = 0;
    const raf = fakeWin['requestAnimationFrame'] as (fn: (t: number) => void) => number;
    // pause first, then register rAF: must NOT run while paused
    fire('message', undefined); // noise, ignored
    fire('pause-malformed', {});
    for (const fn of listeners['message'] ?? []) {
      fn({ source: fakeWin['parent'], origin: 'http://host.test', data: { v: 1, src: 'playloop', type: 'pause' } });
    }
    raf(() => {
      fired += 1;
    });
    expect(fired).toBe(0);
    for (const fn of listeners['message'] ?? []) {
      fn({ source: fakeWin['parent'], origin: 'http://host.test', data: { v: 1, src: 'playloop', type: 'resume' } });
    }
    // queued rAF fires on resume (via a real rAF -> timer)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(fired).toBe(1);
        resolve();
      }, 60);
    });
  });
});
