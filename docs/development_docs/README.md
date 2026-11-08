# PlayLoop developer docs

Operational documentation for people (and agents) extending PlayLoop. The
product/design rationale lives in `docs/00-…`–`docs/14-…`; this folder is the
"how it actually works, how to change it, how to debug it" set.

| Document | Read it when |
| --- | --- |
| [architecture.md](./architecture.md) | You need the big picture: packages, runtime topology, request paths |
| [input-pipeline.md](./input-pipeline.md) | Touch/mouse input is wrong, a game ignores swipes, or you touch the SDK protocol |
| [feed-and-scroll.md](./feed-and-scroll.md) | You change the feed, snap scrolling, card chrome, or play-mode behaviour |
| [generation-pipeline.md](./generation-pipeline.md) | You touch vibecoding, prompts, validation, or the studio |
| [data-model.md](./data-model.md) | You add a table, query the DB, or change recommendations |
| [debugging.md](./debugging.md) | Something is broken and you need a repeatable way to see why |
| [testing.md](./testing.md) | You are adding tests or the suite is red |
| [extending.md](./extending.md) | You are adding a screen, an API route, an archetype, or an SDK feature |

## Non-negotiables

These are the invariants that break the product when violated. They come from
bugs we actually shipped, not theory.

1. **Game artifacts are opaque-origin documents.** They run in
   `<iframe sandbox="allow-scripts">`. Never add `allow-same-origin`; never try
   to read the guest DOM from the host.
2. **All host→guest communication is `window.postMessage`** with
   `{ v: 1, src: 'playloop', type, id?, payload? }`. Guest payloads are capped
   at 8 KB and validated by `parseGuestMessage`.
3. **Coordinates cross the boundary in guest CSS pixels.** The host subtracts
   the iframe's bounding rect before sending (`GameCardView.toGuest`).
4. **At most 3 live iframes** in the feed (`MOUNT_RADIUS = 1`). More than that
   and low-end phones drop frames and lose WebGL contexts.
5. **Never fabricate feed data.** Server failures produce an empty page with a
   retry, never placeholder games (that once produced 404 iframes).
6. **A pause must never be applied before the guest has painted a frame**, and
   a later resume must cancel a pending pause. Otherwise games freeze on mount.

## Quick reference

```bash
pnpm install
pnpm dev                 # PGlite (:5432) + web (:3000) + play-worker (:3001)
pnpm run typecheck       # tsc across all packages
pnpm --filter @playloop/<pkg> run test
pnpm --filter @playloop/web run build
```

| Service | Port | Code |
| --- | --- | --- |
| Dev Postgres (PGlite over the wire protocol) | 5432 | `scripts/dev-db.ts` |
| Next.js app (feed, studio, profiles, APIs) | 3000 | `apps/web` |
| Artifact worker (serves `/v/<sha>.html` + injects the shim) | 3001 | `apps/play-worker` |
