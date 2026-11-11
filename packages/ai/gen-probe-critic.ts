/**
 * TEMPORARY critic probe — not part of the product. Runs the real generation
 * pipeline once against the configured LLM and dumps artifacts + a log.
 */
import 'dotenv/config';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateGame } from '@playloop/gamekit';
import { providerFromEnv } from './src/openai-provider';
import { runGenerationPipeline } from './src/pipeline';

const ROOT = resolve(import.meta.dirname, '../..');
const LOG = resolve(ROOT, '.artifacts/critic-gen.log');
const OUT = resolve(ROOT, '.artifacts/critic-game.html');

const PROMPT =
  'Neon cyberpunk hoverbike runner: hold to accelerate, swipe up to jump broken rails, ' +
  'swipe down to duck under laser gates, collect glowing data chips. Speed ramps up, ' +
  'near-misses trigger a slow-motion flash. Dark city skyline, hot magenta and cyan.';

const t0 = Date.now();
function log(line: string) {
  const stamped = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`;
  console.log(stamped);
  appendFileSync(LOG, stamped + '\n');
}

mkdirSync(dirname(LOG), { recursive: true });
writeFileSync(LOG, '');

const provider = providerFromEnv();
if (!provider) {
  log('FATAL: LLM_* env not configured');
  process.exit(1);
}
log(`model=${(provider as { model?: string }).model ?? 'unknown'}`);
log(`prompt=${PROMPT}`);

try {
  const game = await runGenerationPipeline(
    {
      prompt: PROMPT,
      onProgress: (p) => log(`stage=${p.stage} ${p.progressPercent}% ${p.message}`),
    },
    provider
  );

  writeFileSync(OUT, game.code, 'utf8');
  const report = validateGame(game.code);
  log(`bytes=${game.bytes} sha256=${game.sha256}`);
  log(`repairs=${game.repairsCount}`);
  log(`spec=${JSON.stringify(game.spec)}`);
  log(`metadata=${JSON.stringify(game.metadata)}`);
  log(`validate.errors=${JSON.stringify(report.errors)}`);
  log(`validate.warnings=${JSON.stringify((report as { warnings?: unknown }).warnings ?? [])}`);
  log(`script tags=${(game.code.match(/<script/gi) || []).length} canvas=${/<canvas/i.test(game.code)}`);
  log('DONE');
} catch (err) {
  log(`FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
}
