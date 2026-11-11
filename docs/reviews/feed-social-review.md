# PlayLoop — Feed & Social QA Review

**Reviewer stance:** adversarial. This is what a paying user, a creator, and a trust & safety lead would hit on day one.
**Date:** 2026-11-11
**Build under test:** dev stack at `http://localhost:3000` (web) / `http://localhost:3001` (artifact worker), Next.js 15.5.28, PGlite dev DB.
**Method:** read all 20 `app/api/**/route.ts` handlers, `src/lib/feed.ts`, every feed/social component; exercised every API with authenticated and anonymous cookies (`/api/auth/callback/handle` credentials flow); drove the real UI at 390×844 in a Chromium session (tap-to-play, swipe, keyboard events, focus order, iframe count).
**Not modified:** no source files. Two probe scripts live in the Hermes scratch dir. Test rows created in the dev DB are listed in §7.

**Verdict:** the API layer is solid — consistent `{data}` / `{error:{code,message}}` envelopes, correct 401/403/404 split, no stack traces leaked, 71/71 unit tests green. The **product** is not shippable. Anyone can become any creator by typing their handle, the headline "Remix" action silently builds a brand-new game instead of a remix, and the creation flow has two hard dead ends. Everything else is a long tail of missing empty/error states, dead controls, and unreachable social actions.

---

## 1. P0 — blocks shipping

### P0-1 · Signing in requires no credential: type any existing handle and you *are* that creator
**Severity:** P0 (security, data integrity)
**Evidence:** `apps/web/auth.ts:84-108` (`authorize()` looks the handle up, creates the user if missing, and returns it with **no password/OTP check**), `apps/web/src/components/LoginScreen.tsx:23`, `apps/web/src/lib/client-api.ts:67-71`.
**Repro (verified):**
```bash
curl -s -c jar http://localhost:3000/api/auth/csrf -o csrf.json
T=$(node -e "console.log(require('./csrf.json').csrfToken)")
curl -s -b jar -c jar -X POST http://localhost:3000/api/auth/callback/handle \
  -d "csrfToken=$T" -d "handle=playloop" -d "json=true"
curl -s -b jar http://localhost:3000/api/me
# {"data":{"viewer":{"id":"89c0c18a-…","handle":"playloop","displayName":"PlayLoop"}}}
```
That session owns all 13 of `@playloop`'s games: `PATCH /api/games/:id` authorises on `game.creatorId === userId` (`app/api/games/[id]/route.ts:127`), and `POST /api/games/:id/report`, comment deletion, follow/unfollow all follow the same identity. Handles are public in every URL (`/u/[handle]`), so the attack is "read a handle, become that person".
**Fix:** this cannot ship. Either (a) make handle sign-in dev-only (`NODE_ENV !== 'production'` guard around the credentials provider) and put real auth (email OTP via the already-configured Nodemailer provider, or OAuth) in front of prod, or (b) require a per-user secret on the credentials provider. Add a regression test that a second session cannot PATCH another creator's game.

### P0-2 · "Remix" is broken end-to-end and silently produces a *new, unrelated* game
**Severity:** P0 (core advertised loop does the wrong thing)
**Evidence:** `app/api/games/[id]/source/route.ts:44-51` resolves `ARTIFACTS_DIR` directly against `process.cwd()` (`apps/web`), while `.env:13` sets `ARTIFACTS_DIR=./apps/play-worker/artifacts`. The resulting path `apps/web/apps/play-worker/artifacts` does not exist, so the route always 404s. `src/components/StudioScreen.tsx:44-46` swallows that 404 (`if (!res.ok) return;`), leaves `remixBaseCode` null, and `StudioScreen.tsx:80-82` therefore omits `baseCode` **and** `forkedFromId` from the generate request.
**Repro (verified):**
```bash
curl -s "http://localhost:3000/api/games/3a13b2d7-d35b-4583-8729-d64976cd936a/source"
# {"error":{"code":"not_found","message":"Game source not found"}}   (artifact itself is 200 on :3001)
```
UI: feed rail → 🔁 → `/studio?remix=<id>` → prompt stays empty, no base code, no `forked_from_game_id` on the new row, no message. The user's "remix" is a from-scratch generation that appears on their profile with no provenance.
**Fix:** resolve `ARTIFACTS_DIR` the same way `app/api/studio/generate/route.ts:51-56` does (`path.resolve(repoRoot, env)`), add a route test asserting 200 + code for every published artifact, and make `StudioScreen` fail loudly (`Remix source unavailable — generating from scratch` banner + a link back to the game) instead of silently degrading.

