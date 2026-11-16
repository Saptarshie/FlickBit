import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Mode B prototype: the browser never sees a provider key.
 *
 * The agent in the Worker calls `http://localhost:5199/api/llm/chat/completions`;
 * this middleware adds the Authorization header from the repo's .env and streams the
 * provider response straight back. If this shape works, the production proxy is the
 * same twenty lines behind an auth check and a quota.
 */
function llmProxy(): Plugin {
  return {
    name: 'spike-llm-proxy',
    configureServer(server) {
      const envPath = path.resolve(process.cwd(), '../../.env');
      const env = Object.fromEntries(
        readFileSync(envPath, 'utf8')
          .split('\n')
          .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
          .map((line) => {
            const at = line.indexOf('=');
            return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, '')];
          }),
      );
      const base = String(env['LLM_BASE_URL'] ?? '').replace(/\/$/, '');
      const key = String(env['LLM_API_KEY'] ?? '');
      if (!base || !key) throw new Error('LLM_BASE_URL / LLM_API_KEY missing from .env');

      server.middlewares.use('/api/llm', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);

        const upstream = await fetch(`${base}${req.url ?? '/chat/completions'}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: Buffer.concat(chunks),
        });

        res.statusCode = upstream.status;
        res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
        res.setHeader('cache-control', 'no-store');
        if (!upstream.body) {
          res.end(await upstream.text());
          return;
        }
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        res.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [llmProxy()],
  worker: { format: 'es' },
  server: { port: 5199, strictPort: true },
});
