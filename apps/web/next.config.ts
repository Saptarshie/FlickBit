import type { NextConfig } from 'next';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Load the monorepo-root .env into process.env.
 *
 * Next only auto-loads .env files from the app directory (apps/web), but this
 * repo keeps a single root .env shared by web, play-worker and the db scripts.
 * Loading it here means server code (and NEXT_PUBLIC_ inlining) sees the same
 * values without duplicating the file. Existing env vars always win.
 */
function loadRootEnv(): void {
  const rootEnv = path.resolve(process.cwd(), '../../.env');
  if (!existsSync(rootEnv)) return;
  for (const rawLine of readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadRootEnv();

const config: NextConfig = {
  transpilePackages: ['@playloop/sdk', '@playloop/gamekit', '@playloop/db', '@playloop/recsys', '@playloop/ai'],
  // Keep Node-only DB/native-ish deps out of the server bundle.
  serverExternalPackages: ['postgres', 'nodemailer'],
};

export default config;
