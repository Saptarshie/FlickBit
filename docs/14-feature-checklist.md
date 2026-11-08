# 14 — Feature checklist (the "complete app" target)

Legend: `[x]` done and verified in a browser · `[~]` partially done · `[ ]` not done yet.
Update this file whenever a feature lands or regresses.

## 0. Stability (must never regress)
- [ ] No false "Game failed to load": handshake timeout must not auto-skip a game that renders
- [ ] Every failure has a visible, recoverable action (Retry / Report), never a dead end
- [ ] Feed keeps working when the DB lags: skeletons, then content, never a blank screen
- [ ] Error boundary around the feed and the studio (a crash renders a card, not a white page)
- [ ] No unhandled promise rejections in the browser console

## 1. Account
- [x] Passwordless "pick a handle" sign-in (`/login`), session persists
- [x] Sign-out (own profile)
- [x] Own profile reachable from anywhere (bottom nav)
- [x] Avatar initial + handle shown in the app chrome

## 2. Feed (Instagram-Reels behaviour)
- [x] Vertical scroll in BOTH directions (swipe up AND down, mouse wheel, trackpad)
- [x] Snap one card per gesture, momentum, no overscroll bounce into nothing
- [x] Keyboard: ↑/↓ navigate, Space pause, M mute, PageUp/PageDown/Home/End
- [x] Up and Down rail buttons (thumb zone), not just Down
- [x] Infinite pagination (cursor from the API) with a loading card at the end
- [x] Only the active card plays; neighbours are posters (memory rule: ≤3 iframes)
- [x] Retry when the feed is empty / failed

## 2b. Game input (touch/mouse inside a sandboxed card)
- [x] Real pointer stream forwarded to the game: down / move / up / cancel
- [x] Guest-space coordinates (iframe-local), so taps land where you press
- [x] Multi-touch pointer ids and pointer type forwarded
- [x] Swipe controls work (snake steering, toss) — verified by flipping a Memory card and steering a snake
- [x] Play-mode engagement: one tap enters the game, ✕ / Esc / wheel / rail returns to browsing
- [x] Pause/resume/mute reach the guest (origin-checked, sandbox-safe)
- [x] A game never freezes after its first frame (deferred pause is cleared on resume)

## 3. Card interactions (all persisted to the DB)
- [x] Like / unlike (optimistic, revert on error, count updates)
- [x] Save / unsave (optimistic) + Saved tab
- [x] Comment: open sheet, read list, post comment, count updates
- [x] Share: native share sheet + copy link fallback + share page `/g/<id>`
- [x] Remix: opens studio with the source loaded
- [x] Follow / unfollow creator (persisted, count reflects it)
- [x] Creator row on the card → profile
- [x] Report game (share page → moderation `reports` row)

## 4. Create (vibecoding)
- [x] `/studio` prompt → plan → generate → validate → publish
- [x] Remix flow (`/studio?remix=<id>`)
- [x] Create button visible in the app chrome (bottom nav + feed top bar)
- [x] Progress UI shows real stages + errors with a retry
- [x] Generated game preview + publish
- [x] My games list (own profile grid)

## 5. Profiles
- [x] `/u/<handle>` page with game grid
- [x] Follow button persisted
- [x] Own profile from the bottom nav
- [x] Game grid opens the game's share/play page
- [x] Sign out

## 6. Discovery
- [x] `/explore`: trending tags, search by title/tag/creator
- [x] Tag page `/t/<tag>`
- [x] Notifications page (Activity tab) with unread badge
- [x] Suggested creators to follow (creator row in explore)

## 7. Platform
- [x] Sandboxed artifacts, CSP, content addressing
- [x] Real LLM generation + Ollama embeddings
- [x] Hourly rollups feeding trending
- [ ] Moderation queue for generated games (auto-approve stays fine for dev)
- [ ] Poster capture for cards/OG images

## Verified in the browser (390×844 + desktop)

- Feed: 11 cards, full-bleed 844 px card, game start screen painted, tap starts gameplay, wheel/arrow/PageUp/PageDown/Home navigate, ≥3 cards mounted max.
- Sign-in with a handle → session persists across navigation; like count 1, comment posted, follow shows on the profile (`1 follower · ✓ Following`), saved game appears in `/saved`.
- Studio: styled (Tailwind installed), real LLM run streamed progress with a 5 s heartbeat, published "Neon Serpent", ranked #1 in the feed, artifact served at 28 KB (12.8 KB game + SDK shim).
- `pnpm --filter @playloop/web run build` succeeds; `/`, `/explore`, `/login`, `/studio`, `/saved`, `/notifications` all 200.
- Tests: sdk 28, gamekit 71, ai 16, db 12, recsys 16, play-worker 9, web 71 = 223 green; typecheck 8/8.

Known slow path: a real generation takes ~7–10 min on `deepseek/deepseek-v4.1-flash` (streaming, one repair). The UI shows elapsed time; it is not hung.

## Session 2 — game input (2026-11-08)

"Game-touch control is not working" turned out to be three separate faults:

1. **The shim dropped every host message.** It validated senders with
   `event.source !== window.parent`, which is not stable for an opaque-origin
   sandbox, so `init`, `pause`, `resume`, `mute` and `input` never arrived. Now
   validated by embedding origin (`location.ancestorOrigins[0]`).
2. **Stray window messages killed live cards.** The host counted *any* message
   from a non-frame source as a protocol violation; React DevTools/HMR noise hit
   the limit of 10 and the card showed `too many invalid messages from guest`.
   Foreign sources are now ignored (regression test added).
3. **Games froze after their first frame.** A pause that arrived before the first
   `requestAnimationFrame` was deferred — but `resume` never cleared it, so the
   game paused itself right after painting. Fixed + two tests.

Input routing was also rebuilt: vertical drags are no longer stolen by the feed
once a card is engaged, coordinates are translated to guest space, pointer ids /
types / cancel are forwarded, and the guest implements manual pointer capture so
drags keep landing on the element that received the down.

Verified in a real sandboxed card: a tap flips the correct Memory cell (♣
revealed) and a probe artifact beacons `pointerdown → pointerup → message:input`
back to the host. Architecture/debugging docs: `docs/development_docs/`.
