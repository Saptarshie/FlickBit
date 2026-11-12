/**
 * Artifact URL for an <iframe>, tagged with the guest shim version.
 *
 * `/v/<sha>.html` is addressed by the GAME hash, but the response inlines the
 * shim. Anyone who loaded a game before a shim fix would keep the old one from
 * the HTTP cache (it used to be `immutable, max-age=1y`), so the game stayed
 * frozen while the server was already correct. The query tag changes the cache
 * key whenever the shim does.
 */
export function artifactSrc(url: string, shimVersion: string): string {
  if (!url) return url;
  return url.includes('?') ? `${url}&v=${shimVersion}` : `${url}?v=${shimVersion}`;
}
