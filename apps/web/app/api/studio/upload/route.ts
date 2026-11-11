import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auth } from '../../../../auth';
import { artifactsDir } from '@/lib/artifacts';

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
export async function POST(req: Request) {
  const session = (await auth()) as { user?: { id?: string } | null } | null;
  if (!session?.user?.id) {
    return Response.json({ error: { code: 'unauthorized', message: 'Sign in to upload a reference' } }, { status: 401 });
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

  const key = `${randomUUID()}.${ext}`;
  const dir = path.join(artifactsDir(), '..', 'uploads');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, key), Buffer.from(await file.arrayBuffer()));

  return Response.json({ data: { key, bytes: file.size, type: file.type } });
}
