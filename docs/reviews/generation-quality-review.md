# Generation Quality Review — PlayLoop AI Games

**Date:** 2026-11-11 · **Reviewer:** independent critic (no source edits) · **Model under test:** `deepseek/deepseek-v4.1-flash` via Command Code
**Method:** static review of `packages/ai`, 8 seeded templates, one real end-to-end generation, plus a scripted Playwright playtest of the produced artifact at 390×844.

---

## 0. Verdict

**The games are playable and they are not good.** The pipeline reliably emits *something* that runs at 60 fps, but "runs" is where the bar stops. Nothing in the chain — docs, prompts, templates, validator, publish path — defines or enforces a consumer-quality game, and the reference material the model is handed (the templates) is objectively worse than what the model writes on its own.

| Layer | Score /10 | One line |
|---|---|---|
| Prompt layer (`packages/ai/src/prompts.ts`, `generator.ts`) | **5** | Good security rules, decent quality checklist added mid-review, but no archetype-specific mechanics, the spec is half-dropped, and the repair prompt still teaches a non-existent SDK |
| Seeded templates (`packages/gamekit/templates/*.html`) | **3** | 8 bare prototypes: no start screen, no game-over screen, no restart, no audio, no juice — and a unit test *enforces* that they stay that way |
| Pipeline (`pipeline.ts`) | **4** | Static validation only. The Playwright smoke harness exists and is never called. Validation *warnings* are ignored. Repair failures are unlogged |
| Validator (`validate.ts`) | **4** | Solid security/sandbox checks, zero quality checks, and its SDK checks false-positive on any aliased `PlayLoop` |
| Produced game (this run) | **5.5** | Genuinely nice start screen and theme; thin gameplay, buggy best-score, duplicate game-over UI, restart tap swallowed |
| Host presentation of a finished game (`GameCardView.tsx`) | **5** | Game-over overlay shows the words "Game over", *no score*, and duplicates any in-canvas game-over screen |

**The single most damaging fact:** `packages/gamekit/src/templates.test.ts:67-79` asserts each template's game script is **≤ 60 non-empty lines**. Every template is 45–60 lines of flat coloured rectangles. Those files are then pasted into the coder prompt as "Reference Archetype Code" (`generator.ts:62`). The prompt's own quality bar and the reference code contradict each other, and the model resolves that contradiction by matching the reference code's ambition while adding a token start screen.

---

## 1. Evidence collected

| Artifact | What it is |
|---|---|
| `.artifacts/critic-gen.log` | Full pipeline log of one real generation (timestamps per stage) |
| `.artifacts/critic-game.html` | The produced game (23,859 bytes, 897 lines, sha256 `a4a4d945…2fb78`) |
| `.artifacts/critic-shots-start.png`, `.artifacts/critic-shots-over.png`, `.artifacts/critic-shots-resized.png`, `.artifacts/critic-shots/midplay.png`, `.artifacts/critic-shots/dead-settled.png` | Playtest screenshots at 390×844 @2× |
| `.artifacts/critic-playtest.ts`, `critic-midplay.ts`, `critic-dead-shot.ts` | The throwaway harnesses used to drive the game |

**Run timings (from the log):** spec 6.0 s → code generation 367 s → validate 0 s (failed) → repair 42.6 s → metadata 0 s. **Total 416 s** for one game. That is 7 minutes of dead time in a consumer "create" flow, and it produced a file that then needed a full-document rewrite by the repair model.

**Prompt version caveat (important):** `packages/ai/src/prompts.ts` was rewritten on disk at **19:52:56** during this review; the generation run started at **19:53:43**. The run therefore used the *current* 84-line prompts, which already contain the "PLAYLOOP SDK" fix and the new "QUALITY BAR" block. Everything below is the **best case** of today's prompts, not the pre-change worst case. The old 71-line version I initially read had no start-screen/HUD/game-over/audio/difficulty requirements at all and instructed the model to call `window.playloop?.ready()` / `sendScore` — an API that does not exist.

---

## 2. Prompt review (as a prompt engineer)

### 2.1 What is now good

- Security/sandbox rules are explicit, numbered and testable.
- The SDK block (`prompts.ts:40-49`) now names the real global, is case-sensitive about it, and explicitly forbids `window.playloop` / `sendScore` / `sendGameOver`.
- The QUALITY BAR (`prompts.ts:54-63`) asks for start screen, HUD, in-canvas game-over + restart, ≥3 juice effects, WebAudio created on first gesture, a difficulty curve, coherent palette, and clamped delta time. That is a reasonable checklist and it visibly worked: the produced game has all of them.