### P0-3 · Studio creation flow has two hard dead ends: invisible failures and a modal you cannot close
**Severity:** P0 (violates "no dead ends, recoverable failures")
**Evidence:** `StudioScreen.tsx:129-134` puts the error in `progressMsg` / `progressStage='failed'`, but the only element that renders those fields is the overlay gated on `isGenerating` (`StudioScreen.tsx:241-257`), which `finally { setIsGenerating(false) }` removes. Net: an LLM failure, a 500, or a dropped stream produces **no visible message anywhere**. Separately, the post-generation modal (`StudioScreen.tsx:302-352`) has no ✕, no backdrop `onClick`, no Escape handler, and sits at `z-50` above the `z-20` header — the only exits are "Save details" and "View in Feed".
**Repro:** `/studio` → stop the LLM (or point `LLM_BASE_URL` at a dead host) → prompt "flappy bird" → Vibe. Spinner runs, overlay vanishes, screen unchanged, error is invisible. Then, with a working generation: finish a game, click 🚀 Published → modal opens → try to get back to writing another prompt. You cannot.
**Fix:** persist the error (`role="alert"` block under the prompt with a Retry that reuses the last prompt) and render `progressStage === 'failed'` outside the generating overlay; give the modal a close button + backdrop click + Escape + focus trap.

---

## 2. P1 — serious, fix before ship

### P1-1 · The Activity tab can never show anything, and its badge can never clear
**Evidence:** no production code inserts a notification — `grep -rn "insert(notifications)"` only matches `apps/web/test/api.test.ts:440-466`. The like (`app/api/games/[id]/like/route.ts:31-43`), follow (`app/api/users/[id]/follow/route.ts:29`) and comment (`app/api/games/[id]/comments/route.ts:102-111`) handlers write their row and nothing else. Meanwhile `NotificationsScreen.tsx:68` promises "Likes, comments and new followers show up here", and no client ever calls `/api/notifications/read` (`AppNav.tsx:57` reads `unread` from `/api/me` and never invalidates it).
**Repro:** sign in as A, like/comment/follow B's game, sign in as B → `/api/notifications` returns `{"items":[],"unread":0}` (verified). Even after seeding rows by hand, the badge stays >0 forever.
**Fix:** emit notifications in the like/follow/comment/remix handlers (skip self-actions, dedupe on `(user,type,actor,game)`, store `data.actorHandle`/`data.gameTitle` since the UI reads those keys), call `POST /api/notifications/read` when the screen opens, and invalidate `['me']`. Until then, remove the tab.

### P1-2 · No client ever sends an analytics event: plays never increment and the ranker has no signal
**Evidence:** `app/api/events/route.ts` exists and is public, but nothing in `apps/web/src` or `apps/web/app` posts to it (grep: only `middleware.ts` mentions the path). `GameCardView` forwards gestures into the iframe but never records `impression` / `play_15s` / `like` / `remix`. Every card in the DB still reads `plays: 0` (verified across `/api/feed`).
**Repro:** `curl /api/feed` → all `counts.plays` are 0; play any game for 30s, re-fetch → still 0. `packages/recsys/src/candidates.ts:42-51` therefore only ever sees empty `live`/`rolled` sets; ranking degenerates to `published_at` order.
**Fix:** fire `impression` on `setActiveIndex` (with the 1s dwell guard), `play_15s` from the host `onReady`+15s timer, `remix` on generate-with-forkedFrom, and `like` alongside the like mutation. Increment `games.play_count` server-side in the events handler (or a trigger) so the card counts stop lying.

