import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { providerFromEnv, runGenerationPipeline } from './src/index';

const provider = providerFromEnv();
console.log('provider:', provider ? provider.constructor.name : 'NONE (would fall back to mock)');
if (!provider) process.exit(1);

const t0 = Date.now();
const result = await runGenerationPipeline(
  {
    prompt: 'a cozy match-3 puzzle with glowing gems and a calm vibe',
    onProgress: (p) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${p.stage}: ${p.message}`),
  },
  provider,
);
console.log('---- result ----');
console.log('title:', result.title, '| tags:', result.tags.join(','));
console.log('bytes:', result.code.length, '| sha:', result.sha256.slice(0, 12));
console.log('validation:', JSON.stringify(result.validation).slice(0, 300));
writeFileSync('.artifacts/probe.html', result.code);