### 2.2 Concrete weaknesses

1. **The repair prompt still teaches the broken API.** `prompts.ts:72`: *"Include `window.playloop?.ready();` on startup."* The coder prompt says the opposite two dozen lines above. Any repair call can regress a correct game into a dead one (`window.playloop` is `undefined`, `.ready()` is a no-op, and the game never signals `PlayLoop.gameOver` → the feed card never ends). This is the single highest-severity prompt bug left.
2. **The reference code is a barebones prototype.** `generator.ts:59-62` appends the entire 3.5–5 KB template. The QUALITY BAR asks for a game 6–10× richer than the example it ships with. Models copy the *shape* of the reference, not the checklist. This is the strongest explanation for "nice start screen, 50 lines of actual game".
3. **The spec is half-dropped.** `generator.ts:60` passes concept, templateId, coreMechanic, controls, palette, loseCondition. It silently discards `spec.title`, `spec.genre`, `spec.winCondition` and `spec.audioNotes` — even though the planner prompt spends tokens extracting them (and `audioNotes` is where the model is most likely to specify a real sound design).
4. **"Keep it DRY: no comments, no duplicated blocks"** (`generator.ts:60`). Forbidding comments on an 800-line single-file game actively hurts: it removes the section structure a later remix/repair pass needs, and it pushes models toward dense one-liners. Comments cost ~2 % of the byte budget and buy maintainability.
5. **The size budget is anti-polish:** *"under 30 KB (~700 lines)"*. The reference is 4 KB. There is no lower bound, so a 4 KB game that passes validation is indistinguishable from a 24 KB one. Add a floor: *"must be at least 500 lines / 18 KB of real game code"*.
6. **Archetype is a label, not a mechanic spec.** The model is told `Archetype: tap-runner` and given no per-archetype definition of what makes that archetype *feel* right (coyote time, jump buffering, variable jump height, spawn fairness for a runner; cascade animation and shuffle-detection for match-3; etc.). One generic quality list cannot cover 8 genres.
7. **The planner emits fields that never bind to code.** `controls` is free-text from the planner but the manifest enum only allows `tap|drag|swipe|tilt|keys`; the produced game plays *hold + swipe up + swipe down* and declares `"controls":"tap"`. The manifest is now a lie that no consumer can detect and no filter can use.
8. **Planner output is unvalidated.** `planner.ts:29-34` strips fences and `JSON.parse`s; on any error it falls back to `prompt.slice(0,30)` and "Tap or drag". `zod` is already a dependency of `@playloop/ai` and unused here. A malformed plan silently degrades the whole run and nothing is logged.
9. **No anti-pattern list.** The prompt never forbids the failure modes LLMs actually produce: gameplay compressed into one corner, obstacles spawned faster than human reaction time, text at 8 px, `BEST 0` while the score is 40, duplicated HUD on the game-over screen, taps swallowed during a fade-in. All five appear in the artifact reviewed below.
10. **No host-integration contract beyond the SDK calls.** Nothing tells the game that the host *also* draws a "Game over / Replay" overlay, so a well-behaved game double-stacks its own "WRECKED" screen under it. Either the host stops drawing one, or the prompt must say "the host owns the restart UI; draw a quiet summary, do not draw a second full-screen overlay".
11. **Section numbering is broken** (`prompts.ts:31-52`: 1–7, then an unnumbered SDK block, then "9."). Cosmetic, but it is a reliable signal of prompt drift — the manifest rule is now rule 9 of a list that has no rule 8.
12. **Remix path is spec-blind.** `generator.ts:50-57` sends only prompt + base code. A remix keeps the old palette, old mechanics and old quality level, and loses the plan entirely — remix is the main way a *good* game stays good, and it is the weakest prompt in the file.

---

## 3. Seeded templates — ranking

All eight share the same skeleton (`tap-runner.html` is the canonical copy): plain `<canvas>`, `resize()` with DPR, one `update(dt)`/`draw()`, `requestAnimationFrame(frame)` where **`if (!over) requestAnimationFrame(frame)`** — i.e. rendering *stops* on death. There is no start state, no game-over UI, no restart path, no `AudioContext`, no particles, no shake, no difficulty curve in 4 of 8.

