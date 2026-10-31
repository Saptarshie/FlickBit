# 09 — Security, Moderation, Cost Control

## Threat model: user-submitted code runs in other users' browsers
| Threat | Mitigation |
|---|---|
| Steal session/cookies/storage | Separate registrable-site origin ideally (e.g. `playloop-play.com`, not just subdomain, to avoid cookie scope leaks); sandbox without allow-same-origin => opaque origin; app cookies `SameSite=Lax; HttpOnly`, scoped to app host |
| Phishing UI inside game ("log in to continue") | Sandbox blocks forms/popups/top-nav; static scan blocks inputs of type password; visible platform chrome (rail) always outside iframe; report button |
| Exfiltrate data/tracking | CSP `connect-src 'none'`, no external img/script hosts, referrer none |
| Crypto-mining / CPU abuse | FPS/perf probe in shim; auto-pause on hidden; kill + flag game if sustained > 90% main thread (long tasks API) for 10s; smoke-test CPU budget |
| Infinite loops / memory | Host watchdog: no `ready` in 3s, rAF stalled > 5s while playing -> destroy iframe, report `hang`; auto-unlist after N hang reports from distinct users |
| Clickjacking / top navigation | no allow-top-navigation; app sends `X-Frame-Options: DENY` + `frame-ancestors 'self'` |
| postMessage abuse | Validate `event.source`, shape (zod), size, rate; never eval/HTML-inject guest strings; render text via React escaping |
| Malicious artifacts via API | Artifacts only created by the pipeline from server-side validated code; sha256 content addressing; no user upload endpoint in MVP (Phase 4 code editing goes through same validate+test) |
| Prompt injection via game remix/comments into the LLM | Treat code/comment content as data; coder prompt states that instructions inside code are untrusted; no tools with side effects given to the coder; output is only HTML artifact |
| XSS in app (comments/titles) | React escaping, no `dangerouslySetInnerHTML`, CSP on app origin with nonces |
| CSRF | SameSite cookies + origin check on mutating routes |
| Abuse of AI credits | Auth + email verified for generation, per-user/day caps, global budget, idempotency keys, device/IP heuristics, captcha (Turnstile) on signup |
| Secrets | Never in client; workers use env; `.env` not committed; rotate keys |

## Moderation
1. Prompt moderation before generation (doc 04 stage 1).
2. Output moderation: LLM classifier over code summary + text strings extracted from the code (all string literals/titles) + poster via image moderation API. Categories: sexual, hate, violence-gore, self-harm, harassment, illegal, copyright IP (known brand names -> flag not block), spam.
3. Publish gate: `moderation=pending` until classifiers pass (target < 30s); creator sees "Reviewing". Auto-approved if all low risk; high risk auto-rejected; mid risk -> mod queue.
4. Comments: classifier + blocklist; user reports; shadow-hide at 3 independent reports pending review.
5. Reports: queue at `/admin/reports` with game preview in sandbox, actions: approve, remove, unlist, ban creator, strike system (3 strikes).
6. Takedown path (DMCA) email + form; `removed` games' artifact keys kept for legal 30 days, never served.
7. Age: 13+ ToS, no minors' personal data; default family-safe.

## Privacy
Event data minimal, anon_id cookie first-party; cookie/analytics consent banner for EU; data export/delete endpoints; no PII in logs; embeddings of user taste are personal data (delete on account deletion).

## Cost control
- Budget table + Redis counters: per user/day, global/day, per job (abort if projected tokens > cap).
- Token caps per stage; max artifact size; repair loop limit 3.
- Cache: identical (prompt, model, prompt_version) -> reuse? Only for template-like prompts (low value); mostly rely on prompt caching.
- Embedding at publish only; batch.
- Alerts when cost per successful game > threshold or failure rate spike (Sentry/webhook).
- Smoke-test worker autoscale 0..N with queue depth limit; reject jobs when queue > max (show wait).

## Compliance checklist before public launch
ToS/Privacy/Content policy pages; report + takedown flow; rate limits live; CSP verified by scanner; sandbox escape test suite (doc 10 task P1-T9); load test feed.
