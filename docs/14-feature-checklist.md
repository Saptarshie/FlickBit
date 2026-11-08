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
- [x] Keyboard: ↑/↓ navigate, Space pause, M mute, PageUp/PageDown/Home
- [x] Up and Down rail buttons (thumb zone), not just Down
- [x] Infinite pagination (cursor from the API) with a loading card at the end
- [x] Only the active card plays; neighbours are posters (memory rule: ≤3 iframes)
- [x] Retry when the feed is empty / failed

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
