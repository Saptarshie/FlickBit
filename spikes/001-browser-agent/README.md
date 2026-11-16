# Spike 001 — can the vibe-coder agent run in the browser?

**Question.** Given a creator's browser tab, when a Pi Agent Core agent runs in a Worker
and calls tools over an OpenAI-compatible provider, then it produces a real game file in
local storage with no Node process anywhere.

**Why it matters.** The whole client-side migration rests on this. If the agent loop
cannot bundle for the browser, or cannot reach our provider, every later phase changes
shape — so this runs before any package surgery.

| | |
|---|---|
| Bundle | Vite 6.3.5, `@earendil-works/pi-agent-core` 1.5.2 + `pi-ai` 1.5.2 |
| Model | `deepseek/deepseek-v4.1-flash` through a dev-server proxy (Mode B: key never enters the page) |
| Storage | OPFS (`navigator.storage.getDirectory()` → `project/`) |
| Driver | Playwright, reading `window.__spike` |

## What it did

A single prompt, three tool calls, one real file:

```
toolCalls: ["list_project_files", "write_project_file", "list_project_files"]
files:     ["index.html (1877 bytes)"]
ms:        20593
reply:     "I wrote a single-file index.html with a tap/click/space-to-jump canvas game…"
```

The agent read the empty project, wrote the game, then re-read to confirm — a genuine
multi-turn `reason → act → observe → continue` loop, not a single completion.

Production build: `vite build` → 420 KB worker bundle (109 KB gzip), 4 modules, no Node
polyfills, build 0. Reloading the page afterwards still lists `index.html`, so the project
survives a tab lifecycle event with no agent in the loop.

## Verdict: VALIDATED

### What worked

- **Bundling** — `pi-agent-core` and `pi-ai`'s openai-completions adapter ship clean for
  the browser. The only Node references in the output are dead branches: a Bun-only
  `/proc/self/environ` probe guarded by `typeof process > "u"`, and `process.env` inside an
  error-message string in the OpenAI SDK.
- **Worker execution** — the agent, its tools and OPFS access all run off the main thread.
- **Real tool loop** — a custom tool wrote a file that the next turn could list. Tool
  results arrive as observations, which is the behaviour the current server pipeline fakes
  with a repair prompt.
- **Our provider** — OpenAI-compatible chat completions works through a 20-line proxy that
  injects the key server-side. Tool calling, streaming and (separately, in `visual.ts`)
  image input are all supported by this model.
- **Size** — 109 KB gzip for the whole agent runtime. That is 3× cheaper than the Phaser
  bundle we already ship per card.

### What didn't (yet)

- **Production proxy** — the spike's proxy is Vite middleware. Production needs the same
  twenty lines as a Next route with auth and quota; the browser code does not change.
- **Image input** — not exercised here. It works in the server pipeline (`visual.ts` sends
  screenshots), and Pi accepts `ImageContent`, but the browser path is unproven.
- **Session restore** — OPFS project persistence is proven; serialising the agent's
  transcript and resuming mid-turn is not.
- **`streamProxy()`** — we used a plain fetch proxy rather than Pi's own helper. Same
  shape, less package surface.

### Surprises

- The model is a reasoning model: the first turn spent ~8 s before any tool call. The loop
  is fine, but a 12-cycle task is a minutes-long operation, which makes checkpointing
  non-optional rather than nice-to-have.
- Nothing needed a WebContainer, a Node shim or a bundler plugin. The "browser-native
  agent" premise held on the first honest run.

### Recommendation for the real build

1. Port the proxy to `apps/web/app/api/llm/stream` with auth + quota + model allowlist.
2. Add `write_project_file`/`read_file_range`/`search_project_text` as the first real tool
   set — the spike's two tools are the shape the retrieval layer will extend.
3. Keep the deterministic controller outside the model: phase, budgets, checkpoints and
   stop reasons belong to our code, not to the agent's own judgement (design §6.7).
