# PlayLoop
Scroll. Play. Remix. A Reels-style feed of AI-vibecoded mini games (mobile-first PWA).

Start with `docs/00-README.md`. Implementing agents: read `docs/11-agent-handoff-rules.md` and `docs/12-mobile-first.md` first.

    pnpm install
    pnpm dev          # web on :3000
    pnpm typecheck && pnpm lint && pnpm test
    pnpm infra:up     # postgres+pgvector, redis, minio, mailpit (needs Docker)

Status: P0-T1 (monorepo) and P0-T2 (docker-compose, untested: Docker not verified here) done. Next: P0-T3.
