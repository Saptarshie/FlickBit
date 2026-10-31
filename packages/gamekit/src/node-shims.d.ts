/**
 * Minimal ambient typings so this package type-checks without @types/node.
 * Only the tiny slice of node:fs used by src/index.ts is declared.
 */
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}
