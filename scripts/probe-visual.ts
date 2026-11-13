/**
 * Visual sweep: look at every published game the way a player does.
 *
 *   npx tsx scripts/probe-visual.ts                 # all games in the feed
 *   npx tsx scripts/probe-visual.ts --limit 5
 *   npx tsx scripts/probe-visual.ts --title "Neon Dead Highway"
 *
 * Captures the opening screen, a mid-run frame and the end state, sends them to
 * the multimodal reviewer, and prints the score plus the worst issue. Exit code
 * is non-zero when any game has a critical finding — the same bar the pipeline
 * now applies before publishing.
 */
import 'dotenv/config';
import { captureFrames } from '@playloop/gamekit/capture';
import { providerFromEnv } from '@playloop/ai';
import { reviewVisual } from '@playloop/ai';

const WEB = process.env.APP_ORIGIN ?? 'http://localhost:3000';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const limit = Number.parseInt(arg('limit') ?? '30', 10) || 30;
  const only = arg('title');
  const feed = await (await fetch(`${WEB}/api/feed?limit=${limit}`)).json();
  let items: Array<{ title: string; description: string; artifactUrl: string }> = feed?.data?.items ?? [];
  if (only) items = items.filter((g) => g.title === only);
  if (items.length === 0) {
    console.error('[visual] no games matched');
    process.exitCode = 1;
    return;
  }

  const provider = providerFromEnv();
  if (!provider) throw new Error('LLM provider is not configured');

  console.log(`${'game'.padEnd(28)}${'score'.padEnd(8)}${'verdict'.padEnd(9)}worst issue`);
  console.log('-'.repeat(96));

  let critical = 0;
  for (const game of items) {
    const html = await (await fetch(game.artifactUrl)).text();
    const shots = await captureFrames(html, { taps: 8 });
    const review = await reviewVisual({
      shots,
      spec: {
        title: game.title,
        concept: game.description,
        genre: 'arcade',
        templateId: 'tap-runner',
        coreMechanic: game.description,
        controls: 'tap',
        palette: [],
        loseCondition: 'n/a',
      },
      description: game.description,
      provider,
    });
    if (!review) {
      console.log(`${game.title.slice(0, 27).padEnd(28)}${'-'.padEnd(8)}${'skipped'.padEnd(9)}review unavailable`);
      continue;
    }
    const worst = review.issues.find((i) => i.severity === 'critical') ?? review.issues[0];
    if (review.issues.some((i) => i.severity === 'critical')) critical += 1;
    console.log(
      `${game.title.slice(0, 27).padEnd(28)}${String(review.score).padEnd(8)}${review.verdict.padEnd(9)}${(worst?.issue ?? review.summary).slice(0, 60)}`,
    );
  }

  console.log(`\n${items.length - critical}/${items.length} with no critical visual finding`);
  if (critical > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
