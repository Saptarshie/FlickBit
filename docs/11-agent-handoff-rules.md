# 11 — Rules for the Implementing Agent (cheap model, e.g. DeepSeek flash class)

You are implementing PlayLoop from these docs. Be literal, small-step, and test-driven.

## Operating rules
1. Read 00-README, 12-mobile-first, and the doc relevant to your task BEFORE coding. If docs conflict, doc 12 wins, then 03 (artifact contract), then others.
2. One task ID at a time from doc 10. Don't start the next until AC is met and committed. Commit message: `P1-T4: validator static rules`.
3. Do not redesign. If something is ambiguous or impossible, write `docs/questions/<task>.md` with the question + your default assumption, proceed with the assumption.
4. Never weaken the sandbox, CSP, or validator to make a test pass. Security rules in doc 09 are non-negotiable.
5. Never call a real LLM in unit tests; use recorded fixtures/mocks. Real-model runs only in `pnpm eval:gen`.
6. Keep files < 300 lines; pure functions in packages/, thin route handlers; zod validate every input.
7. Write the test first for logic-heavy code (validator, patcher, ranker, protocol). For UI write a Playwright mobile test.
8. No new dependencies without listing them in the PR/commit body with a one-line reason; prefer ones named in doc 02.
9. Keep state resumable: jobs idempotent, migrations forward-only, scripts re-runnable.
10. After each task, run: `pnpm typecheck && pnpm lint && pnpm test` and (UI) `pnpm e2e:mobile`. Paste the result summary in your report.
11. Don't commit `.env`, keys, or generated artifacts > 1MB.
12. Update docs when a contract changes (API, schema, SDK) in the same commit.

## Suggested workflow per task
read AC -> list files to touch -> write failing test -> implement -> run checks -> mobile screenshot (UI) -> commit -> report: what changed, what is verified, what is left.

## Where the hard parts are (be extra careful)
- SDK pause semantics (doc 03): must freeze rAF, timers, audio even if the game ignores events.
- Scroll-vs-play gestures (doc 12 #15) and iframe pool memory limits.
- Patch application in the editor pipeline: fall back to full rewrite on mismatch.
- Event logging correctness (position, source, propensity) — the recsys depends on it.
- iOS Safari quirks (audio unlock, dvh, PWA install).

## Escalate (stop and ask the human) when
Choosing legal/ToS text, paid services/accounts, domain names, anything touching real money, or if AC cannot be met without changing a security rule.
