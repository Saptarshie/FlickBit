# 05 — Recommendation System

Your idea (code->description, graphics, quality, story -> semantic embedding, plus collaborative filtering) is the right shape. Advice: treat it as a classic two-tower-ish hybrid, build in layers, and ship the simple layer first. Behavioural signals will dominate once you have data; content embeddings solve cold start (and games are tiny, new, and constantly arriving, so cold start is permanent here).

## 1. Content representation (per game version)
Three embedding views, each stored separately, plus a fused vector:
- TEXT view: concat of title, description, tags, `code_summary` (mechanic, genre, theme, mood, narrative premise). Embed with a text embedding model (e.g. 768-1024d; text-embedding-3-small/ bge-m3 / gemini-embedding).
- VISUAL view: CLIP/SigLIP embedding of poster + 2 key frames (mean-pool). Captures art style.
- BEHAVIOUR-FREE QUALITY vector (not embedded; scalar features): fps, size, time_to_first_input, interactivity, error_count, gen_repairs, has_audio, session-length estimate.
- Fused `content_vec` = L2norm(w_t * text + w_v * visual); start w_t=0.65,w_v=0.35; store 1024d (project/pad or use halfvec). pgvector HNSW index on `content_vec` (cosine).
Note on "code to description": embedding raw code is weak; embedding an LLM-written structured summary of what the game DOES is far better. Optionally also embed the raw code with a code model as a 4th view for "mechanic similarity" (low weight; evaluate offline before keeping).

## 2. Behavioural signals (the events table)
Impressions, `play_start`, `play_15s`, `play_end`, `gameover`, `replay`, `like`, `save`, `comment`, `share`, `remix`, `follow_creator`, `skip_fast` (<2s), `report`, `hide`.
Derived per (user, game) label score, e.g.:
`y = 1.0*remix + 0.8*save + 0.6*like + 0.5*replay + 0.4*(play_time>=15s) + 0.3*share - 0.4*skip_fast - 1.0*report/hide`
Normalise play-time by game's typical session length (games differ). Weights are priors; tune offline.

## 3. Pipeline (three stages)
### Stage A — Candidate generation (~300 items, from multiple sources, union + dedupe)
1. Content ANN: user taste vector = time-decayed weighted mean of `content_vec` of positively-interacted games (half-life ~14 days) + optional 2nd "short-term" vector from last 10 plays. ANN top 100 for each.
2. Collaborative: item-item CF (co-play/co-like within sessions, implicit ALS or LightFM-style) -> top 100. Starts when >~50k interactions; before that, skip.
3. Trending: velocity of (plays_15s + 3*likes + 5*remixes)/(impressions+prior) in last 24-72h (Wilson/Bayesian smoothed) -> top 50.
4. Social: new games from followed creators; remixes of games you liked -> 30.
5. Exploration pool: fresh games (< 48h) with few impressions, quality gate passed, sampled via Thompson sampling -> 40.
Hard filters: published, moderation=approved, not hidden/blocked by user, not seen in last N days (Bloom/Redis set), age rating.
### Stage B — Ranker
Phase 1 (heuristic): `score = 0.40*sim(user_vec,content_vec) + 0.25*cf_score + 0.20*bayes_engagement_rate + 0.10*quality + 0.05*freshness_decay`.
Phase 2 (learned): LightGBM/XGBoost with pairwise or binary objective predicting P(play>=15s), P(like), P(remix) -> combined `E[value] = a*P15 + b*Plike + c*Premix`. Features: sim scores, per-source flags, game stats (CTR, completion rate, replay rate, like rate, remix rate, age, size, fps), creator stats, user stats (activity, genre affinity vector dot), context (hour, device, session position, previous game's outcome), cross features. Train nightly on events with position-bias handling (log position, train with position as feature, serve with position fixed/neutral; or inverse-propensity weights). Offline metrics: AUC, NDCG@10, calibration.
Phase 3 (optional): two-tower neural retrieval trained on interactions replacing the content-ANN mean-vector, content_vec as item tower input (solves cold start natively).
### Stage C — Re-ranker (rules over the top ~30)
- Diversity: MMR over `content_vec` (lambda ~0.7); cap same genre run to 2 in a row, same creator to 1 per 5.
- Pacing: alternate hard/easy, short/long if known.
- Freshness slot: ensure ~1 in 5 items from exploration pool.
- Anti-fatigue: if user skipped the last 3 quickly, inject a high-confidence safe pick (top trending in their favourite genre).
- Safety: drop anything with open reports > threshold.

## 4. Cold start
- New user: onboarding "pick 3 vibes" (chips: cozy, arcade, puzzle, spooky, funny, chill, hard, cute...) -> maps to tag-embedding vector. Else popularity by locale/device + diversity; learn within first 5 plays (short-term vector dominates).
- New game: content ANN gives similar-taste exposure; exploration budget gives each qualifying game ~200-500 impressions; promote if Bayesian engagement beats cohort median, else decay. Creators cannot buy exposure.
- New creator: same as new game; first game gets a small guaranteed boost.

## 5. Bandit layer
Epsilon/Thompson over candidate *sources* and over fresh games. Log `source` and `propensity` per impression for unbiased offline eval.

## 6. Quality & integrity
- Quality gate score `q` from smoke metrics + engagement priors; games with `q` below threshold not eligible for the feed.
- Anti-gaming: dedupe near-identical artifacts (embedding sim > 0.97 and code hash/shingle similarity) -> downrank clones that add nothing; remixes are linked to parents, remix-of-popular is allowed but must have changes (diff ratio > 5%).
- Bot filtering on events (rate, device fingerprints, IP reputation).

## 7. Serving
- `GET /api/feed?cursor=` -> returns 10 items; server keeps per-session candidate list in Redis (TTL 30m): refill when < 5 left.
- Log impression event with `{game_id, position, source, score, model_version}` at serve; client confirms `view` after 500ms visibility.
- Target latency p95 150ms (ranking 300 candidates with GBDT ~10ms).

## 8. Offline/online evaluation
- Offline: temporal split replay; metrics NDCG, recall@k per source, coverage, novelty, genre entropy.
- Online A/B: `experiments` table + sticky bucketing by user id hash. Primary metric: avg games played >15s per session + D1/D7 retention; guardrails: report rate, crash/skip-fast rate, creator exposure Gini.

## 9. Implementation order (map to roadmap)
R1: heuristic trending + fresh + random (no personalization), events logging everywhere.
R2: content embeddings + user taste vector ANN + MMR rerank.
R3: item-item CF + Bayesian engagement + bandit exploration.
R4: LightGBM ranker, nightly training pipeline (python job in packages/recsys/train/), model artifact versioned in R2.
R5: two-tower (only if data justifies).

## 10. Python or TS?
Serving path in TS (SQL + Redis + small dot products; GBDT exported to ONNX and run via onnxruntime-node). Training scripts in Python (pandas, lightgbm, implicit) under packages/recsys/train, run as scheduled job. Keep the interface: `rank(features[]) -> scores[]`.
