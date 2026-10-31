# 03 — Game Artifact Spec (the core contract)

## Artifact
- One UTF-8 `.html` file, <= 300 KB (hard limit 500 KB), content-addressed: id = sha256(bytes).
- Must work with no network (except allowlisted CDNs in Phase 4). Inline JS/CSS. Images as inline SVG/canvas drawing/data-URIs. Audio via WebAudio synth (no files).
- Must render responsively in a 9:16 portrait box AND adapt to landscape/desktop (letterbox). Use `<meta name=viewport>`; canvas sized from `window.innerWidth/innerHeight` and `devicePixelRatio` (cap 2).
- Must start within 1s of load, show a first interactive frame, and be playable with ONE finger (tap/drag/swipe) or keyboard on desktop.
- Session length target 15-90s per run; clear fail/win state; calls `PlayLoop.gameOver()`.

## Required manifest (HTML comment or `<script type="application/json" id="pl-manifest">`)
```json
{ "title":"", "description":"", "controls":"tap|drag|swipe|tilt|keys", "orientation":"portrait|landscape|any",
  "sdkVersion":1, "tags":["arcade"], "scoring":"higher|lower|none" }
```

## Sandbox
iframe attrs: `sandbox="allow-scripts"` (NO allow-same-origin, allow-top-navigation, allow-forms, allow-popups, allow-modals), `allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"`, `referrerpolicy="no-referrer"`, `loading="eager"` for next-1, `credentialless` where supported.
Opaque origin => no cookies, no localStorage (it throws). SDK therefore provides storage through the host.

CSP header on play origin:
```
default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline';
img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none';
frame-src 'none'; form-action 'none'; base-uri 'none'
```
(unsafe-eval kept because many games use `new Function`; revisit.) `connect-src 'none'` blocks exfiltration/tracking. Phase 4 may add allowlisted CDN script hosts (cdnjs, jsdelivr pinned versions with SRI).

## SDK: `playloop.js` (guest side) — injected by the play Worker at the top of `<head>`
Games MUST NOT bundle it; Worker injects `<script>` inline. Global `PlayLoop`:
```ts
PlayLoop.ready(): void               // call when first frame drawn
PlayLoop.onPause(cb) / onResume(cb)  // host pauses when card scrolls away / tab hidden; game MUST freeze loop & audio
PlayLoop.onRestart(cb)               // host requests fresh run
PlayLoop.gameOver({score?:number, won?:boolean, stats?:object}): void
PlayLoop.submitScore(n:number): void
PlayLoop.storage.get(key):Promise<any>; set(key,val):Promise<void>   // <=16KB per game per user, via host
PlayLoop.rng(seed?): ()=>number      // seeded PRNG (daily challenge)
PlayLoop.haptic(type:'light'|'medium'|'heavy'): void
PlayLoop.share(text?): void
PlayLoop.log(msg): void              // dev console in Studio
PlayLoop.safeArea: {top,bottom}      // so UI avoids overlay rail
```
Message envelope (both directions): `{ v:1, src:'playloop', type:string, id?:string, payload:any }`.
Host -> guest: `init{safeArea,seed,muted,user:{anon:bool}}`, `pause`, `resume`, `restart`, `mute{muted}`, `storage:result`.
Guest -> host: `ready`, `gameOver`, `score`, `storage:get`, `storage:set`, `haptic`, `share`, `log`, `error{message,stack}`.
Host validates `event.source === iframe.contentWindow`; since origin is opaque, check source not origin. Rate limit guest messages (<=60/s). Ignore unknown types. Cap payload to 8KB.

## Host SDK (`packages/sdk/host.ts`)
`class GameHost { constructor(iframe, opts); on(evt, cb); pause(); resume(); restart(); mute(b); destroy() }` — handles handshake timeout (3s -> mark error), message validation, visibility API, wake events, FPS probe (guest reports via `requestAnimationFrame` sampling in injected shim: shim measures fps and posts `perf` every 2s).

## Injected shim also does
- Overrides `window.open`, `alert/confirm/prompt` to no-ops.
- Catches `window.onerror` / unhandledrejection -> `error` message.
- Pauses `requestAnimationFrame`/timers/`AudioContext.suspend()` on `pause` (wraps rAF, setInterval, setTimeout; suspends created AudioContexts). This guarantees non-cooperative games still freeze.
- Prevents scroll/zoom: `touch-action:none; overscroll-behavior:none; user-select:none` injected CSS.

## Validation rules (static, run before smoke test; implemented in `packages/gamekit/validate.ts`)
Reject if: >500KB; contains `<iframe`, `<form`, `fetch(`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `importScripts`, `eval(` of non-literal remote data, external `src=`/`href=` to non-allowlisted hosts, `document.cookie`, `localStorage`, `window.top`, `parent.postMessage` with non-SDK shape, crypto-mining signatures, obfuscated blobs (high-entropy strings > 2KB). Warn if missing viewport meta, missing `PlayLoop.ready/gameOver` calls, no touch handlers. These are defense-in-depth; the sandbox is the real boundary.

## Smoke test (Playwright, mobile viewport 390x844, CPU throttle 4x)
1. Load artifact via test harness with SDK host.
2. Fail if: no `ready` within 3s; console errors; blank canvas (screenshot variance ~0 / single colour >98% pixels); uncaught exception.
3. Synthetic input: tap center, random taps/drags/key presses for 8s. Pass if screenshot differs between t=1s and t=8s OR score/gameOver emitted (proves interactivity).
4. Measure avg FPS (>= 30 required, warn < 45), memory growth < 150MB.
5. Capture: poster png (frame at ~2s after input), 6s webm/gif preview (optional), 3 key frames for embedding.
Outputs stored in `game_versions.test_report` JSON.

## Template starter set (packages/gamekit/templates)
Provide 8 tested seed games: tap-runner, flappy-style, snake, brick-breaker, match-3, memory, shooter (drag-to-move), physics-toss. Used (a) as few-shot references in generation prompts, (b) as seed content, (c) as regression fixtures for the validator and smoke test.
