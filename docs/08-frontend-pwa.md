# 08 — Frontend & PWA

> MOBILE-FIRST: design for 390x844 touch first; see doc 12 (binding). Desktop is a centered 9:16 column.

## Routes (App Router)
`/` feed · `/g/[id]` game page (SSR, OG tags, plays embedded) · `/create` studio (new) · `/create/[gameId]` studio (edit) · `/u/[handle]` profile · `/saved` · `/search` · `/notifications` · `/settings` · `/login` · `/admin/*`

## Feed implementation (most critical UI)
- Container: `height:100dvh; overflow-y:scroll; scroll-snap-type:y mandatory`; each card `100dvh; scroll-snap-align:start; scroll-snap-stop:always`.
- Virtualise: keep only active ±2 cards mounted (React key by gameId). Others render poster only.
- `IntersectionObserver` (threshold 0.6) decides active card. Active: iframe live; previous: paused then destroyed after 5s; next 1: iframe loaded and paused behind poster (preload); next 2: `<link rel=prefetch>` of artifact URL.
- iframe pool: reuse at most 3 iframes (memory!). Destroy on eviction (`src='about:blank'` then remove).
- Poster overlay with "Tap to play"; first tap triggers `host.resume()` and unlocks audio. Subsequent cards auto-play (gesture already granted in session; fallback: show tap overlay if autoplay blocked).
- Gesture conflict: game area needs touch for gameplay but feed needs vertical swipe. Solution: while PLAYING, the game owns touches inside the frame; scrolling requires swipe on the right rail/edge strip, or a "Next" button, or two-finger/ edge swipe. Provide setting "swipe anywhere when game over". When state=idle/gameover, whole card swipes. Document this choice; it's the main UX risk—prototype early (Phase 1 spike).
- Optimistic like/save with rollback. Double-tap heart only in non-playing state.
- Comments in bottom sheet (vaul), lazy loaded.
- Impression/event batching via `navigator.sendBeacon` on visibilitychange + every 5s.
- Error card: if handshake fails in 3s or `error` messages > 3 -> skip and log `game_error`.

## Studio
- Layout: mobile = tabs [Chat | Preview]; desktop = split. Preview is the same `GameHost` iframe with a Studio dev bar (restart, mute, fps, console log from `PlayLoop.log`, device frame toggle).
- Chat: Vercel AI SDK `useChat`-style custom hook over SSE `/api/gen`. Show stage stepper, cancel button, credit cost estimate, version chips (v1,v2…) restore/compare.
- Publish sheet with AI suggested metadata; cover picker from captured frames.
- Autosave drafts server-side (every message is persisted).
- "Code" tab (read-only in MVP, editable Phase 4 with CodeMirror).

## PWA
- Serwist service worker: precache app shell; runtime cache: `StaleWhileRevalidate` for API GET feed (short), `CacheFirst` for artifacts (immutable) and posters with LRU cap 60 entries; offline page lists cached recent games (play works offline since artifacts cached and no network needed).
- Manifest: name PlayLoop, standalone, portrait, theme/background colors, maskable icons 192/512, shortcuts (Create, Saved).
- Install prompt: custom `beforeinstallprompt` UI after 3rd game played; iOS instructions sheet.
- Push (Phase 4): web push for remix/comment notifications.
- Note: cross-origin play iframe from `play.<domain>` must also be cached by SW — SW only intercepts same-origin scope; therefore fetch artifacts via a SW-controlled same-origin path `/play-proxy/<sha>`? NO — that breaks isolation. Alternative: the play Worker origin registers its own SW (scope `/`) that caches artifacts. Implement the SW on play origin (serve `/sw.js` with `Service-Worker-Allowed`). Verify in Phase 1 spike.

## Performance budgets
- App JS first load < 150 KB gz on feed route; LCP (poster) < 1.5s; INP < 200ms.
- Poster images WebP/AVIF ~ 20-40KB, with blurhash placeholder.
- Artifact avg 30-80KB gz → preload cheaply.
- Lighthouse PWA/perf >= 90 mobile.

## UI kit & style
Tailwind + shadcn/ui, dark by default, big touch targets (>=44px), bottom nav [Feed, Search, Create(+), Saved, Profile]. Respect `prefers-reduced-motion`. Accessibility: labels on rail buttons, captions for comments, keyboard nav on desktop (↑/↓ next/prev, space pause, M mute).

## State & data
TanStack Query for server state, Zustand for feed/session UI state. Server Components for static pages; feed is client component.

## Testing
Vitest for hooks/utils, Playwright e2e: feed swipe, play, like, create-with-mocked-LLM, remix, PWA offline.
