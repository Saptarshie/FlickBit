# Input pipeline (touch, mouse, keyboard)

This is the most delicate part of the product: the game lives in an
opaque-origin iframe, the feed must keep its vertical scroll, and both want the
same finger.

## Layers, bottom to top

```
 iframe  z0   the game (pointer-events: none — the host owns input)
 gesture overlay  z2   GameCardView's transparent div: pointerdown/move/up/wheel
 play-mode chip   z6   "● Playing  ✕" (visible only while engaged)
 creator row z4 · title z3 · rail z5 · load chip z7 · game-over z8
```

`zIndex 0` is a cover backdrop (title + creator) so a slow first paint never
looks like a broken black screen.

## Two modes

| Mode | When | Vertical drag | Tap | Other input |
| --- | --- | --- | --- | --- |
| **Browse** (default) | `engagedGameId !== card.id` | scrolls the feed | enters play mode and is replayed as a game tap | non-vertical drag enters play mode and is replayed |
| **Play** | `engagedGameId === card.id` | replayed inside the game (smoke: snake steering works) | replayed | everything replayed; feed does not scroll from the play area |

Leaving play mode: the `✕` chip, `Escape`, the mouse wheel, a rail arrow, or
scrolling to another card (an effect clears engagement when `isActive` goes
false). The state lives in `useFeedStore.engagedGameId`.

Why a mode at all: a game with swipe controls (snake, toss, shooter) and a feed
that scrolls on a vertical swipe cannot both win the same gesture. Browsing stays
universal; entering a game is one tap and is announced by the chip.

## Coordinate spaces

Three spaces exist and mixing them is the classic bug:

| Space | Origin | Example |
| --- | --- | --- |
| Host viewport | top-left of the browser | `event.clientX/Y` |
| Guest viewport | top-left of the iframe | what the game sees |
| Game world | the game's own canvas coordinates | internal |

The host converts once, in `GameCardView.toGuest()`:

```ts
x = clientX - iframeRect.left
y = clientY - iframeRect.top
```

The frame renders 1:1 today, so no scale factor is applied. If you ever CSS-scale
the iframe, divide by the scale factor here — otherwise taps land at the wrong
place and games look "dead".

## Message contract

```ts
type InputKind = 'tap' | 'down' | 'move' | 'up' | 'cancel';
interface InputPayload {
  kind: InputKind;
  x: number; y: number;          // guest CSS px
  pointerId?: number;            // multi-touch
  pointerType?: 'touch' | 'mouse' | 'pen';
  buttons?: 0 | 1;               // 0 on up/cancel
}
```

`GameHost.input(payload)` posts it; the shim's `dispatchInput` replays it as a
real `PointerEvent` (plus `TouchEvent` for touch pointers) on the element under
the point, with **manual pointer capture**: `down` remembers the target and
`move`/`up`/`cancel` keep dispatching to it even when the finger leaves the
element, which is what games expect from `setPointerCapture`.

## Two traps that cost us real bugs

1. **`event.source !== window.parent` is not a valid sandbox check.** In a
   `sandbox="allow-scripts"` frame (opaque origin) the parent WindowProxy handed
   back is a different wrapper, so the identity comparison failed and *every*
   host message (init, pause, resume, mute, input) was silently dropped. Games
   looked alive because they fall back to a local `window.PlayLoop` stub, but
   nothing the host sent ever arrived.
   The shim now validates by embedding origin:

   ```js
   parentOrigin = location.ancestorOrigins[0]   // survives opaque origins
   if (parentOrigin && ev.origin !== parentOrigin) return;
   ```

2. **A pause before the first paint freezes the game forever.** `setPaused(true)`
   before any `requestAnimationFrame` callback means the loop never starts and
   the canvas stays black. The shim defers such a pause (`pendingPause`) until
   one frame has run — and a later `resume` **must clear** the deferred pause, or
   the game pauses itself right after its first frame.

Both have regression tests in `packages/sdk/src/shim-source.test.ts` and
`packages/sdk/src/host.test.ts`.

## Debugging recipe

```js
window.__PLAYLOOP_DEBUG__ = true;   // in devtools, before tapping
// after a gesture:
window.__plInput
// { gameId, kind, x, y, pointerId, host: 'live' | 'missing', at }
```

`host: 'missing'` means the card had no `GameHost` (usually `live === false`);
a plausible `x/y` with no game reaction means the guest ignored it — check the
game's own listeners, not the transport.

To test the transport itself, insert a probe artifact as a game (see
[debugging.md](./debugging.md#input-probe)) — it beacons every pointer event and
every host message back to the parent.

## Keyboard (host level)

`ArrowUp/Down`, `PageUp/PageDown`, `Home/End` navigate cards; `Space` toggles
play/pause; `M` mutes; `Escape` leaves play mode. Handled in `FeedScreen`.

## Adding a new input type

1. Extend `InputKind` in `packages/sdk/src/protocol.ts`.
2. Forward it in `GameHost.input()` (no extra mapping needed if it is a payload
   field).
3. Map it to DOM events in `shim-source.ts` → `dispatchInput`.
4. Send it from `GameCardView` with guest-space coordinates.
5. Test in `host.test.ts` (payload) and `shim-source.test.ts` (dispatch).
