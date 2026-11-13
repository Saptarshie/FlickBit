/**
 * Playtest sweep over every published artifact.
 *
 *   npx tsx scripts/probe-playtest.ts            # all games
 *   npx tsx scripts/probe-playtest.ts --limit 5  # first five
 *
 * Fetches each artifact from the play origin exactly as the feed does (worker
 * routes, shim injection), plays it, and prints one line per game. Exit code is
 * non-zero when any game fails a hard gate (frozen, throws, restart broken).
 */
import { playtest } from '@playloop/gamekit/playtest';

const PLAY = process.env.PLAY_ORIGIN ?? 'http://localhost:3001';
const WEB = process.env.APP_ORIGIN ?? 'http://localhost:3000';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const limit = Number.parseInt(arg('limit') ?? '50', 10) || 50;
  const feed = await (await fetch(`${WEB}/api/feed?limit=${limit}`)).json();
  const items: Array<{ title: string; artifactUrl: string }> = feed?.data?.items ?? feed?.items ?? [];
  if (items.length === 0) {
    console.error('[playtest] feed returned no games — is the stack up?');
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  console.log(`${'game'.padEnd(30)}${'ready'.padEnd(7)}${'changes'.padEnd(9)}${'score'.padEnd(8)}${'over'.padEnd(6)}verdict`);
  console.log('-'.repeat(78));

  for (const item of items.slice(0, limit)) {
    const sha = item.artifactUrl.split('/v/')[1] ?? '';
    const html = await (await fetch(`${PLAY}/v/${sha}`)).text();
    const report = await playtest(html, { taps: 16 });
    if (!report.pass) failed += 1;
    const score = `${report.scoreStart ?? '-'}→${report.scoreEnd ?? report.finalScore ?? '-'}`;
    console.log(
      `${item.title.slice(0, 29).padEnd(30)}${(report.ready ? 'yes' : 'NO').padEnd(7)}${String(report.changes).padEnd(9)}${score.padEnd(8)}${(report.gameOverSeen ? (report.restartWorked ? 'restart' : 'TRAP') : '-').padEnd(6)}${report.defects[0] ?? 'plays'}`,
    );
  }

  console.log(`\n${items.length - failed}/${Math.min(items.length, limit)} play cleanly`);
  if (failed > 0) process.exitCode = 1;
}

void main();