| # | Template | Start screen | HUD | Game over + restart | Juice | Audio | Controls | Difficulty ramp | Score |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `brick-breaker` | ✗ | ✓ score | ✗ (has a *win* branch, still freezes) | ✗ | ✗ | ✓ drag + keys | ✓ speed ×1.02 per hit | **4/10** |
| 2 | `match-3` | ✗ | ✓ score + 60 s timer | ✗ | ✗ (matches resolve instantly, no cascade anim) | ✗ | ⚠ tap-to-swap, no drag | ✗ | **4/10** |
| 3 | `memory` | ✗ | ✓ moves | ✗ | ✗ (cards flip with no animation) | ✗ | ✓ tap + keys | ✗ | **4/10** |
| 4 | `physics-toss` | ✗ | ✓ score + shots | ✗ | ✗ | ✗ | ⚠ inverted slingshot (drag *toward* the target) | ✗ | **3.5/10** |
| 5 | `snake` | ✗ | ✓ score | ✗ | ✗ | ✗ | ⚠ a tap with no movement turns the snake; direction only commits on `pointerup` | ✓ tick speeds up | **3/10** |
| 6 | `shooter` | ✗ | ✓ score | ✗ | ✗ | ✗ | ⚠ auto-fire, no aiming; ship clamped below `H*0.45` so you cannot dodge upward | ✓ spawn rate | **3/10** |
| 7 | `flappy` | ✗ | ✓ score | ✗ | ✗ | ✗ | ✓ tap + keys | ✓ speed drift | **3/10** |
| 8 | `tap-runner` | ✗ | ✓ score | ✗ | ✗ | ✗ | ✓ tap + keys (no duck, one obstacle shape) | ✓ `speed += 7*dt` | **2.5/10** |

Screenshot review of `tap-runner` at 390×844 (the file pasted into every runner generation): *"incredibly basic… programmer art… no title, no menu, no play button… 3/10"*. It scores 60 fps and `pass: true` in the smoke harness — proof that the current gate cannot see quality.

**Per-template defects worth naming**

