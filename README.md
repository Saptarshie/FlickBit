# PlayLoop
Scroll. Play. Remix. A Reels-style feed of AI-vibecoded mini games (mobile-first PWA).

Start with `docs/00-README.md`. Implementing agents: read `docs/11-agent-handoff-rules.md` and `docs/12-mobile-first.md` first.

    pnpm install
    pnpm dev          # web on :3000
    pnpm typecheck && pnpm lint && pnpm test
    pnpm infra:up     # postgres+pgvector, redis, minio, mailpit (needs Docker)

Status: P0-T1 done. P0-T3 (Drizzle schema + migration + seed) done and tested on PGlite; db:migrate/db:seed CLI and docker-compose NOT yet run against real Postgres (Docker engine was not running). Next: P0-T4.
