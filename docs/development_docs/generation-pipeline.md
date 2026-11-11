# Generation pipeline (vibecoding)

`POST /api/studio/generate` turns a sentence into a published, playable game.

A "turn" is a conversation, not a one-shot generation. The first turn creates a
game; every later turn **edits the same artifact**, so follow-ups ("make the ball
bigger", "add a shield pickup") are stateful: the previous build, the original
spec and the whole chat thread are inputs.

```
              ┌────────────── persisted in Postgres (PGlite in dev) ──────────────┐
prompt+gameId │ games ─┬─ game_versions (artifact sha, manifest{spec})             │
              │        └─ chat_messages (user / assistant, one pair per turn)     │
              │ generation_jobs (kind=create|edit|remix_edit, status, error)      │
              └───────────────────────────────────────────────────────────────────┘

turn 1 (create)                        turn N (edit)
─────────────                          ─────────────
planGame      planner                  reuse spec from the stored manifest  ← no re-plan
designGame    art director             (skipped: the brief is already applied)
generateCode  coder                    generateCode(baseCode, history, change)
validateGame  ─► repair ≤3             validateGame ─► repair ≤3
runSmokeTest  ─► repair ≤2             runSmokeTest ─► repair ≤2
reviewGame    ─► repair on criticals   reviewGame   ─► repair on criticals
metadata                               metadata
write artifact + version + chat turn   write artifact + version + chat turn
```

## Stages

| Stage | Code | Failure mode |
| --- | --- | --- |
| plan | `packages/ai/src/planner.ts` | invalid JSON → template archetype fallback; **skipped on edits** |
| design | `packages/ai/src/design.ts` | art-direction brief; junk JSON → deterministic fallback brief |
| generate | `packages/ai/src/generator.ts` + `openai-provider.ts` | empty content, truncation, timeout |
| validate | `packages/gamekit/src/validate.ts` | 20+ security/manifest/completeness rules |
| repair | `packages/ai/src/repair.ts` | repeats until clean or `maxRepairs` (default 3) |
| runtime gate | play-worker `POST /internal/smoke` → `packages/gamekit/src/smoke.ts` | uncaught errors, blank first frame, non-interactive, < 30 fps |
| review | `packages/ai/src/review.ts` | QA critic; `critical` issues feed one more repair |
| metadata | `packages/ai/src/metadata.ts` | extracts `pl-manifest`, else asks the model |
| publish | `app/api/studio/generate/route.ts` | DB insert (`games` → `game_versions` → `publishedVersionId`) |
| embed | `packages/ai/src/embeddings.ts` (Ollama) | best-effort; the game still publishes |

Shared rules live in `packages/ai/src/playbook.ts` (`GAME_FEEL_RULES`,
`MOBILE_RULES`, `PERFORMANCE_RULES`, `QUALITY_BAR`) so the planner, the art
director, the coder and the critic cannot drift apart.

## Why the runtime gate lives in the play-worker

Next cannot bundle Playwright (`chromium-bidi` fails to resolve in the app
router), and a browser should not live in the web process anyway. The worker
exposes `POST /internal/smoke { html } → { pass, fps, blankScreen, interactive,
consoleErrors, uncaught }`; the studio route calls it over HTTP and treats an
unreachable service as "gate unavailable" — never as a build failure.

What the gate actually does (`packages/gamekit/src/smoke.ts`): loads the artifact
at 390×844 with the guest shim injected, waits for `PlayLoop.ready()`, then
plays — a tap, a **1400 ms hold-and-release** (charge/jump games only reach their
interesting state while the pointer is down), a resize to 320×568 and back, then
random taps, long presses, drags and keys for `INPUT_MS`. It samples FPS and two
screenshots and reports every uncaught error the harness saw.

## Statefulness

`POST /api/studio/generate` body:

```jsonc
{
  "prompt": "add a shield pickup",
  "gameId": "…",           // present on follow-ups: this is what makes it an edit
  "templateId": "snake",   // optional, creation only
  "imageKey": "3f7c….png", // optional concept image (see below)
  "forkedFromId": "…"      // optional remix source
}
```

- **Base artifact**: the latest `game_versions.artifact_sha256` is read from the
  artifacts dir server-side; the client never sends HTML back.
- **Spec reuse**: the spec is stored in `game_versions.manifest.spec`. Re-planning
  from "add a shield" once invented a different genre (a neon runner became a
  brick-breaker and needed a QA repair), so the edit path reuses the original.
- **History**: the last 8 user turns are prepended to the coder prompt.
- **Ownership**: only the creator can edit (`403` otherwise).
- **Thread**: `GET /api/studio/thread?gameId=` returns game/versions/messages —
  that is what the studio UI renders after a reload.
- **Job rows**: every turn writes a `generation_jobs` row before generation and
  closes it with `succeeded`/`failed`, so a crashed run is visible instead of
  vanishing.

## Concept images

`POST /api/studio/upload` (multipart `file`) accepts PNG/JPEG/WebP/GIF ≤ 4 MB,
stores it at `apps/play-worker/uploads/<uuid>.<ext>` and returns the key. The
generate route converts it to a data URL and passes it to the art director and
the coder (`images: [dataUrl]`), so both see the palette, mood and subject. Keys
are random UUIDs; a user-supplied filename never reaches the filesystem.

## The LLM provider

`OpenAiCompatProvider` talks to any `/chat/completions` endpoint
(`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`).

**It streams.** A full game is 5–10 minutes of tokens on a reasoning model; a
single `await response.text()` behind a fixed abort timer used to kill every long
run mid-file. Now:

- request `stream: true`, assemble SSE `delta.content` chunks;
- re-arm an idle timeout (120 s) on every chunk instead of one hard deadline;
- fall back to parsing a plain JSON body if a gateway ignores `stream`;
- `max_tokens` 24 000 with `finish_reason: 'length'` continuation (≤3 splices)
  while the document is genuinely unterminated;
- **accept an artifact that closes with `</html>` even when the model was still
  "writing"** — the validator is the authority, not `finish_reason`.

Reasoning models can return `content: null` with the whole budget spent on
`reasoning_content`; the provider retries once with double the budget and throws
a clear error rather than publishing an empty file.

## Artifact extraction (`extractHtmlArtifact`)

Layered, in order: a complete fenced block → an unterminated fenced block → from
`<!doctype`/`<html` to `</html>` → from doctype to EOF (truncated) → trimmed raw.
Extraction never decides validity; `validateGame` does.

## Validation rules that matter

- Security: no external URLs, `eval` of remote code, `fetch`/XHR/WebSocket,
  `document.cookie`, `localStorage` (use `PlayLoop.storage`), `top.location`,
  `parent.` access, forms, `window.open`.
- Manifest: `<script type="application/json" id="pl-manifest">` with
  `{ title, description, controls, orientation, sdkVersion, tags, scoring }`.
- Completeness: `<html>` root, `</html>`, balanced `<script>` open/close counts —
  a closed manifest script once masked a truncated main script, shipping a black
  frame.
- Size: soft 300 KB, hard 500 KB.

## SSE protocol

The route streams `event: progress` frames:

```json
{ "stage": "spec|design|generating|validating|testing|repairing|reviewing|metadata|done|failed",
  "message": "…", "progressPercent": 40, "error": "…" }
```

A 5-second heartbeat re-sends the last stage with `(42s)` appended, so a
10-minute run never looks hung. The final `event: complete` carries
`{ gameId, versionId, versionNo, artifactUrl, metadata, spec, design, smoke,
review, timingsMs, repairs }`.

## Speed

Measured with the full 7-stage pipeline on `deepseek/deepseek-v4.1-flash`:

| Turn | Wall time | Notes |
| --- | --- | --- |
| create | ~13 min | planner + art director + coder + gate + QA |
| edit | ~10 min | no planner/designer; the coder dominates |

`GeneratedGame.timingsMs` records per-stage wall time; the studio shows it under
**team**. The coder is ~70% of every turn. `PLAYLOOP_SMOKE=0` disables the
runtime gate for fast iteration. Do not "optimise" by removing the repair loop:
truncated and invalid artifacts are the common case, not the exception.

## Repair loop

`repairCode(code, report, provider, runtimeDefects[]?)` fixes both kinds of
defect with one prompt: static validator errors and runtime/QA findings ("it
throws on hold", "the first frame is blank"). The artifact is re-validated and
re-tested after every repair, so a repair that breaks structure is caught.

## Offline mode

Without `LLM_*` the route uses `MockAiProvider`, which returns a template game.
This is the documented fallback for demos and CI — never pass it off as AI
output in the UI; the progress message says which provider is in use.

## Audit tooling

```bash
pnpm exec tsx scripts/audit-artifacts.ts            # static: file, sha, validator
pnpm exec tsx scripts/audit-artifacts.ts --fix      # unlist broken games
node scripts/audit-runtime.mjs                       # runtime: plays every artifact
node scripts/e2e-studio.mjs                          # create → follow-up → thread
```

`audit-runtime.mjs` posts every HTML artifact (published + seeds) to the smoke
service, sequentially, and writes `docs/reviews/runtime-audit.json`.
