import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { providerFromEnv } from './src/openai-provider';
import { runGenerationPipeline } from './src/pipeline';

/**
 * Seed-game generator.
 *
 *   npx tsx packages/ai/seed-game.ts <slug> "<prompt>"
 *
 * Writes .artifacts/seeds/<slug>.html + <slug>.json. Publishing is a separate
 * step (scripts/publish-seeds.ts) so a slow/failed run never half-publishes.
 */
const [, , slug, prompt] = process.argv;
if (!slug || !prompt) {
  console.error('usage: tsx seed-game.ts <slug> "<prompt>"');
  process.exit(2);
}

const outDir = '.artifacts/seeds';
mkdirSync(outDir, { recursive: true });
const started = Date.now();
const log = (line: string) => console.log(`[${slug}] ${Math.round((Date.now() - started) / 1000)}s ${line}`);

const provider = providerFromEnv();
if (!provider) {
  console.error('LLM not configured (LLM_BASE_URL/LLM_API_KEY/LLM_MODEL)');
  process.exit(3);
}

const result = await runGenerationPipeline(
  {
    prompt,
    onProgress: (p) => log(`${p.stage}: ${p.message}`),
  },
  provider,
);

writeFileSync(`${outDir}/${slug}.html`, result.code, 'utf8');
writeFileSync(
  `${outDir}/${slug}.json`,
  JSON.stringify(
    {
      slug,
      prompt,
      sha256: result.sha256,
      bytes: result.bytes,
      title: result.metadata.title,
      description: result.metadata.description,
      tags: result.metadata.tags,
      repairs: result.repairsCount,
      seconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2,
  ),
  'utf8',
);
log(`done: ${result.metadata.title} (${result.bytes} bytes, ${result.repairsCount} repairs)`);
