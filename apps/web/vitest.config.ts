import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      // next@15 ships no "exports" map, so Node ESM cannot resolve the
      // extension-less `next/server` used by next-auth; point it at the file.
      { find: /^next\/server$/, replacement: 'next/server.js' },
      { find: /^@\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
    ],
  },
  test: {
    server: {
      deps: {
        // next-auth is ESM that imports extension-less `next/server`; inline it
        // so Vite resolves/aliases its imports instead of Node's native loader.
        inline: ['next-auth', '@auth/core', '@auth/pg-adapter'],
      },
    },
  },
});
