import path from 'node:path';

/**
 * Where game artifacts live.
 *
 * `.env` sets `ARTIFACTS_DIR=./apps/play-worker/artifacts`, which is relative to
 * the REPO ROOT, while Next runs with cwd = `apps/web`. Resolving it against
 * cwd produced `apps/web/apps/play-worker/artifacts`, so every artifact lookup
 * outside the studio 404'd (remix was silently broken). Always resolve through
 * this helper.
 */
export function repoRoot(): string {
  return path.resolve(process.cwd(), '../..');
}

export function artifactsDir(): string {
  const configured = process.env.ARTIFACTS_DIR;
  if (configured) return path.resolve(repoRoot(), configured);
  return path.resolve(repoRoot(), 'apps/play-worker/artifacts');
}

export function artifactPath(sha256: string): string {
  return path.join(artifactsDir(), `${sha256}.html`);
}
