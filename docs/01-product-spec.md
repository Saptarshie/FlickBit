# 01 — Product Spec

## Personas
- Player: wants 10-60s of fun, zero install, zero loading wait. Mostly mobile.
- Creator: non-coder with an idea ("a cozy fishing game where fish are cats"). Wants to describe, tweak, publish in minutes.
- Remixer: plays a game, thinks "I'd make it harder/prettier", taps Remix.

## Core loop
Scroll -> Play (instantly) -> React (like/save/comment) -> Remix -> Publish -> Others scroll it.

## Features

### MVP (Phase 1-3)
Feed
- Vertical full-screen snap feed; one game per screen; the active one is live, next 1-2 preloaded (paused).
- Tap-to-play overlay for first interaction (browsers need a gesture for audio); then game runs fullscreen in the card.
- Right rail: Like, Comment, Save, Remix, Share, Creator avatar/follow.
- Bottom: title, creator, description, tags, "Play count".
- Game over -> SDK emits `gameOver(score)` -> card shows Replay / Next.

Studio (AI creation)
- Chat on the left/bottom, live preview of the game on the right/top (same sandbox runtime).
- Prompt -> generation streams status ("Planning", "Writing code", "Testing", "Fixing") -> playable preview.
- Follow-up edits ("make it faster", "add a boss") produce new versions; version history with restore.
- Publish dialog: title, description (AI-suggested), tags (AI-suggested), cover (auto-captured frame), visibility.
- Remix: opens Studio pre-loaded with parent code + chat context "Remix of <game>".
- Credits: free daily AI credits; show cost estimate per generation.

Social
- Like, save (collections: "Saved"), comment (flat + 1 reply level), follow, share link, report.
- Profile: creator games grid, remixes, stats.
- Leaderboard per game (top scores; optional, via SDK `submitScore`).

Account
- Email magic link + Google. Anonymous play allowed (no login); login needed to like/save/comment/create.

PWA
- Installable, offline shell, cached recent games, push notifications later.

### Later (Phase 4+)
Code editor (power-users), asset generation (AI sprites/sfx), multiplayer-lite (async ghost/turn-based), creator analytics, challenges/jam tags, monetization (tips, premium credits), game "series", collab remix, native wrappers (Capacitor).

## Non-goals (MVP)
Real-time multiplayer, 3D engines beyond what fits in 300KB (Three.js via allowlisted CDN is OK later), native apps, payments.

## Success metrics
- Time-to-first-play < 1.5s p75 on 4G for the first game; < 300ms for swipes to preloaded games.
- Generation success (playable on first pass) > 85%; after auto-repair > 95%.
- Median session: > 8 games played. D1 retention > 30%.
- Creator conversion: > 5% of weekly actives publish a game.
- Remix rate: > 3% of plays > 15s.

## Feed card state machine
`idle -> loading -> ready(paused) -> playing -> gameover -> (replay -> playing)` and `any -> error -> skipped (auto-advance + report to telemetry)`.

## Content rules
Games must be family-safe by default (mature flag later). Moderation in doc 09.
