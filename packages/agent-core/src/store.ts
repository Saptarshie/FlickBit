/**
 * The project store: text files with content hashes, in whatever the host offers.
 *
 * Two implementations, one interface. OPFS in a browser; memory in a test. The hash
 * is not decoration — every mutation carries the hash the agent believed the file had,
 * so a patch written against a stale read is rejected instead of applied to the wrong
 * text. That is the whole difference between "the agent edited the game" and "the agent
 * quietly destroyed a function it never saw".
 */

export type ProjectFile = {
  path: string;
  bytes: number;
  /** sha-256 of the file's UTF-8 bytes, first 16 hex chars. */
  hash: string;
};

export type WriteResult = { path: string; hash: string; bytes: number };

export interface ProjectStore {
  list(): Promise<ProjectFile[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<WriteResult>;
  remove(path: string): Promise<void>;
  hash(path: string): Promise<string | null>;
}

/** Paths are relative, forward-slashed, and cannot leave the project root. */
export function normalizePath(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (cleaned.length === 0) throw new Error('empty path');
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) throw new Error(`absolute path rejected: ${path}`);
  const parts: string[] = [];
  for (const part of cleaned.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new Error(`path escapes the project: ${path}`);
    parts.push(part);
  }
  if (parts.length === 0) throw new Error('empty path');
  return parts.join('/');
}

/** Directories the agent never needs to read, and would waste a whole turn listing. */
export const IGNORED_DIRS = ['node_modules', 'dist', 'build', '.git', '.next', 'coverage'];

export function isIgnored(path: string): boolean {
  return path.split('/').some((part) => IGNORED_DIRS.includes(part));
}

/** sha-256 → 16 hex chars. Same algorithm in the browser and in Node. */
export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/** Map-backed store. Used by tests and by the "no OPFS" fallback path. */
export class MemoryProjectStore implements ProjectStore {
  private files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(normalizePath(path), content);
  }

  async list(): Promise<ProjectFile[]> {
    const out: ProjectFile[] = [];
    for (const [path, content] of this.files) {
      if (isIgnored(path)) continue;
      out.push({ path, bytes: new TextEncoder().encode(content).length, hash: await contentHash(content) });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(normalizePath(path)) ?? null;
  }

  async write(path: string, content: string): Promise<WriteResult> {
    const key = normalizePath(path);
    this.files.set(key, content);
    return { path: key, hash: await contentHash(content), bytes: new TextEncoder().encode(content).length };
  }

  async remove(path: string): Promise<void> {
    this.files.delete(normalizePath(path));
  }

  async hash(path: string): Promise<string | null> {
    const content = await this.read(path);
    return content === null ? null : contentHash(content);
  }
}

/**
 * OPFS store. Flat-ish: the project is a directory tree under `root/project`.
 *
 * Written against the standard File System Access API, so it works in a Worker and
 * in the main thread; no Node fallback, because the point is the browser.
 */
export class OpfsProjectStore implements ProjectStore {
  constructor(private readonly root: string = 'project') {}

  private async dir(create: boolean): Promise<FileSystemDirectoryHandle> {
    const origin = await navigator.storage.getDirectory();
    return origin.getDirectoryHandle(this.root, { create });
  }

  private async dirFor(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = normalizePath(path).split('/');
    const name = parts.pop() as string;
    let dir = await this.dir(create);
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name };
  }

  async list(): Promise<ProjectFile[]> {
    const out: ProjectFile[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (isIgnored(path)) continue;
        if (handle.kind === 'directory') {
          await walk(handle as FileSystemDirectoryHandle, path);
        } else {
          const file = await (handle as FileSystemFileHandle).getFile();
          out.push({ path, bytes: file.size, hash: await contentHash(await file.text()) });
        }
      }
    };
    await walk(await this.dir(false).catch(() => null as never), '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(path: string): Promise<string | null> {
    try {
      const { dir, name } = await this.dirFor(path, false);
      const handle = await dir.getFileHandle(name);
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async write(path: string, content: string): Promise<WriteResult> {
    const { dir, name } = await this.dirFor(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return { path: normalizePath(path), hash: await contentHash(content), bytes: new TextEncoder().encode(content).length };
  }

  async remove(path: string): Promise<void> {
    try {
      const { dir, name } = await this.dirFor(path, false);
      await dir.removeEntry(name);
    } catch {
      // Already gone: removal is idempotent on purpose.
    }
  }

  async hash(path: string): Promise<string | null> {
    const content = await this.read(path);
    return content === null ? null : contentHash(content);
  }
}
