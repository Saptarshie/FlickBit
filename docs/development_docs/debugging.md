# Debugging

Work outside-in: is the server healthy, is the card mounted, did the host send,
did the guest react.

## 1. Is the stack actually up?

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/v/<sha>.html
curl -s http://localhost:3000/api/feed | head -c 200
```

- `/api/feed` 200 with `items: []` → DB reachable but no published games (seed
  did not run, or every game is unlisted).
- `500` + `{"error":{"code":"not_found"}}` on an artifact → the sha has no file
  under `apps/play-worker/artifacts/`. Run `scripts/audit-artifacts.ts --fix`.
- `500` + `no_manifest` → the artifact has no `pl-manifest` script.

## 2. Which card is on screen?

```js
const el = document.querySelector('[data-testid=feed-scroll]');
const i = Math.round(el.scrollTop / el.clientHeight);
document.querySelectorAll('section[aria-label]')[i]?.getAttribute('aria-label');
```

`[data-testid=feed-scroll]` is the snap container; every card is a
`<section aria-label="<game title>">`. If this reports a different title than
what you see, your scroll arithmetic is wrong, not the app — prefer
`element.scrollIntoView({ block: 'start' })`.

## 3. Did the host send the input?

```js
window.__PLAYLOOP_DEBUG__ = true;   // dev only
// …tap the card…
window.__plInput;                   // { gameId, kind, x, y, pointerId, host, at }
```

- `undefined` → the gesture never reached `forward()` (overlay covered? not
  active? `isActive` false?).
- `host: 'missing'` → the card had no `GameHost`; usually `live === false`
  (outside `MOUNT_RADIUS`).
- plausible `x/y` but the game ignores it → the transport is fine; look at the
  game's listeners, or at coordinates (see below).

X and Y are **guest CSS pixels**. Card iframe is 1:1 with the card, so a tap at
the visual centre of a 390×844 card should be ≈ `x: 195, y: 422`.

## 4. Input probe

The fastest way to prove the whole transport end-to-end: insert a probe artifact
as a real game (it beacons every pointer event and host message to the parent).

```bash
# 1. write an artifact that calls parent.postMessage({probe:true,...}) on input
# 2. copy it in and set the DB rows
cp probe.html apps/play-worker/artifacts/<sha>.html
# 3. games + game_versions rows pointing at <sha> (see the "Input Probe" recipe
#    in git history), then reload the feed
```

```js
window.__raw = [];
addEventListener('message', (e) => { if (e.data?.probe) window.__raw.push(e.data.type); });
// scroll to the probe card, tap it → expect ["message:resume","pointerdown","pointerup","message:input"]
```

If you see `message:*` but no `pointer*`, the shim received the envelope but the
dispatch failed. If you see nothing at all, the host never posted — check
`window.__plInput`.

## 5. Guest-side signals

The guest posts `error`, `log`, `perf`, `score`, `gameOver`, `haptic`, `share`,
`ready`. The card surfaces an error message (truncated) in the load chip and logs
the full object:

```js
// devtools console
[playloop] game frame error { message, code, stack }
```

Two messages to recognise:

- `Still loading…` — handshake timeout (12 s). Games may legitimately be slow;
  do not auto-skip.
- `too many invalid messages from guest` — 10 invalid envelopes **from the
  frame**. Unrelated window traffic (HMR, devtools, extensions) must be ignored,
  and is, since `GameHost.handleMessage` returns early for foreign sources.

## 6. Database

```bash
# ad-hoc query from packages/db (postgres-js is a dep there)
node -e "…"   # or psql against 127.0.0.1:5432
```

Reset everything:

```bash
rm -rf .data/pglite apps/play-worker/artifacts/*.html
pnpm dev           # recreates the DB and reseeds the 8 templates
```

Note the FK order when deleting: null `games.published_version_id` first, then
delete `game_versions`, then the game.

## 7. Next.js cache traps

- Never run `next build` while `next dev` is running: both write `.next/`, and
  the dev server's client manifest gets corrupted ("module not found in Client
  Manifest" 500s). Stop dev, `rm -rf apps/web/.next`, build, restart.
- The postgres pool is memoised on `globalThis` to survive HMR. If you change
  `src/lib/db.ts`, restart dev rather than hot-reloading.

## 7b. The dev database accepts exactly ONE connection

Symptom: `/api/feed` sometimes 500s, or hangs, under a handful of concurrent
requests; the dev log shows `bind message supplies 11 parameters, but prepared
statement requires 10`, `unnamed prepared statement does not exist`, or
`read ECONNRESET`.

Cause: PGlite is a single-threaded WASM Postgres behind a socket server. Every
socket shares one engine and one unnamed prepared statement, so as soon as two
clients interleave `Parse`/`Bind` frames the statements cross over. It is not a
load problem — two connections are enough.

Rules:
- `scripts/dev-db.ts` sets `maxConnections: 1`; leave it there.
- One `postgres-js` client per process with `prepare: false` (`getSql()` in
  `apps/web/src/lib/db.ts`, shared by Auth.js). Do not create a second pool.
- Admin scripts cannot connect while `pnpm dev` holds the socket. Either stop
  the dev server, or let the dev-db boot do the work (it publishes
  `.artifacts/seeds/*.html` automatically).
- Production uses real Postgres and must not depend on any of this: the only
  production-relevant setting is the same single shared client.

Diagnose with `pnpm smoke:load` (24 concurrent requests; any non-200 fails).

## 8. Browser-harness quirks (automation only)

- A hidden tab does not run `requestAnimationFrame`, so smooth scrolling and
  game loops appear frozen. Call `Page.bringToFront` before judging behaviour.
- The harness viewport is not the device viewport unless you set
  `Emulation.setDeviceMetricsOverride`; read the real size from
  `el.clientHeight` instead of assuming 844.
