# 12 — Mobile-First Principles (BINDING; overrides other docs on conflict)

PlayLoop is a phone product first. The feed must feel like Instagram Reels / TikTok. Desktop is a centered 9:16 phone-shaped column (max-width ~480px, letterboxed) with keyboard shortcuts — NOT a separate layout in MVP.

## Design rules
1. Design and test at 390x844 first. Every PR with UI must include a mobile screenshot (Playwright, iPhone 14 + Pixel 7 profiles). Desktop is verified second.
2. Full-bleed vertical cards, `100dvh` (not `vh`; handles iOS/Android URL bar). Use `env(safe-area-inset-*)` for notch and home indicator. `viewport-fit=cover`.
3. Thumb zone: all primary actions in the bottom 40% and right edge. Right rail (like, comment, save, remix, share) with 48px targets, 16px gaps. Top of screen holds only low-frequency items (search, mute).
4. One-handed, one-finger games only (tap / drag / swipe / tilt). Game generation prompts enforce this. Keyboard is a desktop bonus.
5. Bottom tab bar (Feed, Search, Create, Saved, Profile) — fixed, 56px + safe area; auto-hides on feed while playing for max screen.
6. Studio on mobile: a creator can build a game entirely on a phone. Chat input docked above keyboard (use `visualViewport` API to handle keyboard resize), preview in a collapsible top half (drag handle), full-screen preview toggle. Voice input via Web Speech API / mic button as a stretch (creators "talk" their game idea).
7. Bottom sheets (vaul) instead of modals for comments, share, publish, remix. Swipe down to dismiss.
8. Gestures: vertical swipe = next/prev game (when not playing), double-tap = like (non-playing), long-press = quick actions (not interested, report). Haptics via `navigator.vibrate` (Android) and SDK `haptic()`.
9. Network realism: assume 4G/flaky. Budgets in doc 08 are measured under Lighthouse "Slow 4G + 4x CPU". Poster shown instantly (blurhash), artifact preloaded one ahead, skeletons not spinners.
10. Memory realism: low-end Android (2-3GB RAM). Max 3 live iframes, destroy aggressively, cap devicePixelRatio at 2 in games, particle caps in generation prompts. Test with CPU throttle 4x.
11. Battery: pause everything off-screen; no autoplaying audio until user gesture; mute toggle persists; honor `prefers-reduced-motion` and Data Saver (`navigator.connection.saveData` -> skip preload of next game).
12. Orientation: lock portrait in PWA manifest; games declaring `landscape` show a "rotate / play in landscape" overlay; MVP generation defaults to portrait only.
13. Installable PWA is the "app": iOS add-to-home-screen guide, standalone display, splash screens, status bar theme color. Test on real iOS Safari (WebKit quirks: audio unlock, no `beforeinstallprompt`, 100vh bugs, overscroll bounce).
14. Prevent browser gestures stealing input: `touch-action: none` inside game frame, `overscroll-behavior: none` on body, disable pull-to-refresh on feed container, prevent double-tap zoom, disable text selection and callouts.
15. Gesture conflict (scroll vs play) — decided approach: while a game is PLAYING, vertical swipes belong to the game inside a safe frame; user advances via (a) a slim 24px edge strip on the left that swipes the feed, (b) game-over screen, which restores full-card swipe, (c) a visible "next" chevron on the rail. Prototype this in Phase 1 spike and test with 5 real users; the alternative is "play only after tapping; swipe anywhere when paused". Record outcome as ADR.

## Mobile acceptance checklist (per feature)
- [ ] Works at 360x640 and 430x932, with and without notch
- [ ] No horizontal scroll, no layout shift when URL bar collapses
- [ ] Targets >= 44px, text >= 16px in inputs (prevents iOS zoom)
- [ ] Keyboard open doesn't hide input (Studio chat, comments)
- [ ] Works in iOS Safari, Android Chrome, installed PWA
- [ ] 60fps scroll snap on mid-range Android (Moto G class), checked via trace
- [ ] Offline / slow network shows graceful state

## Responsive layout summary
- <= 640px: native full-screen experience.
- > 640px: center column 9:16 (height 100dvh, width = min(480px, 56.25dvh)), side panels show comments/creator info on >= 1100px.
