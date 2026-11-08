# Generation pipeline (vibecoding)

`POST /api/studio/generate` turns a sentence into a published, playable game.

```
prompt ──► planGame ──► generateCode ──► validateGame ──► repair (≤3) ──► metadata ──► write artifact ──► DB ──► embed
            (spec)        (LLM/agent)      (gamekit)      (LLM)          (manifest)     (<sha>.html)     (game+version)  (Ollama)
```

## Stages

| Stage | Code | Failure mode |
| --- | --- | --- |
| plan | `packages/ai/src/planner.ts` | invalid JSON → falls back to the template archetype |
| generate | `packages/ai/src/generator.ts` + `openai-provider.ts` | empty content, truncation, timeout |
| validate | `packages/gamekit/src/validate.ts` | any of 20+ security/manifest/completeness rules |
| repair | `packages/ai/src/repair.ts` | repeats until clean or 3 attempts |
| metadata | `packages/ai/src/metadata.ts` | extracts the `pl-manifest`, else asks the model |
| publish | `app/api/studio/generate/route.ts` | DB insert (`games` → `game_versions` → `publishedVersionId`) |
| embed | `packages/ai/src/embeddings.ts` (Ollama) | best-effort; the game still publishes |

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
  a closed manifest script used to mask a truncated main script, which shipped a
  black frame.
- Size: soft 300 KB, hard 500 KB.

## SSE protocol

The route streams `event: progress` frames:

```json
{ "stage": "spec|generating|validating|repairing|metadata|done|failed",
  "message": "…", "progressPercent": 40, "error": "…" }
```

A 5-second heartbeat re-sends the last stage with `(42s)` appended, so a
9-minute run never looks hung. The final `event: complete` carries
`{ gameId, versionId, artifactUrl, metadata, spec }`.

## Cost and latency

Measured on `deepseek/deepseek-v4.1-flash`: ~7 min generating, ~2 min repairing,
≈9.5 min end-to-end, one repair round. If you need faster: shrink the prompt
budget (the archetype template is ~15 KB), or use a non-reasoning model for the
code stage. Do not "optimise" by removing the repair loop — truncated and invalid
artifacts are the common case, not the exception.

## Offline mode

Without `LLM_*` the route uses `MockAiProvider`, which returns a template game.
This is the documented fallback for demos and CI — never pass it off as AI
output in the UI; the progress message says which provider is in use.

## Audit tooling

```bash
pnpm tsx scripts/audit-artifacts.ts          # report
pnpm tsx scripts/audit-artifacts.ts --fix    # unlist broken games
```

Checks: file exists, sha256 matches the DB, `validateGame` clean.
