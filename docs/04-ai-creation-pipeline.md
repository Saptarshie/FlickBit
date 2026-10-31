# 04 — AI Creation Pipeline

Goal: user types an idea; in < 60s gets a playable, tested game; can iterate by chat.

## Stages (one `generation_job`, status streamed over SSE)
1. INTENT/SAFETY: moderation classifier on prompt (cheap model or OpenAI moderation). Reject/ask rewrite if disallowed.
2. SPEC (planner, cheap-mid model, JSON out): game concept, core mechanic, controls (must be 1-finger), win/lose, scoring, art style (palette, shapes, emoji/SVG), audio notes, difficulty curve, 3 risks. Pick closest template(s) from gamekit for few-shot.
3. CODE (coder model, strongest affordable): produce single HTML file following Artifact Spec. System prompt contains: spec rules, SDK API, constraints (no network, no storage APIs, portrait-first, seeded rng, framerate-independent loop with dt, object pooling, cap particles), 1-2 template examples, output format `<artifact>…</artifact>`.
4. STATIC VALIDATE (doc 03). On failure -> REPAIR with the violation list.
5. SMOKE TEST (Playwright worker). On failure -> REPAIR with report (console errors, blank-screen flag, fps, screenshots described by VLM only if cheap).
6. REPAIR LOOP: max 3 iterations; each gets previous code + structured error. Use diff/patch output (search/replace blocks) not full rewrites after iteration 1 to save tokens. If still failing -> fallback: retry from SPEC with the strongest model once; else mark failed, refund credits.
7. POLISH (optional, flag): second pass improving juice (screen shake, particles, sound), re-test.
8. METADATA: LLM generates title, description, tags, "how to play" line; cover = test-captured poster.
9. EMBED + MODERATE (async after publish-preview): see below.

## Editing / follow-ups
Chat state = list of messages + current `version_id`. Edit request -> "editor" prompt with current code, user instruction, return SEARCH/REPLACE patches. Apply patch in code; if patch fails to apply -> fall back to full rewrite. Always re-run validate + smoke. Each success = new `game_versions` row (parent_version_id).
Remix = new `games` row with `forked_from_game_id`, copies code of the chosen version, new chat; credit shown on card ("Remix of @x"). Original creator gets a notification + remix count.

## Model routing (config in `packages/gamekit/models.ts`, env-overridable)
- planner/metadata/moderation: cheapest capable (e.g. deepseek flash class, gemini flash).
- coder: best code model within per-generation budget (e.g. Claude Sonnet / DeepSeek V-class / Gemini Pro; choose by A/B on gen-success rate and cost).
- repair: same as coder, or cheaper for tiny patches.
- Maintain `model_runs` table (model, tokens in/out, cost, latency, outcome). Weekly review picks best $/successful-game.
- Prompt caching: keep system prompt + templates as a stable prefix.

## Credits & limits
- `credits` ledger table (append-only). Free: 20 credits/day. Cost: new game ~5, edit ~2, remix-edit ~2, polish ~2. Failed pipeline = refund.
- Rate limit: 3 concurrent jobs per user, 30 jobs/day hard cap. Per-IP limits for anon (no anon creation).
- Global kill switch + daily $ budget in Redis; when exceeded show "AI is resting".

## Streaming UX contract
SSE events: `status{stage}`, `token{text}` (optional code stream hidden by default), `preview{versionId, artifactUrl}`, `error{code,message}`, `done{versionId, report}`. Persist events so refresh resumes (`GET /api/gen/:jobId/events` with `Last-Event-ID`).

## Prompt files (to author; store in packages/gamekit/prompts/*.md)
`planner.md`, `coder.md`, `editor.md`, `repair.md`, `polish.md`, `metadata.md`. Each has versioned header `# version: 3`; job rows record prompt versions for later eval.

## Evaluation harness (build early)
`pnpm eval:gen` runs 50 canned prompts (diverse genres) through the pipeline, reports: first-pass pass rate, after-repair pass rate, avg cost, avg latency, FPS, human-rating CSV for sampling. Gate prompt/model changes on it (no regression > 3%).

## Content analysis used by recsys (produced at publish, async)
- `code_summary`: LLM reads code -> structured JSON {mechanic, genre, theme, mood, difficulty, art_style, narrative_premise, novelty_notes}.
- `description_text`: user description + generated description.
- Frame captioning: 3 key frames -> VLM short caption (or CLIP embed directly).
- Quality features: smoke-test metrics (fps, time-to-first-interaction, interactivity score), code size, error count.
All stored in `game_features`.
