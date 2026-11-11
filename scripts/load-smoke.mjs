#!/usr/bin/env node
// Concurrency smoke: hammer the feed + a couple of read APIs and report
// status codes and latency percentiles. Catches a wedged dev database.
const url = process.argv[2] ?? 'http://localhost:3000';
const paths = ['/api/feed', '/api/feed?limit=5', '/api/search?q=snake', '/api/me'];
const N = Number(process.argv[3] ?? 24);

async function once(path) {
  const t0 = Date.now();
  try {
    const res = await fetch(url + path, { signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    return { path, status: res.status, ms: Date.now() - t0, bytes: body.length };
  } catch (e) {
    return { path, status: 0, ms: Date.now() - t0, bytes: 0, error: String(e).slice(0, 60) };
  }
}

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => once(paths[i % paths.length])));
const wall = Date.now() - t0;
const times = results.map((r) => r.ms).sort((a, b) => a - b);
const bad = results.filter((r) => r.status !== 200);
const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];

console.log(`requests=${N} wall=${wall}ms p50=${pct(50)}ms p95=${pct(95)}ms max=${times.at(-1)}ms`);
console.log(`non-200=${bad.length}`, bad.slice(0, 5).map((b) => `${b.path}:${b.status}${b.error ? ' ' + b.error : ''}`).join(' '));
const after = await once('/api/feed');
console.log(`after-load /api/feed -> ${after.status} ${after.ms}ms`);
process.exit(bad.length === 0 && after.status === 200 ? 0 : 1);
