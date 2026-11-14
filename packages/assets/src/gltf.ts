/**
 * Make a .glb self-contained by inlining the files it references.
 *
 * Kenney's newer kits ship palette-textured models: every .glb points at
 * `Textures/colormap.png`, a shared atlas sitting next to the model. Loaded in a
 * browser that file is requested as `/a/Textures/colormap.png` — a path the platform
 * does not publish, and one that would collide across packs anyway (each kit has its
 * own palette).
 *
 * So the asset pipeline rewrites the container instead of the model: external images
 * and buffers are appended to the binary chunk as bufferViews and referenced by
 * index. Same geometry, same materials, one file, no runtime dependency.
 *
 * A GLB is: 12-byte header, then chunks of (length, type, data). JSON chunk first,
 * BIN second. Padding is 4-byte aligned (JSON with spaces, BIN with zeros).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

type GltfJson = {
  buffers?: Array<{ uri?: string; byteLength: number }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string }>;
};

export function isGlb(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.readUInt32LE(0) === MAGIC;
}

/** Paths a .glb would ask for at load time. Empty means it is already self-contained. */
export function externalUris(bytes: Buffer): string[] {
  const gltf = readJsonChunk(bytes);
  if (!gltf) return [];
  const uris = [...(gltf.images ?? []), ...(gltf.buffers ?? [])]
    .map((entry) => entry.uri)
    .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0 && !uri.startsWith('data:'));
  return [...new Set(uris)];
}

function readJsonChunk(bytes: Buffer): GltfJson | null {
  try {
    const jsonLength = bytes.readUInt32LE(12);
    const type = bytes.readUInt32LE(16);
    if (type !== CHUNK_JSON) return null;
    return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as GltfJson;
  } catch {
    return null;
  }
}

export type InlineResult = {
  data: Buffer;
  inlined: string[];
  missing: string[];
};

/**
 * Inline every external uri the model references.
 *
 * `baseDir` is where the .glb lives: a uri is resolved relative to it, which is how
 * a glTF loader resolves it too. Unresolvable references are reported, not invented —
 * the caller decides whether to publish the model anyway.
 */
export async function inlineGltfAssets(bytes: Buffer, baseDir: string): Promise<InlineResult> {
  if (!isGlb(bytes)) return { data: bytes, inlined: [], missing: [] };

  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.readUInt32LE(16);
  if (jsonType !== CHUNK_JSON) return { data: bytes, inlined: [], missing: [] };

  let gltf: GltfJson;
  try {
    gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as GltfJson;
  } catch {
    return { data: bytes, inlined: [], missing: [] };
  }

  const binOffset = 20 + jsonLength;
  const binLength = binOffset + 8 <= bytes.length ? bytes.readUInt32LE(binOffset) : 0;
  const binType = binOffset + 8 <= bytes.length ? bytes.readUInt32LE(binOffset + 4) : 0;
  const bin = binType === CHUNK_BIN && binLength > 0 ? bytes.subarray(binOffset + 8, binOffset + 8 + binLength) : Buffer.alloc(0);

  const additions: Buffer[] = [];
  let appended = 0;
  const inlined: string[] = [];
  const missing: string[] = [];

  const bufferViews = (gltf.bufferViews ??= []);
  const images = gltf.images ?? [];
  const buffers = gltf.buffers ?? [];

  const pushBytes = (data: Buffer): number => {
    const pad = (4 - (appended % 4)) % 4;
    if (pad > 0) {
      additions.push(Buffer.alloc(pad));
      appended += pad;
    }
    const byteOffset = appended;
    additions.push(data);
    appended += data.length;
    return byteOffset;
  };

  // Images first: the common case (a shared palette atlas).
  for (const image of images) {
    if (typeof image.uri !== 'string' || image.uri.startsWith('data:')) continue;
    const uri = String(image.uri);
    const file = path.resolve(baseDir, decodeURIComponent(uri));
    try {
      const data = await readFile(file);
      const byteOffset = pushBytes(data);
      bufferViews.push({ buffer: 0, byteOffset: bin.length + byteOffset, byteLength: data.length });
      image.bufferView = bufferViews.length - 1;
      image.mimeType = file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream';
      delete image.uri;
      inlined.push(uri);
    } catch {
      missing.push(uri);
    }
  }

  // A second buffer with a uri would need its own GLB slot; report rather than guess.
  for (const buffer of buffers) {
    if (typeof buffer.uri === 'string' && !buffer.uri.startsWith('data:')) missing.push(buffer.uri);
  }

  if (inlined.length === 0 && missing.length === 0) return { data: bytes, inlined, missing };

  const newBin = Buffer.concat([bin, ...additions]);
  const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (newBin.length % 4)) % 4;
  const binPadded = Buffer.concat([newBin, Buffer.alloc(binPad)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.writeUInt32LE(CHUNK_BIN, 4);

  return {
    data: Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]),
    inlined,
    missing,
  };
}