- **brick-breaker** — the only template with a win state, and the ball is in motion before the player touches anything (violates the spec's "first interactive frame" intent). No lives, so one miss ends the run.
- **match-3** — genuinely the most "game-like" of the eight, but: no cascade animation (matches vanish and the board teleports), no "no possible moves" reshuffle, so the board can become dead for the remaining 40 seconds of the timer. Tap-two-neighbours instead of drag is the worst mobile interaction of the eight.
- **memory** — 8 pairs, no timer, no best-moves record, instant flips. It is a 60-second distraction with no progression.
- **physics-toss** — the drag vector is `(release - ball) * 3.2`, i.e. you drag *toward* where you want it to go and the line preview reflects that, but every other mobile toss game (Angry Birds et al.) slingshots the opposite way. Targets respawn forever, so the 5-shot limit is the only difficulty.
- **snake** — `pointerdown` records the origin, `pointerup` computes a direction with `Math.abs(dx) > Math.abs(dy)`; a deliberate tap (`dx = dy = 0`) resolves to `turn(1, 0)` and can kill the player. `COLS=16, ROWS=22` with `stepTime=0.14` is also visibly slow on a phone.
- **shooter** — `if (e.y > H + 20) { end(); }` kills the player for an enemy that has already left the screen. Unfair deaths are the fastest way to lose a feed user.
- **flappy** — pipe gap is fine, but the bird has no rotation, no flap animation, no ground/ceiling feedback: a yellow circle.
- **tap-runner** — dead flat: four rectangles and two text lines. Also no vertical framing (`groundY = H - 110`), so 80 % of the screen is empty navy.

**And the cap that keeps them this way:** `packages/gamekit/src/templates.test.ts:67-79`

```ts
it('keeps each template game script to about 60 lines of JS', () => {
  ...
  expect(lines.length, `${t.id} game script lines`).toBeLessThanOrEqual(60);
});
```

A quality bar of "start screen + HUD + game-over + restart + 3 juice effects + audio + difficulty curve" cannot be met in 60 lines. This test must be deleted before any template can be improved, and it will fail the template rewrite in CI if anyone forgets.

---

## 4. The live generation run

**Prompt used:** *"Neon cyberpunk hoverbike runner: hold to accelerate, swipe up to jump broken rails, swipe down to duck under laser gates, collect glowing data chips. Speed ramps up, near-misses trigger a slow-motion flash. Dark city skyline, hot magenta and cyan."*

**Result:** published after **1 repair**, 23,859 bytes, `validateGame` → **0 errors, 2 warnings**: `missing PlayLoop.ready() call`, `missing PlayLoop.gameOver() call`.

### 4.1 Does it validate / start?

- `validateGame`: **passes** (0 errors).
- Smoke harness (`npx tsx packages/gamekit/src/run-smoke.ts .artifacts/critic-game.html`): **`pass: true`, readyWithin3s, no console errors, interactive, 60.4 fps, framesDiffer**.
- Scripted playtest with real pointer gestures: start screen → tap → `state: play`, 5 jumps + 2 ducks registered, died at **411**, restart works, **0 console errors**, survives a resize to 430×932.

So: it starts, it plays, it ends, it restarts. **The two validate warnings are false positives** — the game writes `const PL = window.PlayLoop` and calls `PL.ready()` / `PL.gameOver({score})`. `validate.ts:339-344` greps for the literal `PlayLoop.ready(` / `PlayLoop.gameOver(` with a capital-P receiver, so any aliasing (the *correct* defensive pattern the prompt encourages) trips the warning. A checker that fires on good code is worse than no checker.

### 4.2 What the consumer actually experiences

| Screenshot | Independent read | Rating |
|---|---|---|
| `start.png` | Title "NEON VOLT" glowing, four-line how-to-play, "TAP TO START", synthwave skyline + rain. Clear and genuinely attractive. | **8/10** |
| `midplay.png` | Bike at bottom-left; hazard (a laser gap) entering at the right edge; chips visible. *"Hazards… blend into the background… action crammed into the bottom 20 %, top half is empty sky."* | **4/10** |
| `dead-settled.png` | "WRECKED", score 99, best 99, "TAP TO RESTART". Readable and on-theme, but the top HUD *also* still shows score + BEST, and the boost bar and ×1.5 multiplier are still on screen. | **6/10** |

### 4.3 Defects in the produced code (all real, all findable by a stricter gate)

1. **Best score never persists.** `if (PL.storage) { const b = PL.storage.get('best'); if (typeof b === 'number') best = b; }` — `storage.get` returns a `Promise<unknown>` (`packages/sdk/src/PlayLoop.d.ts:21`). `typeof promise === 'object'` → `best` is always 0 on load. The game *writes* the best score (`PL.storage.set('best', best)`) and never reads it back. Silent, permanent loss of the only meta-progression the game has.
2. **Dead API reference left in the file** (line 893): `if(window.playloop&&typeof window.playloop.ready==='function')window.playloop.ready();`. Harmless, but it is the exact anti-pattern the new coder prompt forbids — evidence the model is still contaminated by the old prompt corpus (and by `mock-provider.ts:55` / `repair.ts`'s system prompt).
3. **The playfield is 15 % of the screen.** `groundY() = H - 130`; at 844 px tall that is a 130 px band at the bottom, with a 40 px bike and 30 px obstacles. The top 600 px is decoration. Portrait endless runners want the horizon at 50–60 % and the play band scaled up.
4. **Obstacle density is sparse and unpatterned.** Sampled over a full run: **0.76 obstacles on screen on average, 24 % of samples empty**. Combined with a 245 px runway at 330–630 px/s, reaction time falls to **~0.39 s at top speed** — under human choice-reaction time. Spawns are `Math.random()` per obstacle with no check that a jump-then-duck sequence is clearable.
5. **Restart tap is swallowed.** `drawOver` shows nothing until `overT > 0.35` and the game refuses a restart tap until `overT > 0.9`. A player who taps the instant they die gets no response and no prompt for ~1 s.
6. **Double game-over UI.** The game draws a full-screen "WRECKED" overlay *and* calls `PL.gameOver()`, which makes `GameCardView.tsx:714` draw its own 55 % black scrim with "Game over / Replay / Next" on top. The consumer sees two overlapping end screens, one of which shows no score.
7. **HUD duplication on the end screen** — top score + BEST plus overlay score + BEST; the boost meter and combo multiplier stay visible after death.
8. **`BEST 0` next to a live score of 42** during every run (consequence of #1) — the exact "does this game even work" signal that makes users swipe away.
9. **Title mismatch:** spec title `"Neon Drift: Data Run"`, shipped title `"Neon Volt"`. The metadata stage short-circuits on the embedded manifest (`metadata.ts:11-20`), so the planner's title, the metadata prompt, and the artifact are three independent sources of truth.
10. **No comments anywhere** (prompt rule) on an 897-line file; sections are implicit.
11. **`submitScore` every 300 ms** — ~150 postMessages per run for a value the feed never reads (see §5.3).

Quality of the code itself is decent: state machine, `dt` clamp, DPR handling, parallax skyline cached to offscreen canvases, a real audio synth with 8 SFX, particle pool, shake, chromatic aberration, slow-mo on near miss. **The model can clearly do better than the templates. The system is what caps it.**

---

## 5. Systemic gaps outside the prompt

### 5.1 The smoke test is never run in the product
`packages/gamekit/src/smoke.ts` is a real Playwright harness (ready handshake, console errors, blank-screen detection, interactivity, fps, frame-diff). It is wired to a CLI (`run-smoke.ts`) and tests only. `pipeline.ts` has a `'testing'` stage in `types.ts:8` that is **never emitted**, `docs/04-ai-creation-pipeline.md` claims step 5 is "SMOKE TEST (Playwright worker)", and `apps/web/app/api/studio/generate/route.ts` publishes immediately after static validation. Every generated game is published without ever being run.

### 5.2 Validation is security-only, and its warnings don't block
`validate.ts` checks size, forbidden tokens, external URLs, truncation, manifest shape. It never checks that a game has a start state, a game-over path, a restart, audio, or a visible score. Warnings (`missing PlayLoop.ready()`) are computed and then dropped by `pipeline.ts:52-62`, which only loops on `errors`.

### 5.3 The host throws away the score
`grep -i score apps/web/src/components/GameCardView.tsx` → **no matches**. The feed subscribes to `onGameOver` but never to `onScore` or `gameOver.payload.score`; the overlay at `GameCardView.tsx:714-748` renders the literal string "Game over" with Replay/Next and no number. Every game's `gameOver({score})` — the one thing every game does right — dies in the client.

### 5.4 Mute is a no-op for game audio
`packages/sdk/src/shim-source.ts:346,470,479` tracks `muted` and never uses it. The shim wraps `AudioContext` only to `suspend()` on pause (line 202-218). `GameCardView.tsx:244` calls `host.mute(muted)`; the message arrives, `muted` flips, and nothing else happens. In an autoplaying feed this means **every generated game with audio plays sound while the app says it's muted**.

### 5.5 Repair is a blind full rewrite
`repair.ts:12` sends the whole document + error strings and asks for a fixed document. No spec, no quality bar, no diff, `temperature: 0.2`. It cannot know what the game was supposed to be, so it is free to drop mechanics (the reviewed game escaped with its theme intact; that is luck, not design). `pipeline.ts` also discards the actual error text from the log, so nobody can tell *why* the first attempt failed.

---

## 6. Prioritized changes (highest quality lift first)

### P0 — Remove the quality ceiling

**1. `packages/gamekit/src/templates.test.ts:67-79` — delete the 60-line cap.**
Replace it with a *quality* test, e.g.:

```ts
it('every template meets the PlayLoop quality bar', () => {
  for (const t of TEMPLATES) {
    expect(t.code, t.id).toMatch(/TAP TO (START|PLAY)/i);     // start gate
    expect(t.code, t.id).toMatch(/TAP TO (RESTART|PLAY AGAIN)/i); // game over
    expect(t.code, t.id).toMatch(/AudioContext/);             // audio
    expect(t.code, t.id).toMatch(/PlayLoop\.storage/);        // best score
    expect(t.code.length, t.id).toBeGreaterThan(12_000);      // real game, not a demo
    expect(t.code, t.id).not.toMatch(/if \(!over\) requestAnimationFrame/); // never freeze
  }
});
```
(The last one is the exact string that appears in all 8 files today.)

**2. `packages/gamekit/templates/*.html` — rewrite all 8 to ~350–500 lines each.**
One shared skeleton, then per-archetype mechanics:

- state machine `start | play | over | paused`, simulation frozen in `start`, never restarted on load
- start screen: title, 2–3 word control hint, "TAP TO START", best score
- HUD inset by `PlayLoop.safeArea`: score, best, plus lives/timer only where relevant
- in-canvas game over: dimmed scene, final score, best, "NEW BEST" celebration, "TAP TO RESTART"
- restart must not reload — reset state, keep the canvas and audio context
- juice: particle burst pool, screen shake on death, squash/stretch, hit flash, floating `+10` numbers
- audio: one `AudioContext` created on first gesture, 4–6 oscillator SFX, master gain, respects pause
- difficulty: a documented ramp (speed/spawn/size) that is survivable at t=0
- best score via `PlayLoop.storage.get('best')` **awaited** (see P1 #6)
- a 10-line header comment saying what the archetype is and how the juice is wired

**3. `packages/ai/src/generator.ts:59-62` — stop pasting a whole game as the reference.**
Replace the reference-code block with a *required shell* + *archetype notes*:

```
REQUIRED SHELL (copy this structure, extend it):
  state machine start|play|over, simulation frozen until first input,
  HUD inset by PlayLoop.safeArea, in-canvas game-over with final+best score,
  TAP TO RESTART, audio bus created on first gesture, particle pool, shake.

ARCHETYPE NOTES (tap-runner): coyote time 100ms, jump buffering 120ms,
variable jump height, obstacle runway >= 0.7s at current speed,
spawn patterns (single / double / gap) never place two hazards closer than
(speed * 0.55s) apart, speed ramp +2%/10s up to 1.8x, ground band = bottom 45%
of the viewport.
```
Keep the template *only* as a mechanics reference in a small fenced excerpt (the collision + spawn functions), not as a whole file.

### P1 — Make the pipeline refuse to publish junk

**4. `packages/ai/src/pipeline.ts` — add the smoke gate (stage `'testing'`, 80 %).**

```ts
import { runSmokeTest } from '@playloop/gamekit/smoke';

reportProgress({ stage: 'testing', message: 'Running the game in a headless browser...', progressPercent: 80 });
let smoke = await runSmokeTest(code, { timeoutMs: 20_000 });
while (!smoke.pass && repairsCount < maxRepairs) {
  repairsCount++;
  code = await repairCode(code, { ...validateGame(code), errors: [
    ...validateGame(code).errors,
    ...smoke.consoleErrors,
    ...smoke.uncaught,
    ...(smoke.blankScreen ? ['the game renders a blank screen'] : []),
    ...(smoke.interactive ? [] : ['the game does not respond to taps']),
  ]}, provider);
  smoke = await runSmokeTest(code);
}
if (!smoke.pass) throw new Error(`smoke test failed: ${JSON.stringify(smoke)}`);
```
`runSmokeTest` already returns exactly the fields a repair prompt needs. `docs/04-ai-creation-pipeline.md` already promises this; the code does not do it.

**5. `packages/gamekit/src/validate.ts` — quality rules, and stop false-positiving on aliases.**
Add to `validateGame`:

```ts
const sdkCalled = (name: string) => new RegExp(`\\.${name}\\s*\\(`).test(code);
if (!sdkCalled('ready'))          errors.push('quality: never calls .ready() — host handshake will fall back to window load');
if (!sdkCalled('gameOver'))       errors.push('quality: never calls .gameOver() — the run can never end, the feed cannot advance');
if (!/start|tap to play|tap to start/i.test(code) || !/state\s*[:=]/.test(code))
                                  warnings.push('quality: no start gate detected — the simulation may begin on load');
if (!/AudioContext|webkitAudioContext/.test(code))  warnings.push('quality: no audio — silent games feel dead in the feed');
if (!/restart|play again/i.test(code))              warnings.push('quality: no restart affordance');
if (bytes < 12 * 1024)            warnings.push(`quality: ${bytes} bytes is a demo, not a game (aim for 20-60 KB)`);
```
Promote the missing `.gameOver` to an **error** (it is the one failure that makes the product unusable: `GameCardView` only shows Replay on `onGameOver`). And accept any receiver — `PL.ready()` is correct code.

**6. `packages/ai/src/prompts.ts:72` — fix the repair prompt.**
Replace `- Include window.playloop?.ready(); on startup.` with:

```
- Call window.PlayLoop.ready() once the first frame is drawn and
  window.PlayLoop.gameOver({score}) when the run ends. The global is
  `window.PlayLoop` (capital P+L). window.playloop, sendScore and
  sendGameOver do not exist — never reintroduce them.
- Preserve every existing feature: start screen, HUD, audio, particles,
  screen shake, difficulty ramp, restart. Fix only what validation reports.
```

**7. `packages/ai/src/generator.ts:51-56` — remix keeps the plan.**
```ts
const remixPrompt = `Remix this HTML5 game. Keep its quality bar (start screen, HUD,
in-canvas game over with restart, audio, juice, difficulty ramp) and change only what
the prompt asks for.\n\nPrompt: ${userPrompt}\nSpec: ${JSON.stringify(spec)}\n\nBase Code:\n${options.baseCode}`;
```

### P2 — Raise the ceiling

**8. `packages/ai/src/generator.ts:60` — pass the whole spec and raise the budget.**
```ts
`Title: ${spec.title}\nGenre: ${spec.genre}\nConcept: ${spec.concept}\nArchetype: ${spec.templateId}\nMechanics: ${spec.coreMechanic}\nControls: ${spec.controls}\nPalette: ${spec.palette.join(', ')}\nWin: ${spec.winCondition ?? 'endless — survive as long as possible'}\nLose: ${spec.loseCondition}\nAudio: ${spec.audioNotes ?? 'WebAudio blips on pick-up, hit, start'}`
```
and change the rules to `18–60 KB (~500–1200 lines)`, `comments allowed for section headers`, keep "no preamble / no fences / must end with </html>".

**9. `packages/ai/src/planner.ts` — validate the plan with zod and enrich it.**
Add to the schema (and to `GameSpec`/`types.ts`): `artStyle` ("flat neon / pixel / paper-cut", plus 2 adjectives), `playfieldLayout` ("ground band 45% of viewport"), `difficultyCurve` (start speed, +% per 10 s, cap), `juicePlan` (3 named effects), `sessionLengthSec` (15–90), `restartBehavior` ("tap the canvas, no reload"). Parse with `z.object({...}).safeParse(parsed)` and log the failure reason instead of silently falling back.

**10. `apps/web/src/components/GameCardView.tsx` — show the score.**
Subscribe in the `GameHost` options: `onScore: (p) => setLiveScore(p.score)`, and store `onGameOver: (p) => { setFinalScore(p.score); ... }`. Render `finalScore` and `best` in the overlay at line 728 instead of the static "Game over", and hide/soften the game's own overlay by passing a flag or simply letting the game's screen show through the host's scrim (`background: 'transparent'` + a bottom sheet instead of a full-screen scrim).

**11. `packages/sdk/src/shim-source.ts` — make mute real.**
In the `ShimmedAudio` wrapper, create a master `GainNode` between every `destination` connection and `audioContext.destination`, or simpler: on `mute`, call `c.suspend()` over `eachAudio(...)` and `c.resume()` on unmute (same machinery as pause at line 263). Then either path genuinely silences the game.

**12. `packages/ai/src/metadata.ts` — stop trusting the embedded manifest blindly.**
If the embedded title differs from `spec.title`, prefer the spec's (it is what the user asked for) and keep the artifact's for the artifact. Right now every run produces two names for one game.

### P3 — Polish the loop

13. `pipeline.ts` — log the actual validation/smoke error text into the progress message and persist `repairsCount` + first-failure reason on the version row. Today the log says only "Repairing validation issues (attempt 1/3)"; we cannot tell what was wrong with attempt 1.
14. `prompts.ts:31-52` — renumber (there is no rule 8) and move the manifest rule to the top with the security rules.
15. `packages/gamekit/src/index.ts:44` — templates are read synchronously at import time; one bad template file breaks every consumer of `@playloop/gamekit`. Load lazily or validate on first access.
16. `generate/route.ts` — set `moderation: 'approved'` and `status: 'published'` only after the smoke gate from P1 #4 passes; otherwise publish as `draft` with the smoke report attached.

---

## 7. Reproduce

```bash
cd /d/prac_prog/fun/PlayLoop
npx tsx packages/ai/gen-probe-critic.ts                       # ~7 min, writes .artifacts/critic-gen.log
npx tsx packages/gamekit/src/run-smoke.ts .artifacts/critic-game.html
npx tsx .artifacts/critic-playtest.ts                         # scripted playtest + screenshots
```

---

## 8. Bottom line

The model is not the bottleneck. A 24 KB, feature-complete, 60 fps, synthwave game came out of a single prompt — with a genuinely good start screen — while being handed a 4 KB rectangle game as its "reference". Fix the reference material (kill the 60-line test, rewrite the templates), run the smoke test the docs already describe, make the validator demand a start/end/restart, and give the coder the parts of the plan it currently throws away. Expect the median game to move from "playable demo" (5.5) to "keeps you for 40 seconds" (7.5) without touching the model.
