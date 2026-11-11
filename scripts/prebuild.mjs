#!/usr/bin/env node
/**
 * Refuse to build while the dev stack is running.
 *
 * `next build` and `next dev` share `apps/web/.next`. Building on top of a live
 * dev server corrupts the dev client manifest ("module not found in Client
 * Manifest") and the build itself dies with the misleading
 *   Invariant: no direct app page entry found for /_not-found
 * which is what made `pnpm build` look broken.
 *
 * One cheap port check turns that into a clear, actionable message.
 */
import net from 'node:net';

const PORTS = [
  { port: 3000, name: 'the dev web server (pnpm dev)' },
  { port: 3001, name: 'the artifact worker (pnpm dev)' },
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
  console.error('\n[build] refusing to build while the dev stack is running:');
  for (const entry of busy) console.error(`  - :${entry.port} is ${entry.name}`);
  console.error(
    '\n  `next build` and `next dev` both write apps/web/.next. Stop the dev server,\n' +
      '  run `pnpm build`, then start `pnpm dev` again.\n',
  );
  process.exit(1);
}

console.log('[build] no dev server detected — building clean.');
