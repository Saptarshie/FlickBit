/**
 * Ambient typings for the slice of Node used by the smoke runner and its CLI.
 * The package ships no @types/node; node-shims.d.ts already covers node:fs's
 * readFileSync. Function declarations in ambient module blocks merge as
 * overloads, so the node:fs block below only adds the missing members.
 */
declare module 'node:fs' {
  export function writeFileSync(path: string | URL, data: string | Uint8Array): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:http' {
  export interface IncomingMessage {
    url?: string;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(chunk?: string): void;
  }
  export interface Server {
    listen(port: number, hostname: string, callback: () => void): Server;
    close(callback?: () => void): void;
    closeAllConnections(): void;
    address(): { port: number } | null;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

declare const process: {
  argv: string[];
  exit(code?: number): never;
};

/** The handle the harness page exposes to the runner (see buildHarnessHtml). */
interface Window {
  __pl?: {
    events: {
      readyAt: number | null;
      gameOver: unknown[];
      score: unknown[];
      errors: Array<{ message?: string; code?: string; stack?: string }>;
      perf: unknown[];
      logs: unknown[];
    };
    host?: unknown;
  };
}
