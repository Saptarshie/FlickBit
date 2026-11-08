# Testing

## Running

```bash
pnpm --filter @playloop/<pkg> run test     # one package (preferred)
pnpm run test                              # turbo, serialised (--concurrency=1)
pnpm run typecheck                         # tsc in every package
pnpm --filter @playloop/web run build
```

`turbo run test` is deliberately `--concurrency=1`. Running the PGlite (WASM) and
Chromium suites in parallel crashed V8 workers with `ERR_IPC_CHANNEL_CLOSED`.
A full run also exceeds a 6-minute tool timeout — run packages individually when
iterating.

## Where the tests live

| Package | File(s) | What it covers |
| --- | --- | --- |
| `sdk` | `protocol.test.ts`, `host.test.ts`, `shim-source.test.ts` | envelope validation, handshake, invalid-message counting, input payloads, pause/resume semantics, storage proxy |
| `gamekit` | `validate.test.ts`, `templates.test.ts` | every rejection rule, truncation, manifest parsing, all 8 templates validate |
| `ai` | `pipeline.test.ts`, `openai-provider.test.ts` | stage ordering, repair loop, SSE assembly, truncation continuation, null-content retry |
| `db` | `seed.test.ts`, `events.test.ts`, `rollup.test.ts` | migrations on PGlite, vector column, FK order, partitioned events, hourly rollups |
| `recsys` | `candidates.test.ts`, `feed.test.ts` | trending/fresh/social/explore queries, rollup hybrid, MMR, cursor pagination |
| `web` | `test/api.test.ts`, `test/studio.test.ts`, `src/lib/*.test.ts` | every route handler against PGlite, SSE generation with a mock provider, feed server action, auth config |
| `play-worker` | `test/app.test.ts` | artifact serving, sha mismatch, `no_manifest`, shim injection, CSP |

## PGlite harness (web)

`apps/web/test/api.test.ts` builds an in-memory-ish PGlite instance, applies
`packages/db/migrations` plus `events.sql` / `stats.sql`, seeds fixtures and
injects it with `setTestDb(db)`. Route handlers are imported directly and called
with `jsonReq(...)` and a `ctx` whose `params` is a promise:

```ts
const res = await likeRoute.POST(jsonReq('POST', `/api/games/${id}/like`), ctx(id));
```

`auth()` is mocked through a `vi.hoisted` session holder (`asUser(id)`).

Handlers wrapped with `wrap()` take `(req, ctx)` — always pass both, even for
routes that ignore `ctx`, or TypeScript fails.

## Rules

1. **Reproduce before fixing.** A red test that fails for the observed reason is
   the price of a durable fix; every bug fixed in this repo since P0 has a test.
2. **Test behaviour, not strings.** `expect(SHIM_SOURCE).toContain('setTimeout')`
   is a tripwire, not a test. Pause/resume and input dispatch have real tests
   that execute the shim against a fake window.
3. **Guest code runs in a fake window** (`makeFakeWindow()`), with
   `location.ancestorOrigins` set — that detail is what models the sandbox.
4. **DB tests must apply `stats.sql`** if they touch candidates, or the queries
   fail on a missing relation.
5. Never assert on wall-clock durations; the suite must pass on a loaded machine.

## Known slow tests

`shim-source.test.ts` waits ~3 s for the storage-timeout path, and
`openai-provider`/`studio` tests fake network latency. Keep new timeouts under
5 s so the package stays fast.
