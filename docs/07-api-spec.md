# 07 — API Spec

All under `apps/web/app/api/...` (route handlers), JSON, zod-validated, errors `{error:{code,message}}`. Auth via Auth.js session cookie (app origin only). Anonymous allowed where marked [anon].

## Feed & discovery
- GET  /api/feed?cursor=&limit=10 [anon] -> `{items:[GameCard], cursor}`; GameCard = `{gameId, versionId, title, description, tags, creator:{id,handle,avatar}, artifactUrl, posterUrl, counts, viewer:{liked,saved,followsCreator}, forkedFrom?, rec:{source,position,impressionId}}`
- GET  /api/games/:id [anon] (also SSR page /g/[id] for share/SEO with OG poster)
- GET  /api/search?q=&tag= [anon]  (trigram + embedding hybrid)
- GET  /api/users/:handle , /api/users/:handle/games
- GET  /api/tags/trending

## Interactions (auth)
- POST/DELETE /api/games/:id/like ; /save ; POST /api/users/:id/follow, DELETE
- GET/POST /api/games/:id/comments ; DELETE /api/comments/:id ; POST /api/comments/:id/like
- POST /api/games/:id/report ; POST /api/users/:id/block
- GET  /api/notifications ; POST /api/notifications/read
- GET/PUT /api/games/:id/storage/:key (called by host on behalf of guest, [auth or anon-id]) ; POST /api/games/:id/score ; GET /api/games/:id/leaderboard

## Events
- POST /api/events [anon] body `{events:[{type,ts,gameId,versionId,props,impressionId}]}` batched, max 50, beacon-friendly. Server enriches with session/user, drops invalid, rate limits, returns 204.

## Creation
- POST /api/gen {kind, prompt, gameId?, baseVersionId?} (auth, credits check) -> `{jobId}` 202
- GET  /api/gen/:jobId/events (SSE; supports Last-Event-ID)
- POST /api/gen/:jobId/cancel
- GET  /api/games/:id/versions ; POST /api/games/:id/versions/:vid/restore
- GET  /api/games/:id/chat ; (messages persisted by gen pipeline)
- POST /api/games/:id/publish {title, description, tags, visibility, versionId}
- POST /api/games/:id/remix {versionId?} -> `{gameId}` (creates draft fork)
- GET  /api/me/credits ; GET /api/me/drafts
- PATCH/DELETE /api/games/:id

## Admin/mod
- GET /api/admin/reports ; POST /api/admin/games/:id/moderate {action}; GET /api/admin/costs

## Internal (workers via signed secret)
- POST /api/internal/test-result, /api/internal/embed-done (or workers write DB directly via packages/db — preferred).

## Conventions
- Idempotency-Key header on POST /api/gen and publish.
- Rate limits via Upstash ratelimit: events 120/min/user, comments 10/min, likes 60/min, gen see doc 04.
- Pagination: opaque cursors. Never offset on feed.
- Zod schemas live in `packages/db/schemas` shared client/server (also generate TS types for the client).
- Every route has a Vitest test: 401/403/400/200 cases at minimum.
