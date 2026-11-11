/**
 * Studio E2E: create, follow up, verify the session is stateful.
 *
 *   node scripts/e2e-studio.mjs [--base http://localhost:3000]
 *
 * Uses the real HTTP surface (Auth.js credentials -> SSE -> thread API), so it
 * exercises the same path a phone does. Takes several minutes: each turn runs
 * planner + art director + coder + runtime gate + QA.
 */
const args = process.argv.slice(2);
const baseFlag = args.indexOf('--base');
const BASE = baseFlag >= 0 ? args[baseFlag + 1] : 'http://localhost:3000';
const HANDLE = process.env.E2E_HANDLE ?? 'saptarshi';
const PASSWORD = process.env.E2E_PASSWORD ?? 'playloop-demo-1';

const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function captureCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function signIn() {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  await captureCookies(csrfRes);
  const { csrfToken } = await csrfRes.json();

  const res = await fetch(`${BASE}/api/auth/callback/handle`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
    body: new URLSearchParams({ csrfToken, handle: HANDLE, password: PASSWORD, json: 'true' }),
  });
  await captureCookies(res);

  const me = await fetch(`${BASE}/api/me`, { headers: { cookie: cookieHeader() } });
  const body = await me.json();
  if (!body?.data?.viewer) throw new Error('sign-in failed — wrong handle/password');
  console.log(`[e2e] signed in as @${body.data.viewer.handle}`);
}

async function turn(prompt, gameId) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/studio/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader(), accept: 'text/event-stream' },
    body: JSON.stringify({ prompt, gameId }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`generate failed: ${res.status} ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let complete = null;
  let lastStage = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const data = block.match(/^data:\s*(.+)$/m)?.[1]?.trim();
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === 'progress' && payload.stage !== lastStage) {
        lastStage = payload.stage;
        console.log(`[e2e]   ${payload.stage}: ${payload.message}`);
      }
      if (event === 'complete') complete = payload;
      if (event === 'error') throw new Error(payload.message);
    }
  }

  if (!complete) throw new Error('stream ended without a complete event');
  console.log(
    `[e2e] turn done in ${Math.round((Date.now() - started) / 1000)}s: "${complete.metadata.title}" v${complete.versionNo} ` +
      `smoke=${complete.smoke ? (complete.smoke.pass ? 'pass' : 'FAIL') : 'n/a'} ` +
      `review=${complete.review?.verdict ?? 'n/a'} repairs=${complete.repairs}`,
  );
  return complete;
}

async function thread(gameId) {
  const res = await fetch(`${BASE}/api/studio/thread?gameId=${gameId}`, { headers: { cookie: cookieHeader() } });
  if (!res.ok) throw new Error(`thread failed: ${res.status}`);
  return res.json();
}

async function main() {
  await signIn();

  const first = await turn('a tiny neon reflex game: tap to make a ball jump over closing walls');
  const gameId = first.gameId;

  const second = await turn('make the ball bigger and add a shield pickup that absorbs one hit', gameId);

  const state = await thread(gameId);
  const messages = state.data.messages ?? [];
  const versions = state.data.versions ?? [];

  console.log(`[e2e] thread: ${messages.length} messages, ${versions.length} versions`);
  for (const m of messages) console.log(`[e2e]   ${m.role}: ${String(m.content).slice(0, 80)}`);

  const problems = [];
  if (state.data.game.id !== gameId) problems.push('thread returned a different game');
  if (messages.filter((m) => m.role === 'user').length !== 2) problems.push('expected 2 user turns');
  if (messages.filter((m) => m.role === 'assistant').length !== 2) problems.push('expected 2 assistant replies');
  if (versions.length < 2) problems.push('expected at least 2 versions');
  if (second.versionNo !== 2) problems.push(`follow-up should be v2, got v${second.versionNo}`);
  if (!second.smoke?.pass) problems.push('follow-up failed the runtime gate');

  if (problems.length) {
    console.error('[e2e] FAIL:', problems.join('; '));
    process.exitCode = 1;
  } else {
    console.log('[e2e] PASS — sessions are stateful and versioned');
  }
}

main().catch((err) => {
  console.error('[e2e] error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
