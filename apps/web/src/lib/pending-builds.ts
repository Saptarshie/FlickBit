import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactsDir } from '@/lib/artifacts';

/**
 * A finished build whose database write failed.
 *
 * Generation costs minutes and the artifact is already on disk, so a transient
 * database problem must not throw it away. The marker keeps exactly what the
 * publish step needs; `POST /api/studio/publish` reads it back and finishes the
 * job without regenerating anything.
 */
export type PendingBuild = {
  sha256: string;
  bytes: number;
  code?: string;
  metadata: { title: string; description: string; tags: string[] };
  spec?: unknown;
  gameId?: string | null;
  forkedFromId?: string | null;
  creatorId: string;
  createdAt: number;
};

const pendingDir = () => path.join(artifactsDir(), '..', 'pending');

/** Only the shape we need is persisted; the HTML stays in the artifact store. */
export async function savePendingBuild(
  build: { sha256: string; bytes: number; metadata: PendingBuild['metadata']; spec?: unknown },
  meta: { gameId?: string | null; forkedFromId?: string | null; creatorId: string },
): Promise<void> {
  const dir = pendingDir();
  await mkdir(dir, { recursive: true });
  const record: PendingBuild = {
    sha256: build.sha256,
    bytes: build.bytes,
    metadata: build.metadata,
    spec: build.spec,
    gameId: meta.gameId ?? null,
    forkedFromId: meta.forkedFromId ?? null,
    creatorId: meta.creatorId,
    createdAt: Date.now(),
  };
  await writeFile(path.join(dir, `${build.sha256}.json`), JSON.stringify(record), 'utf8');
}

export async function readPendingBuild(sha256: string): Promise<PendingBuild | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  try {
    const raw = await readFile(path.join(pendingDir(), `${sha256}.json`), 'utf8');
    return JSON.parse(raw) as PendingBuild;
  } catch {
    return null;
  }
}

export async function clearPendingBuild(sha256: string): Promise<void> {
  await rm(path.join(pendingDir(), `${sha256}.json`), { force: true });
}
