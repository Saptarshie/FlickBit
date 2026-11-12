import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactsDir } from '@/lib/artifacts';
import { enforceRateLimit, jsonError } from '@/lib/api-helpers';
import { resolveViewer, SESSION_STALE } from '@/lib/session';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Concept image upload.
 *
 * The image is a *reference* for the art director and coder (palette, mood,
 * subject), so it is stored next to the artifacts and referenced by a random
 * key — never by a user-supplied filename. 4 MB cap, image mime types only.
 */
/** Magic-byte prefixes: a client-declared `file.type` is not evidence. */
function sniffMagic(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export async function POST(req: Request) {
  const viewer = await resolveViewer();
  if (viewer.kind === 'anonymous') {
    return Response.json({ error: { code: 'unauthorized', message: 'Sign in to upload a reference' } }, { status: 401 });
  }
  if (viewer.kind === 'stale') return Response.json({ error: SESSION_STALE }, { status: 401 });
  try {
    enforceRateLimit(viewer.userId, 'upload', 20, 60 * 60_000, 'uploads');
  } catch (limited) {
    if (limited instanceof Response) return limited;
    throw limited;
  }

  // `formData()` buffers the whole body before any size check, and a route
  // handler has no body cap of its own — refuse an oversized upload up front.
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES + 64 * 1024) {
    return jsonError('payload_too_large', 'That image is larger than 4 MB', 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: { code: 'bad_request', message: 'Expected multipart/form-data' } }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: { code: 'validation_error', message: 'Attach an image as "file"' } }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: { code: 'too_large', message: 'Images are limited to 4 MB' } }, { status: 413 });
  }

  const ext = ALLOWED[file.type];
  if (!ext) {
    return Response.json(
      { error: { code: 'unsupported_type', message: 'Use a PNG, JPEG, WebP or GIF image' } },
      { status: 415 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffMagic(bytes);
  if (!sniffed) {
    return Response.json(
      { error: { code: 'unsupported_type', message: 'That file is not a PNG, JPEG, WebP or GIF image' } },
      { status: 415 },
    );
  }

  const key = `${randomUUID()}.${ALLOWED[sniffed] ?? ext}`;
  const dir = path.join(artifactsDir(), '..', 'uploads');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, key), bytes);
  } catch (err) {
    console.error('[upload] could not store the reference:', err instanceof Error ? err.message : err);
    return jsonError('storage_unavailable', 'Could not store that image right now — try again.', 507);
  }

  return Response.json({ data: { key, bytes: bytes.length, type: sniffed } });
}