### P1-3 · The feed turns a backend outage into "No games yet"
**Evidence:** `src/lib/feed.ts:54-57` catches every error and returns `{items: [], cursor: null}`. `FeedScreen.tsx:169-176` then renders the *empty* state ("Be the first: create a game in the studio"), not the error state — the two are indistinguishable, and the only affordance is a Retry whose label implies nothing is wrong.
**Repro:** stop the dev DB, reload `/` → "No games yet / Be the first" (not "Could not load the feed"). A first-time visitor is told the product is empty rather than broken.
**Fix:** let the action throw (or return `{error}`); distinguish "0 items because the query succeeded" from "query failed" in `FeedScreen`, and word the failure state honestly with a Retry.

### P1-4 · Every global keyboard shortcut fires twice; Space and M look dead, arrows skip a game
**Evidence:** two `window.addEventListener('keydown', …)` handlers coexist — `app/page.tsx:12-51` (`togglePlaying`, `toggleMuted`, index+scroll) and `FeedScreen.tsx:107-153` (`setPlaying(!state.isPlaying)`, `toggleMuted`, `goNext`). `preventDefault()` does not stop sibling listeners, so both run. For ArrowDown the first handler moves 0→1, the second reads the already-updated store and moves 1→2.
**Repro:** focus the feed, press Space → the pause overlay flashes and disappears (paused then resumed). Press ArrowDown once → two cards scroll past. Both are reproducible by inspection and by the duplicated listeners in the DOM.
**Fix:** one owner for global keys (delete the `app/page.tsx` listener and keep `FeedScreen`'s, or vice-versa), and guard with `event.defaultPrevented` if both must stay.

### P1-5 · `/g/[id]` — the page every shared link lands on — has no social actions, no nav, and cannot be scrolled over the game
**Evidence:** `GameShareScreen.tsx:116-173` renders creator link + Remix only; there is no Like, Save, Comment, Follow, or Share button, and `viewer` is hardcoded `{liked:false,saved:false,followsCreator:false}` at `app/g/[id]/page.tsx:69` (the API's real viewer state at `app/api/games/[id]/route.ts:52-67` is never used here). The iframe is `touchAction: 'none'` (`GameShareScreen.tsx:57`) and takes 693px of an 844px viewport, so a vertical swipe that starts on the game cannot scroll the page; there is no BottomNav either.
**Repro:** open `/g/3a13b2d7-…` at 390×844 → only two buttons exist ("Tap to play", "Report this game"). Try to scroll to the description by dragging over the game — nothing moves.
**Fix:** add the rail (like/save/comment/share) driven by `GET /api/games/:id`, hydrate `viewer` server-side, drop `touchAction:none` (let the guest opt into pointer capture), and give the page either the BottomNav or a back link.

### P1-6 · Saved games are effectively unfindable: no nav entry
**Evidence:** `AppNav.tsx:124-158` ships Home / Explore / Create / Activity / Profile. `/saved` exists (`app/saved/page.tsx`) and is linked only from the *own* profile header as an unlabelled 🔖 (`ProfileScreen.tsx:194-211`).
**Repro:** signed in, look at the bottom bar on any screen → no Saved. A user who saved 10 games must remember to open their own profile and tap an emoji.
**Fix:** make the profile tab a stack with Saved, or swap "Activity" (currently dead, P1-1) for Saved until notifications work.

### P1-7 · Tapping Like while signed out navigates the whole app to /login
**Evidence:** `GameCardView.tsx:104-113` — a 401 triggers `router.push('/login?next=%2F')` from inside the card's error handler. `next` is hardcoded to `/`, so the feed position and all query state are lost.
**Repro (verified in the browser):** signed out, tap Like → optimistic fill, request 401, ~1s later the URL is `/login?next=%2F` and the feed is gone.
**Fix:** inline "Sign in to like" toast/CTA (same pattern CommentsSheet already uses at `CommentsSheet.tsx:184-201`), and only navigate on an explicit tap; preserve the index in `next`.

### P1-8 · CommentsSheet is a keyboard trap in reverse: no focus management, and the *closed* sheet keeps 3 live controls in the tab order
**Evidence:** `CommentsSheet.tsx:68-76` keeps the sheet mounted with `aria-hidden={!open}` and `pointerEvents:'none'` — but no `inert`/`tabIndex={-1}`, so its Close button, input and Post button stay focusable. Verified in the DOM: 2 mounted sheets → 6 focusable elements inside `[aria-hidden="true"]`. The dialog (`:87-107`) has `role="dialog"` but no `aria-modal`, no focus trap, no Escape handler, and focus is moved with an uncleaned `setTimeout` (`:44-46`).
**Repro:** on `/` press Tab repeatedly → focus disappears into an invisible comment input; type and press Enter → you post a comment to a card you cannot see. With the sheet open, press Escape → nothing.
**Fix:** render the sheet only when open (or `inert` when closed), add `aria-modal`, focus trap, Escape-to-close, and restore focus to the trigger.

### P1-9 · Anyone can publish into the global feed anonymously, self-approved, with no rate limit — and their "Save details" then 403s
**Evidence:** `app/api/studio/generate/route.ts:36-49` falls back to the `playloop` system user when there is no session; `:122-131` inserts the game with `status:'published', moderation:'approved'`; there is no auth check, no prompt length cap and no rate limit on the route.
**Repro:** signed out, `POST /api/studio/generate {"prompt":"anything"}` → a new published game owned by `@playloop` appears in everyone's feed. Then the visitor's "Save details" (`StudioScreen.tsx:144-163`) PATCHes `/api/games/:id` as themselves → 403, `publishSaved` stays false, no error is shown.
**Fix:** require a session for generate, cap prompt length, rate-limit per user/IP, and stop hardcoding `moderation:'approved'` (route new artifacts through the moderation queue). Never attribute user content to a system account.

### P1-10 · The feed's candidate queries are unbounded: 4 full scans + full event aggregation per page, sliced in JS
**Evidence:** `packages/recsys/src/candidates.ts` — `trending` (`:30-69`), `fresh` (`:101-111`), `social` (`:145-156`), `explore` (`:189-215`) each `SELECT … FROM games` with **no `LIMIT`**, then `for (…) { if (result.length >= limit) break; }` in Node. `trending`/`explore` additionally aggregate the whole `events` and `game_stats_hourly` tables.
**Repro:** `EXPLAIN`-equivalent by inspection; every `/api/feed` call moves the full published-games table plus the entire current-hour events set, four times, to serve 10 cards. At 10k games/1M events this is seconds per scroll page and O(table) memory.
**Fix:** push `LIMIT (limit * k)` and the `seen` exclusion into SQL; use a supporting index for the impressions order; aggregate events in the hourly rollup only.

### P1-11 · No `not-found.tsx`, `error.tsx`, `loading.tsx`, or `global-error.tsx`
**Evidence:** `find apps/web/app -type f` returns only the 10 page files + `globals.css`/`layout.tsx`. `/g/does-not-exist` returns 404 with Next's stock body ("This page could not be found", 17KB, no chrome, no links) — verified. During a DB outage `GET /` returned a bare 21-byte `Internal Server Error`.
**Repro:** `curl -s http://localhost:3000/g/nope | grep -c "This page could not be found"` → 1; there is no way back to the feed.
**Fix:** add a styled `app/not-found.tsx` and `app/error.tsx` (with `reset()` + "Back to feed"), plus `loading.tsx` for `/g/[id]` and `/u/[handle]`.

### P1-12 · Comments: silent failures, no reply/delete UI, unbounded thread
**Evidence:** `CommentsSheet.tsx:55-58` only handles 401 — a 400 (body >500 chars), 404, or 500 leaves the draft in place with zero feedback. The API supports replies (`parentId`, `app/api/games/[id]/comments/route.ts:90-100`) and deletion (`app/api/comments/[id]/route.ts`), but no UI exposes either. `GET` returns every non-deleted comment with no `LIMIT`/cursor (`:39-54`), and `likeCount` is fetched but never rendered.
**Repro:** open comments, paste 600 characters (the input caps at 500 client-side, so use the API), or kill the server and press Post → nothing happens, no error.
**Fix:** surface the error under the input, add Reply (one level, as the API allows) and Delete-on-own-comment, paginate at 50 with a "load more", and either render likes or drop the field.

### P1-13 · Pinch-zoom disabled and no visible focus styles
**Evidence:** `app/layout.tsx:8` sets `maximumScale: 1` (WCAG 1.4.4 failure). `outline:'none'` is set on every text input (`CommentsSheet.tsx:181`, `ExploreScreen.tsx:67`, `StudioScreen.tsx:288`, `LoginScreen.tsx:80`), and `globals.css` defines no `:focus-visible` rule, so buttons/links rely on the UA default while inputs have *no* focus indicator at all.
**Repro:** load at 390×844, try to pinch-zoom → blocked. Tab to the search field → no visual change.
**Fix:** remove `maximumScale`, add a global `:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 2px }` and drop `outline:none` (replace with a border/ring on focus).

### P1-14 · A finished game stays "Game over" forever, including after you scroll away and back
**Evidence:** `GameCardView.tsx:85` keeps `gameOver` in component state, and `:714-748` overlays the card whenever it is true. When `live` goes false the iframe unmounts (`:423-442`), but the component instance (and its state) survives because the `key` never changes; on return, a brand-new frame starts and `syncPlayback` (`:185-198`) sees `gameOverRef.current === true` → pauses it under a "Game over" overlay.
**Repro:** play a game until Game over → scroll to the next card → scroll back → the fresh game is paused behind the old overlay; only "Replay" recovers it.
**Fix:** reset `gameOver`/`loadIssue` when `live` flips false or when the host reports `ready` for a new frame.

---

## 3. P2 — polish

| # | Finding | Evidence | Repro | Fix |
|---|---|---|---|---|
| P2-1 | Save count is off by one after un-saving a previously saved game | `GameCardView.tsx:667` shows `card.counts.saves + (saved && !card.viewer.saved ? 1 : 0)`; the base count already includes your save | Save a card (count 5), tap again → still 5, server says 4 | Keep a local `saveCount` seeded from the card and ±1 on toggle; or trust the count the API already returns (`save/route.ts:42`) |
| P2-2 | Like ignores the authoritative count and double-taps race | `like/route.ts:42` returns `likeCount`; `GameCardView.tsx:115-147` ignores it and does local arithmetic; the button is never disabled while pending | Tap Like twice fast → two in-flight mutations, POST then DELETE, local count can drift from server | `onSuccess` set `likeCount` from the response; disable while `isPending` |
| P2-3 | The pause overlay's "play" button is unclickable | `GameCardView.tsx:749-757` renders a full-screen `<button>` with `pointerEvents:'none'` | Desktop: press Space (net no-op today because of P1-4; force `isPlaying=false` in devtools) → the ▶ button cannot be clicked | Remove `pointerEvents:'none'`, or render a non-button chip |
| P2-4 | No thumbnails anywhere; every grid is 2-letter initials; `posterUrl` points at a route that does not exist | `GameGrid.tsx:51` and `ProfileScreen.tsx:250-261` render initials; `packages/recsys/src/feed.ts:136` builds `/api/media/<key>` but `apps/web/app/api/media` does not exist; `app/g/[id]/page.tsx:86` feeds a bare storage key to `openGraph.images` | Open `/explore` → cards read "TE", "NE"; share a game to Slack → no preview image | Add the media route (or sign the storage URL), render `<img>`/`next/image` with width/height from `posterKey`, fall back to a *game* frame rather than initials |
| P2-5 | The share page's "Tap to play" resume message is dropped by the guest shim | `GameShareScreen.tsx:31` posts `{src:'playloop', type:'resume'}` without `v:1`; the shim requires `d.v === 1` (`packages/sdk/src/shim-source.ts:451`) | Tap to play on `/g/[id]`; the guest never receives `resume` (only the overlay disappears) | Use `new GameHost(iframe)` or send `{v:1, src:'playloop', type:'resume'}` |
| P2-6 | Search text is ignored while a tag chip is selected, and tag pages show unrelated creators | `app/api/search/route.ts:23-46` branches `if (tag) … else if (q)`; `ExploreScreen.tsx:34-43` sends both; the creators query (`:70-83`) runs regardless of tag | `/explore` → pick `#arcade` → type "snake" → the results never change and the input still shows the text | Either send only one filter at a time and clear the box, or make the API AND the two |
| P2-7 | Every keystroke blanks the results ("Searching…") and costs 4 queries | `ExploreScreen.tsx:34-43` has no `placeholderData: keepPreviousData`; 250ms debounce, no abort | Type in search → list flickers to "Searching…" on each pause; 13 cards → 0 → 13 | `placeholderData: keepPreviousData`, `staleTime` already 20s; pass an `AbortSignal` |
| P2-8 | Eight controls below the 44×44 touch minimum | `FeedScreen.tsx:222` (38px mute), `GameCardView.tsx:521-531` (28px ✕), `ExploreScreen.tsx:76,96` (32px chips), `ProfileScreen.tsx:145` (36px Sign out), `StudioScreen.tsx:214-227` (40px), `GameShareScreen.tsx:251-277` (42px) | Measure at 390×844; the ✕ to exit play mode is a 28px target in the top-centre, the hardest place to reach | ≥44×44 hit area (padding is fine — visual size can stay) |
| P2-9 | Nav labels and rail counts have no scrim over bright gameplay | `AppNav.tsx:119` gradient goes to `rgba(0,0,0,0)` at the top; `GameCardView.tsx:41-48` labels sit on the game frame with only a text-shadow | Load a light-background game → 10px "Home/Explore" labels and the like count sit directly on the canvas | Add a stronger gradient (≥0.85 at the icons) or per-item pill backgrounds |
| P2-10 | Profile error/loading screens are dead ends | `ProfileScreen.tsx:59-83` renders neither `TopBar` nor `BottomNav`, and says "Profile not found" for network/500 errors | Open `/u/playloop` with the API blocked → "Profile not found" + Retry, no way back | Include `TopBar`/`BottomNav` in both branches; separate 404 from "couldn't load" |
| P2-11 | Idempotency and input-trust gaps on social writes | `follow/route.ts:29-30` returns `201` even when the row already existed; `report/route.ts:30-39` accepts unlimited duplicate reports; `score/route.ts:16-19` accepts `score: 1e9` | `POST /api/users/:id/follow` twice → `201` both times. `POST /report` twice → two rows (verified) | Return `200` when already following; dedupe reports per (reporter,target); validate score ranges/server-authoritative |
| P2-12 | Wildcard handle lookup returns an arbitrary user | `app/api/users/[id]/route.ts:28` uses `ilike(handle, id)` with unescaped input | `curl /api/users/%25` → `200` with `@playloop`'s full profile (verified) | Escape `%`/`_` (`id.replace(/[%_\\]/g, '\\$&')`) and require an exact, lowercased match |
| P2-13 | Four APIs have no UI at all: leaderboard, score, events, notifications/read | `app/api/games/[id]/leaderboard`, `/score`, `/api/events`, `/api/notifications/read` — no callers in `apps/web/src` or `apps/web/app` | grep for the paths → only middleware/auth mentions | Ship the leaderboard surface or delete the endpoints; wire the beacon (P1-2) and mark-read (P1-1) |
| P2-14 | Auth middleware is inert dead code | `src/middleware.ts` sits beside `src/lib`, but the app router is at `apps/web/app`, so Next never loads it. Verified: unsigned `GET /explore`, `/saved`, `/studio`, `/api/feed` all return 200 | `curl -o /dev/null -w "%{http_code}" http://localhost:3000/explore` → 200 | Delete it, or move it to `apps/web/middleware.ts` — but note it would then wall off `/explore`, `/g/*` and `/u/*`, which must stay public for a share-led product |
| P2-15 | Feed cursor is unsigned, grows without bound, and a bad cursor silently restarts the feed | `packages/recsys/src/feed.ts:20-31` (base64 JSON, no signature), `:177-181` (seen ids accumulate); invalid cursor → `decodeCursor` returns null → page 1 | `curl "/api/feed?cursor=zzz"` → the same first page, no error. Cursor length grows 288→496→… per page (measured) | HMAC the cursor (or store the seen set server-side keyed by a cursor id) and return `400` on a malformed cursor |
| P2-16 | Two different feeds: the UI uses a server action, the public API uses the anon cookie | `src/lib/feed.ts:44-49` never passes `anonId`; `app/api/feed/route.ts:62-68` does | Compare `/api/feed` and the rendered feed for a logged-out visitor — the exposure-based `explore` stream differs | Have the server action read the same `pl_anon` cookie, or drop the API route |
| P2-17 | Missing pagination on every list except the feed | search `LIMIT 30` (`api/search/route.ts:6`), saved `LIMIT 100` (`me/saved/route.ts:30`), notifications `limit≤100` (`notifications/route.ts:7`), profile games unbounded (`users/[id]/route.ts:58-77`), comments unbounded | `/explore` shows 13 of 13 now; with 60 games, 30 are unreachable by any UI path | Cursor-paginate search/profile/comments; "load more" in saved/notifications |
| P2-18 | `/g/[id]` loads the same game twice per request | `app/g/[id]/page.tsx:76` (`generateMetadata`) and `:98` both call `loadGame` → up to 4 queries per share view, uncached (`force-dynamic`) | Inspect the SQL log / time the page | Wrap in `cache()` from `react`, or read from a memoised loader |
| P2-19 | Studio generation cannot be cancelled and keeps running after navigation | `StudioScreen.tsx:73-135` has no `AbortController`; the SSE loop runs until `done` | Start a generation, hit back → the request keeps streaming (and the server keeps generating + writing artifacts) | Abort on unmount, add a Cancel button to the progress overlay, server-side timeout |
| P2-20 | Login `next` param is an open redirect and the error copy lies | `LoginScreen.tsx:12,28` (`router.push(next)` with no validation), `:25` maps *any* failure to "Pick a handle with at least 3 letters or numbers" | `http://localhost:3000/login?next=https://example.com` → after sign-in the browser leaves the app | Allow only same-origin paths starting with `/`; distinguish validation vs network failures |
| P2-21 | A DB outage yields a non-envelope 500 from the page/route layer | Observed during a dev-DB restart: `GET /` returned 21 bytes of `Internal Server Error`, and `GET /api/me` returned a bare 500 rather than `{error:{code,message}}`. Note `wrap()` cannot be blamed for handler throws — this points at a module/handler-eval failure before the handler runs | Kill the PGlite process, then `curl -i http://localhost:3000/api/me` | Add `app/error.tsx` so page-level failures degrade to a designed state, and keep DB clients lazily constructed so a dead pool cannot break module evaluation |
| P2-22 | Cancelling the native share also copies the link | `GameCardView.tsx:162-179` — the `catch` around `navigator.share` falls through to the clipboard | On iOS, tap Share then Cancel → "Link copied" toast | Only fall back to the clipboard when `navigator.share` is absent, not when the user aborted |
| P2-23 | No mute/block for creators or games | No UI or endpoint (`/api/users/[id]/…` has only `follow`) | n/a | Needed for a UGC feed before public launch; at minimum "hide this creator" |

---

## 4. API matrix (observed, not inferred)

| Route | Anon | Authed | Notes |
|---|---|---|---|
| `GET /api/feed` | 200 | 200 | `{data:{items,cursor}}`; `limit=0`→1 item, `limit=abc`→10, bad cursor→page 1 |
| `GET /api/search` | 200 | 200 | 4 queries/request; no pagination |
| `GET /api/me` | 200 `{viewer:null}` | 200 | Correctly never 401s |
| `GET /api/me/saved` | 401 JSON | 200 | `LIMIT 100`, no cursor |
| `GET /api/notifications` | 401 | 200 | `limit` validated 1–100 |
| `POST /api/notifications/read` | 401 | 200 | Empty body = mark all (documented); no UI calls it |
| `GET /api/games/:id` | 200 | 200 | 404 unknown, 400 bad uuid; **`viewer` flags unused by `/g`** |
| `PATCH /api/games/:id` | 401 | 403/400/200 | Ownership enforced correctly |
| `POST/DELETE …/like`, `…/save` | 401 | 200, idempotent | Returns authoritative count (client ignores it) |
| `GET/POST …/comments` | 404/400 | 200/201/400 | Unpaginated; replies accepted by API, no UI |
| `DELETE /api/comments/:id` | 401 | 200/403/404 | No UI |
| `POST …/report` | 401 | 201 | Duplicates allowed |
| `GET …/source` | **404 for every game** | 404 | Broken path resolution (P0-2) |
| `GET …/leaderboard`, `…/score` | 401 | 200 | No UI |
| `GET /api/users/:id` | 200 | 200 | 404 unknown; `%` wildcard returns an arbitrary user |
| `POST/DELETE …/follow` | 401 | 201/200 | 201 on repeat; self-follow 400 |
| `POST /api/events` | 204 | 204 | 50-event cap, invalid events dropped; never called |
| `POST /api/studio/generate` | **SSE, no auth** | SSE | Publishes as `@playloop`, `moderation:'approved'` |
| Wrong method | 405 | 405 | Empty body, no error envelope (acceptable, but inconsistent) |

No route leaked a stack trace. No route returned a non-standard success envelope except the documented `204` on `/api/events`.

---

## 5. Social flow reachability

| Action | Feed | `/g/[id]` | Profile | Verdict |
|---|---|---|---|---|
| Like | ✅ rail | ❌ | ❌ | Only from the feed |
| Save | ✅ rail | ❌ | ❌ | Only from the feed; **the list has no nav entry** |
| Comment | ✅ sheet | ❌ | ❌ | No replies, no delete, no likes |
| Follow | ✅ creator row | ❌ | ✅ | Missing on the page most likely to convert |
| Report | ❌ | ✅ | ❌ | **Not reachable from the feed** where abuse is seen; no comment/user reporting |
| Share | ✅ rail | ❌ | ❌ | The share landing page cannot be re-shared |
| Mark notifications read | — | — | — | **Not reachable** (endpoint only) |
| Leaderboard / score | ❌ | ❌ | ❌ | Endpoint only |

---

## 6. Counts

| Severity | Count |
|---|---|
| **P0** | **3** |
| **P1** | **14** |
| **P2** | **23** |
| Total | 40 |

---

## 7. Test data left in the dev DB

Created while exercising the flows (no source changes): user `tester` (`1b2cdbab-…`), one score row (42) on Flappy Tap, two `reports` rows ("QA probe report"), one like/save/follow that were each reverted, one comment that was deleted via the API (verified gone). The `playloop` session used to prove P0-1 was read-only.

---

## 8. Top 5 to fix first

1. **P0-1 — close the handle-only login.** Everything else is moot while any visitor can become any creator and edit or delete their games. Gate it to dev or add a real credential.
2. **P0-2 — fix `ARTIFACTS_DIR` in `/api/games/[id]/source`** and make the Studio fail loudly when a remix base cannot be loaded. Remix is the growth loop; right now it silently lies.
3. **P0-3 — give Studio a visible error state and a closable publish modal.** This is the creation funnel: an invisible failure and an inescapable modal are the two worst possible outcomes there.
4. **P1-1 + P1-2 — make the social signals real:** insert notifications on like/comment/follow and actually send the `events` beacon (which also unfreezes `play_count` and gives the ranker data). Without these, the app is a feed with no feedback loop.
5. **P1-5 — rebuild `/g/[id]` as a real game page** (like/save/comment/share, viewer state, scrollable) or every shared link dead-ends for the recipient — which is the entire acquisition model.
