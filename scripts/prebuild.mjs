#!/usr/bin/env node
/**
 * Guard rails before `turbo run build`.
 *
 * `next dev` writes `.next-dev` and `next build` writes `.next`
 * (apps/web/next.config.ts), so the two can run at the same time. This script
 * only reports the state so the output is not confusing — it never blocks a
 * build, because blocking was what made `pnpm build` look broken.
 */
import net from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORTS = [
  { port: 3000, name: 'dev web server (pnpm dev)' },
  { port: 3001, name: 'artifact worker (pnpm dev)' },
];

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const busy = [];
for (const entry of PORTS) {
  if (await isListening(entry.port)) busy.push(entry);
}
if (busy.length > 0) {
  console.log('[build] dev stack is running — production build goes to apps/web/.next, dev keeps .next-dev.');
  for (const entry of busy) console.log(`  - :${entry.port} ${entry.name}`);
} else {
  console.log('[build] no dev server detected — building clean.');
}

// A previous production build left behind is fine; Next replaces it.
const outDir = path.join(root, 'apps', 'web', '.next');
if (existsSync(path.join(outDir, 'BUILD_ID'))) {
  console.log('[build] replacing the existing production build in apps/web/.next');
}
