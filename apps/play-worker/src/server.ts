import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app';

const port = Number.parseInt(process.env.PORT ?? '', 10) || 3001;
const artifactsDir = path.resolve(process.env.ARTIFACTS_DIR ?? path.join(process.cwd(), 'artifacts'));

mkdirSync(artifactsDir, { recursive: true });

const app = createApp({ artifactsDir });
app.listen(port, () => {
  console.log(`play-worker listening on http://localhost:${port} (artifacts: ${artifactsDir})`);
});
