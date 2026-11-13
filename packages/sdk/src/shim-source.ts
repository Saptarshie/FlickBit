/**
 * Self-contained guest shim, injected inline at the top of <head> by the play
 * Worker. Plain ES2017 IIFE, no imports. The body is a String.raw literal so it
 * must contain NO backtick characters and NO "${" sequences.
 */
export const SHIM_SOURCE = String.raw`
(function () {
  'use strict';
  var w = window;
  if (w.PlayLoop && w.PlayLoop.__shim) { return; }

  // Origin of the page embedding this frame. ancestorOrigins survives the
  // opaque origin that sandbox="allow-scripts" gives us.
  var parentOrigin = null;
  try {
    var ancestors = w.location && w.location.ancestorOrigins;
    if (ancestors && ancestors.length) { parentOrigin = ancestors[0]; }
  } catch (e) { parentOrigin = null; }

  var realDateNow = Date.now;
  var realPerfNow = null;
  try {
    if (w.performance && typeof w.performance.now === 'function') {
      realPerfNow = w.performance.now.bind(w.performance);
    }
  } catch (e) {}

  /* ---- transport: rate limited (<= 60 posts per second) ---- */
  var postWindowStart = 0;
  var postCount = 0;
  function canPost() {
    var now = realDateNow.call(Date);
    if (now - postWindowStart >= 1000) { postWindowStart = now; postCount = 0; }
    if (postCount >= 60) { return false; }
    postCount += 1;
    return true;
  }
  function post(type, payload, id) {
    if (!canPost()) { return; }
    var msg = { v: 1, src: 'playloop', type: type };
    if (id !== undefined && id !== null) { msg.id = id; }
    if (payload !== undefined) {
      try {
        if (JSON.stringify(payload).length > 8192) { return; }
      } catch (e) { return; }
      msg.payload = payload;
    }
    try { w.parent.postMessage(msg, '*'); } catch (e) {}
  }

  /* ---- error reporting (rate limited to 20) ---- */
  var errorCount = 0;
  function postError(message, stack) {
    if (errorCount >= 20) { return; }
    errorCount += 1;
    var payload = { message: String(message) };
    if (stack) { payload.stack = String(stack); }
    post('error', payload);
  }
  w.onerror = function (message, source, lineno, colno, error) {
    if (error && error.stack) { postError(error.message || message, error.stack); }
    else { postError(message, source ? String(source) + ':' + String(lineno) + ':' + String(colno) : ''); }
    return true;
  };
  try {
    w.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      if (r && r.stack) { postError(r.message || r, r.stack); }
      else { postError(r, ''); }
    });
  } catch (e) {}

  /* ---- neutralised globals: never block, never open popups ---- */
  w.open = function () { return null; };
  w.alert = function () { return false; };
  w.confirm = function () { return false; };
  w.prompt = function () { return null; };

  /* ---- injected CSS: no scroll, no zoom, no text selection ---- */
  try {
    var style = document.createElement('style');
    style.textContent = 'html,body{margin:0;padding:0;height:100%;touch-action:none;overscroll-behavior:none;-webkit-user-select:none;user-select:none;}';
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}

  /* ---- virtual clock: frozen while paused, shifted on resume ---- */
  var paused = false;
  var clockOffset = 0;
  var pauseStartReal = 0;
  var pauseStartPerf = 0;
  function vnow() {
    if (paused) { return pauseStartReal - clockOffset; }
    return realDateNow.call(Date) - clockOffset;
  }
  function vTimestamp() {
    if (!realPerfNow) { return vnow(); }
    if (paused) { return pauseStartPerf - clockOffset; }
    return realPerfNow() - clockOffset;
  }
  Date.now = function () { return vnow(); };
  try {
    if (realPerfNow) { w.performance.now = function () { return vTimestamp(); }; }
  } catch (e) {}

  /* ---- timers: queued and deferred while paused ---- */
  var realSetTimeout = w.setTimeout.bind(w);
  var realClearTimeout = w.clearTimeout.bind(w);
  var timers = {};
  var timerSeq = 0;

  function scheduleTimer(entry) {
    if (paused) { entry.realId = null; return; }
    var delay = entry.vDeadline - vnow();
    if (delay < 0) { delay = 0; }
    entry.realId = realSetTimeout(function () { fireTimer(entry); }, delay);
  }
  function fireTimer(entry) {
    if (paused) { return; }
    if (entry.interval) {
      entry.vDeadline += entry.interval;
      scheduleTimer(entry);
    } else {
      delete timers[entry.id];
    }
    entry.fn.apply(null, entry.args);
  }
  w.setTimeout = function (fn, ms) {
    var id = ++timerSeq;
    var entry = { id: id, fn: fn, args: [].slice.call(arguments, 2), vDeadline: vnow() + (Number(ms) || 0), interval: 0, realId: null };
    timers[id] = entry;
    scheduleTimer(entry);
    return id;
  };
  w.setInterval = function (fn, ms) {
    var id = ++timerSeq;
    var interval = Number(ms) || 1;
    var entry = { id: id, fn: fn, args: [].slice.call(arguments, 2), vDeadline: vnow() + interval, interval: interval, realId: null };
    timers[id] = entry;
    scheduleTimer(entry);
    return id;
  };
  w.clearTimeout = function (id) {
    var entry = timers[id];
    if (!entry) { return; }
    if (entry.realId !== null && entry.realId !== undefined) { realClearTimeout(entry.realId); }
    delete timers[id];
  };
  w.clearInterval = function (id) { w.clearTimeout(id); };

  /* ---- requestAnimationFrame: queued and deferred while paused ---- */
  var rafs = {};
  var rafSeq = 0;
  var frameCount = 0;
  var perfWindow = 0;
  var hasPainted = false;
  var pendingPause = false;
  var realRaf = w.requestAnimationFrame
    ? w.requestAnimationFrame.bind(w)
    : function (fn) { return realSetTimeout(function () { fn(vTimestamp()); }, 16); };
  var realCaf = w.cancelAnimationFrame ? w.cancelAnimationFrame.bind(w) : realClearTimeout;

  w.requestAnimationFrame = function (fn) {
    var id = ++rafSeq;
    var entry = { fn: fn, realId: null, queued: true };
    rafs[id] = entry;
    if (!paused) { attachRaf(id); }
    return id;
  };
  w.cancelAnimationFrame = function (id) {
    var entry = rafs[id];
    if (!entry) { return; }
    if (entry.realId !== null && entry.realId !== undefined) { realCaf(entry.realId); }
    delete rafs[id];
  };
  function attachRaf(id) {
    var entry = rafs[id];
    if (!entry) { return; }
    entry.queued = false;
    entry.realId = realRaf(function () {
      if (rafs[id] !== entry) { return; }
      if (paused) { entry.queued = true; entry.realId = null; return; }
      delete rafs[id];
      hasPainted = true;
      syncDbg();
      sampleFps();
      entry.fn(vTimestamp());
      if (pendingPause && !paused) { setPaused(true); }
    });
  }
  /* fps probe: sample frames and post perf about every 2s */
  function sampleFps() {
    frameCount += 1;
    var now = vTimestamp();
    if (!perfWindow) { perfWindow = now; return; }
    var elapsed = now - perfWindow;
    if (elapsed >= 2000) {
      post('perf', { fps: Math.round((frameCount * 1000) / elapsed) });
      frameCount = 0;
      perfWindow = now;
    }
  }

  /* ---- AudioContext: created contexts are suspended on pause ---- */
  var audioCtxs = [];
  function shimAudio(Real) {
    function Shimmed() {
      var ctx = Reflect.construct(Real, arguments, Real);
      if (audioCtxs.indexOf(ctx) === -1) { audioCtxs.push(ctx); }
      return ctx;
    }
    Shimmed.prototype = Real.prototype;
    return Shimmed;
  }
  try {
    var RealAudio = w.AudioContext || w.webkitAudioContext;
    if (RealAudio) {
      var ShimmedAudio = shimAudio(RealAudio);
      w.AudioContext = ShimmedAudio;
      w.webkitAudioContext = ShimmedAudio;
    }
  } catch (e) {}
  /* ---- mute: route every connection to the destination through one gain ---- */
  // Games create their own oscillators and connect them straight to
  // ctx.destination, so setting a flag was never going to silence them. Patch
  // AudioNode.connect so any connection to the destination goes through a
  // master gain we control.
  var masterGain = null;
  function masterFor(ctx) {
    if (!ctx || typeof ctx.createGain !== 'function') { return null; }
    if (masterGain && masterGain.context === ctx) { return masterGain; }
    try {
      masterGain = ctx.createGain();
      masterGain.gain.value = muted ? 0 : 1;
      masterGain.connect(ctx.destination);
      return masterGain;
    } catch (e) {
      masterGain = null;
      return null;
    }
  }
  function applyMute() {
    if (!masterGain) { return; }
    try { masterGain.gain.value = muted ? 0 : 1; } catch (e) {}
  }
  try {
    var AudioNodeProto = w.AudioNode && w.AudioNode.prototype;
    var originalConnect = AudioNodeProto && AudioNodeProto.connect;
    if (originalConnect) {
      AudioNodeProto.connect = function connect(destination) {
        if (destination && this && this.context && destination === this.context.destination) {
          var master = masterFor(this.context);
          if (master && master !== this) {
            var args = Array.prototype.slice.call(arguments, 1);
            return originalConnect.apply(this, [master].concat(args));
          }
        }
        return originalConnect.apply(this, arguments);
      };
    }
  } catch (e) {}

  function eachAudio(fn) {
    for (var i = 0; i < audioCtxs.length; i += 1) {
      try {
        var p = fn(audioCtxs[i]);
        if (p && typeof p.catch === 'function') { p.catch(function () {}); }
      } catch (e) {}
    }
  }

  /* ---- canvas guard: one NaN must not kill the game ---- */
  // Generated games routinely compute a radius from a value that can go
  // non-finite (a charge ratio, a delta time, a normalised distance). The Canvas
  // 2D API throws on the first bad argument: createRadialGradient dies with
  // "The provided double value is non-finite" and the whole game freezes on that
  // frame, which is exactly what a player reported. Clamp at the API boundary so
  // a bad frame degrades instead of ending the session.
  function finiteNumber(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }
  function clampRadius(value, fallback) {
    var n = finiteNumber(value, fallback);
    return n < 0 ? 0 : n;
  }
  try {
    var CtxProto = w.CanvasRenderingContext2D && w.CanvasRenderingContext2D.prototype;
    if (CtxProto) {
      var guardMethods = {
        createLinearGradient: function (a) {
          return [finiteNumber(a[0], 0), finiteNumber(a[1], 0), finiteNumber(a[2], 0), finiteNumber(a[3], 0)];
        },
        createRadialGradient: function (a) {
          return [
            finiteNumber(a[0], 0), finiteNumber(a[1], 0), clampRadius(a[2], 0),
            finiteNumber(a[3], 0), finiteNumber(a[4], 0), clampRadius(a[5], 1),
          ];
        },
        createPattern: function () { return null; },
        arc: function (a) {
          return [finiteNumber(a[0], 0), finiteNumber(a[1], 0), clampRadius(a[2], 0), finiteNumber(a[3], 0), finiteNumber(a[4], 6.283)];
        },
        ellipse: function (a) {
          return [
            finiteNumber(a[0], 0), finiteNumber(a[1], 0), clampRadius(a[2], 0), clampRadius(a[3], 0),
            finiteNumber(a[4], 0), finiteNumber(a[5], 0), finiteNumber(a[6], 6.283),
          ];
        },
        rect: function (a) {
          return [finiteNumber(a[0], 0), finiteNumber(a[1], 0), finiteNumber(a[2], 0), finiteNumber(a[3], 0)];
        },
        roundRect: function (a) {
          return [finiteNumber(a[0], 0), finiteNumber(a[1], 0), finiteNumber(a[2], 0), finiteNumber(a[3], 0), a[4]];
        },
        translate: function (a) { return [finiteNumber(a[0], 0), finiteNumber(a[1], 0)]; },
        scale: function (a) { return [finiteNumber(a[0], 1), finiteNumber(a[1], 1)]; },
        rotate: function (a) { return [finiteNumber(a[0], 0)]; },
      };
      Object.keys(guardMethods).forEach(function (name) {
        var original = CtxProto[name];
        if (typeof original !== 'function') { return; }
        var normalise = guardMethods[name];
        CtxProto[name] = function guarded() {
          var args = Array.prototype.slice.call(arguments);
          var safe = normalise(args);
          for (var i = 0; i < safe.length; i += 1) { args[i] = safe[i]; }
          try {
            return original.apply(this, args);
          } catch (e) {
            // A drawing call must never take the loop down; report once.
            postError('canvas: ' + (e && e.message ? e.message : e), '');
            return undefined;
          }
        };
      });
    }
  } catch (e) {}

  /* ---- pause / resume (honourable even for non-cooperative games) ---- */
  var pauseCbs = [];
  var resumeCbs = [];
  var restartCbs = [];
  function fireCbs(list) {
    for (var i = 0; i < list.length; i += 1) {
      try { list[i](); } catch (e) { postError(e && e.message ? e.message : e, e && e.stack ? e.stack : ''); }
    }
  }
  // Debug surface for support: readable from the host with Playwright/CDP even
  // though the frame is sandboxed. window.__plDebug answers "did the game get
  // the tap?" and "is its loop running?" without a build.
  var SHIM_VERSION = '1.2.0';
  var dbg = { version: SHIM_VERSION, paused: false, pendingPause: false, hasPainted: false, rafs: 0, inputs: 0, messages: 0, resumes: 0, pauses: 0 };
  w.__plDebug = dbg;

  function syncDbg() {
    dbg.paused = paused;
    dbg.pendingPause = pendingPause;
    dbg.hasPainted = hasPainted;
    var n = 0;
    for (var k in rafs) { if (Object.prototype.hasOwnProperty.call(rafs, k)) { n += 1; } }
    dbg.rafs = n;
  }

  function setPaused(next) {
    // A resume always cancels a deferred pause; otherwise the game would paint
    // its first frame and then freeze forever (inputs land, nothing redraws).
    if (!next) { pendingPause = false; }
    if (next === paused) { return; }
    if (next) { dbg.pauses += 1; } else { dbg.resumes += 1; }
    if (next && !hasPainted) { pendingPause = true; dbg.pendingPause = true; return; }
    if (next) {
      pendingPause = false;
      paused = true;
      pauseStartReal = realDateNow.call(Date);
      pauseStartPerf = realPerfNow ? realPerfNow() : pauseStartReal;
      for (var id in timers) {
        if (Object.prototype.hasOwnProperty.call(timers, id)) {
          var t = timers[id];
          if (t.realId !== null && t.realId !== undefined) { realClearTimeout(t.realId); t.realId = null; }
        }
      }
      for (var rid in rafs) {
        if (Object.prototype.hasOwnProperty.call(rafs, rid)) {
          var r = rafs[rid];
          if (r.realId !== null && r.realId !== undefined) { realCaf(r.realId); r.realId = null; }
          r.queued = true;
        }
        syncDbg();
      }
      eachAudio(function (c) { return c.suspend && c.suspend(); });
    } else {
      clockOffset += realDateNow.call(Date) - pauseStartReal;
      paused = false;
      for (var id2 in timers) {
        if (Object.prototype.hasOwnProperty.call(timers, id2)) { scheduleTimer(timers[id2]); }
      }
      var flush = [];
      for (var rid2 in rafs) {
        if (Object.prototype.hasOwnProperty.call(rafs, rid2) && rafs[rid2].queued) { flush.push(rid2); }
      }
      for (var i = 0; i < flush.length; i += 1) { attachRaf(flush[i]); }
      eachAudio(function (c) { return c.resume && c.resume(); });
      syncDbg();
    }
  }

  /* ---- storage routed through the host (opaque origin has none) ---- */
  var pending = {};
  var storageSeq = 0;
  function storageRequest(type, payload) {
    return new Promise(function (resolve) {
      var id = 's' + (++storageSeq);
      var timer = realSetTimeout(function () {
        delete pending[id];
        resolve(null);
      }, 3000);
      pending[id] = { resolve: resolve, timer: timer };
      post(type, payload, id);
    });
  }
  var storage = {
    get: function (key) { return storageRequest('storage:get', { key: String(key) }); },
    set: function (key, value) { return storageRequest('storage:set', { key: String(key), value: value }); }
  };

  /* ---- seeded PRNG (mulberry32) ---- */
  function mulberry32(a) {
    a = a | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedToInt(seed) {
    if (typeof seed === 'number' && isFinite(seed)) { return seed | 0; }
    var s = String(seed);
    var n = Number(s);
    if (isFinite(n)) { return n | 0; }
    var h = 0;
    for (var i = 0; i < s.length; i += 1) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
    return h;
  }
  function querySeed() {
    try {
      var q = String(w.location.search || '').replace(/^\?/, '');
      var parts = q.split('&');
      for (var i = 0; i < parts.length; i += 1) {
        var kv = parts[i].split('=');
        if (decodeURIComponent(kv[0] || '') === 'seed' && kv.length > 1) {
          return seedToInt(decodeURIComponent(kv.slice(1).join('=')));
        }
      }
    } catch (e) {}
    return null;
  }
  var initSeed = null;
  function rng(seed) {
    var s;
    if (seed !== undefined && seed !== null) { s = seedToInt(seed); }
    else {
      var q = querySeed();
      if (q !== null) { s = q; }
      else if (initSeed !== null) { s = initSeed; }
      else { s = (Math.random() * 2147483647) | 0; }
    }
    return mulberry32(s);
  }

  /* ---- public API ---- */
  var readySent = false;
  // Defaults are the real chrome, not zero: a game that reads safeArea once in
  // its constructor (before the host's init message arrives) used to place its HUD
  // under the app's profile row and never move it. The host refines these on
  // every ready; until then, these are correct for the app as shipped.
  var safeArea = { top: 80, right: 72, bottom: 70 };
  var muted = false;

  var api = {
    __shim: true,
    ready: function () {
      if (readySent) { return; }
      readySent = true;
      post('ready', { shim: SHIM_VERSION });
    },
    gameOver: function (opts) {
      var p = {};
      opts = opts || {};
      if (typeof opts.score === 'number' && isFinite(opts.score)) { p.score = opts.score; }
      if (typeof opts.won === 'boolean') { p.won = opts.won; }
      if (opts.stats && typeof opts.stats === 'object') { p.stats = opts.stats; }
      post('gameOver', p);
    },
    submitScore: function (n) {
      post('score', { score: Number(n) });
    },
    storage: storage,
    rng: rng,
    haptic: function (type) {
      post('haptic', { type: String(type) });
    },
    share: function (text) {
      post('share', (text === undefined || text === null) ? {} : { text: String(text) });
    },
    log: function (msg) {
      post('log', { message: String(msg) });
    },
    safeArea: safeArea,
    onPause: function (cb) { if (typeof cb === 'function') { pauseCbs.push(cb); } },
    onResume: function (cb) { if (typeof cb === 'function') { resumeCbs.push(cb); } },
    onRestart: function (cb) { if (typeof cb === 'function') { restartCbs.push(cb); } }
  };
  w.PlayLoop = api;

  /* ---- host to guest messages ---- */
  var activeTarget = null;
  var activePointerId = 1;

  function dispatchInput(p) {
    dbg.inputs += 1;
    syncDbg();
    var kind = String(p.kind || 'tap');
    var x = Number(p.x) || 0;
    var y = Number(p.y) || 0;
    var pointerId = Number(p.pointerId) || 1;
    var pointerType = p.pointerType || 'touch';
    var buttons = p.buttons === 0 ? 0 : 1;
    var doc = w.document;
    var hit = null;
    try { hit = doc.elementFromPoint(x, y) || doc.body; } catch (e) { hit = doc.body; }
    if (!hit) { return; }

    // Pointer capture by hand: a game listening on its canvas keeps receiving
    // move/up even when the finger travels outside it, exactly like the native
    // setPointerCapture behaviour games expect.
    var el = (kind === 'move' || kind === 'up' || kind === 'cancel') && activeTarget ? activeTarget : hit;
    if (kind === 'down' || kind === 'tap') { activeTarget = hit; activePointerId = pointerId; }
    if (kind === 'up' || kind === 'cancel') { activeTarget = null; }

    function pointer(type) {
      var ev;
      try {
        ev = new w.PointerEvent(type, {
          clientX: x, clientY: y, bubbles: true, cancelable: true,
          pointerId: pointerId, pointerType: pointerType, isPrimary: pointerId === 1,
          buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : buttons,
          pressure: type === 'pointerup' || type === 'pointercancel' ? 0 : 0.5
        });
      } catch (e) {
        var name = type === 'pointerdown' ? 'mousedown' : (type === 'pointerup' ? 'mouseup' : 'mousemove');
        ev = new w.MouseEvent(name, { clientX: x, clientY: y, bubbles: true, cancelable: true });
      }
      try { el.dispatchEvent(ev); } catch (e) {}
    }
    function touch(type) {
      try {
        if (!w.Touch || !w.TouchEvent) { return; }
        var t = new w.Touch({ identifier: pointerId, target: el, clientX: x, clientY: y });
        var ended = type === 'touchend' || type === 'touchcancel';
        el.dispatchEvent(new w.TouchEvent(type, {
          touches: ended ? [] : [t],
          targetTouches: ended ? [] : [t],
          changedTouches: [t], bubbles: true, cancelable: true
        }));
      } catch (e) {}
    }

    if (kind === 'tap') {
      touch('touchstart'); pointer('pointerdown'); pointer('pointerup'); touch('touchend');
    } else if (kind === 'down') {
      touch('touchstart'); pointer('pointerdown');
    } else if (kind === 'move') {
      touch('touchmove'); pointer('pointermove');
    } else if (kind === 'up') {
      pointer('pointerup'); touch('touchend');
    } else if (kind === 'cancel') {
      pointer('pointercancel'); touch('touchcancel');
    }
  }

  w.addEventListener('message', function (ev) {
    try {
      var d = ev.data;
      if (!d || d.v !== 1 || d.src !== 'playloop' || typeof d.type !== 'string') { return; }
      dbg.messages += 1;
      // Sandboxed frames (allow-scripts, opaque origin) hand back a different
      // WindowProxy for the parent, so identity comparison is not reliable and
      // dropped every host message — pause/resume/input never arrived. Anchor
      // on the embedding origin instead, which ancestorOrigins still exposes.
      if (parentOrigin) {
        if (ev.origin !== parentOrigin) { return; }
      } else if (ev.source && w.parent && ev.source !== w.parent) {
        return;
      }
      if (d.type === 'init') {
        var p = d.payload || {};
        if (p.safeArea) {
          var top = Number(p.safeArea.top);
          var bottom = Number(p.safeArea.bottom);
          var right = Number(p.safeArea.right);
          safeArea.top = isFinite(top) ? top : 0;
          safeArea.bottom = isFinite(bottom) ? bottom : 0;
          safeArea.right = isFinite(right) ? right : 0;
        }
        if (p.seed !== undefined && p.seed !== null) { initSeed = seedToInt(p.seed); }
        if (typeof p.muted === 'boolean') { muted = p.muted; applyMute(); }
      } else if (d.type === 'pause') {
        setPaused(true);
        fireCbs(pauseCbs);
      } else if (d.type === 'resume') {
        setPaused(false);
        fireCbs(resumeCbs);
      } else if (d.type === 'restart') {
        fireCbs(restartCbs);
      } else if (d.type === 'mute') {
        muted = !!(d.payload && d.payload.muted);
        applyMute();
      } else if (d.type === 'input') {
        dispatchInput(d.payload || {});
      } else if (d.type === 'storage:result') {
        var pend = d.id ? pending[d.id] : null;
        if (pend) {
          realClearTimeout(pend.timer);
          delete pending[d.id];
          pend.resolve(d.payload === undefined ? null : d.payload);
        }
      }
    } catch (e) {
      postError(e && e.message ? e.message : e, e && e.stack ? e.stack : '');
    }
  });

  /* ---- ready on window load if the game never called ready() ---- */
  w.addEventListener('load', function () {
    if (!readySent) {
      readySent = true;
      post('ready', { shim: SHIM_VERSION });
    }
  });
})();
`;
