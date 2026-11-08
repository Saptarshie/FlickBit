# Feed and scrolling

`apps/web/src/components/FeedScreen.tsx` renders a vertical snap scroller of
`GameCardView`s; each card is one game, full-bleed, `100dvh`.

## Structure

```
<main 100dvh>
  <header>            PlayLoop · mute · Create
  <div data-testid="feed-scroll"
       overflow-y: scroll; scroll-snap-type: y mandatory; overscroll-behavior: contain>
     <section aria-label="<title>"  scroll-snap-align: start; height: 100dvh>  × N
  </div>
  <BottomNav />       Home · Explore · Create · Activity · Profile
</main>
```

- **Infinite:** `useInfiniteQuery` over `GET /api/feed?cursor=…`, page size 10,
  prefetch when the active index is within 3 of the end.
- **Which card is active:** `IntersectionObserver` with `threshold` picking the
  card covering ≥55% of the viewport; the winner becomes `activeIndex`.
- **Mount budget:** `MOUNT_RADIUS = 1` → at most 3 iframes exist. Inactive cards
  render a static poster (title + creator on a gradient) and no iframe.
- **One card per gesture:** the gesture overlay converts a vertical drag past
  `SCROLL_THRESHOLD` into `goNext()`/`goPrev()`, which calls
  `container.scrollTo({ top: el.offsetTop, behavior: 'smooth' })`.

## Why manual drag handling instead of native scroll

Native scrolling inside an iframe swallows touch events: with the game iframe
covering the card, a swipe never reaches the parent scroller. The overlay + snap
container gives deterministic behaviour:

- swipe (browse mode) → exactly one card, in both directions
- wheel/trackpad → one card per `WHEEL_COOLDOWN_MS`
- keyboard → arrows, PageUp/PageDown, Home/End
- rail arrows → `goNext`/`goPrev` (thumb zone)

## Play mode interaction

While a card is engaged (`engagedGameId` in the feed store) the overlay forwards
pointer streams into the game and does **not** scroll. Everything listed above
(wheel, keys, rail, ✕) still moves the feed, and moving to another card clears
engagement automatically. Details and the rationale:
[input-pipeline.md](./input-pipeline.md).

## Card anatomy (`GameCardView.tsx`)

| Layer | z | Notes |
| --- | --- | --- |
| iframe | 0 | `pointer-events: none`; sandbox `allow-scripts` |
| cover backdrop | 0 | title + creator, hides a slow first paint |
| gesture overlay | 2 | all input routing |
| title / tags | 3 | link to `/t/<tag>` |
| creator row + Follow | 4 | link to `/u/<handle>` |
| action rail | 5 | like, comment, save, share, remix, prev, next (46×46) |
| play-mode chip | 6 | "● Playing ✕" |
| load chip | 7 | "Still loading…" / error text + Retry |
| game-over overlay | 8 | score + Play again / Next |
| comments sheet | 60 | `CommentsSheet` |

## Failure behaviour (must stay true)

- A handshake timeout is **not** fatal: show "Still loading…" + Retry, never
  auto-skip a card the person is watching.
- A frame error shows the guest's message (truncated to 90 chars) and a Retry.
- Empty/failed feed → explicit empty state with Retry; never invented cards.
- The game-over overlay is the only thing that pauses playback on its own.

## Performance rules

1. Never mount an iframe outside the ±1 window.
2. Pause inactive and hidden (`document.hidden`) cards — `syncPlayback()` is the
   single source of truth.
3. Keep the card's DOM shallow; the rail re-renders on like/save counts, so keep
   those subscriptions local to the button.
4. `useFeedStore` holds only what every card needs (active index, playing,
   muted, engagement). Feed data lives in TanStack Query.

## Adding a card element

Put it above the overlay (`zIndex > 2`) or it will not receive clicks. Interactive
elements need `pointerEvents: 'auto'`; decorative overlays should be `none` so
they never block gestures — that exact mistake (a full-cover "Tap to play"
button) is why only the rail arrow ever scrolled.
