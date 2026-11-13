/**
 * Audio path of the compressor.
 *
 * Opus in an Ogg container at 48–64 kbps is the smallest thing every mobile
 * browser decodes for short effects. FFmpeg does the encoding; when it is not
 * installed the ingest reports a skip rather than failing a build (sprites still
 * work, and a game can synthesise its own sound with WebAudio).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assetFileName, sha256 } from './registry';

const run = promisify(execFile);

/**
 * Ogg pages carry a random stream serial, so two encodes of identical audio are
 * different bytes — and a content-addressed URL would change on every ingest.
 * Rewriting the serial to zero keeps the container valid only if the page CRC is
 * recomputed, which is what this does (table-driven, same polynomial libogg uses).
 */
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) {
      r = (r & 0x80000000) !== 0 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(bytes: Buffer, from: number, to: number): number {
  let crc = 0;
  for (let i = from; i < to; i += 1) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ (bytes[i] ?? 0)) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

export function steadyOggSerial(input: Buffer): Buffer {
  const out = Buffer.from(input);
  let offset = 0;
  while (offset + 27 <= out.length && out.toString('latin1', offset, offset + 4) === 'OggS') {
    const segments = out[offset + 26] ?? 0;
    const tableStart = offset + 27;
    let bodyLength = 0;
    for (let i = 0; i < segments; i += 1) bodyLength += out[tableStart + i] ?? 0;
    const pageEnd = tableStart + segments + bodyLength;
    if (pageEnd > out.length) break;
    out.writeUInt32LE(0, offset + 14); // serial
    out.writeUInt32LE(0, offset + 22); // crc placeholder
    out.writeUInt32LE(oggCrc(out, offset, pageEnd), offset + 22);
    offset = pageEnd;
  }
  return out;
}

export type OptimizedAudio = {
  data: Buffer;
  ext: 'ogg';
  bytes: number;
  sha256: string;
  file: string;
  inlineBytes: number;
  durationMs: number;
};

/** Where ffmpeg is, or null. Honours FFMPEG_PATH for hosts that ship it out of PATH. */
export function ffmpegPath(): string | null {
  return process.env.FFMPEG_PATH ?? 'ffmpeg';
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    await run(ffmpegPath() as string, ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode any FFmpeg-readable audio into Ogg/Opus.
 *
 * 48 kbps mono is the default because a 0.3 s UI blip does not need more, and a
 * 60 s music loop at 48 kbps is ~352 KB — which is a meaningful slice of a 1 MB
 * card, so callers should pass a lower bitrate for long material.
 */
export async function optimizeAudio(
  input: Buffer,
  options: { bitrateKbps?: number; durationHintMs?: number } = {},
): Promise<OptimizedAudio> {
  const bitrate = options.bitrateKbps ?? 48;
  const dir = await mkdtemp(path.join(tmpdir(), 'pl-audio-'));
  const src = path.join(dir, 'in');
  const out = path.join(dir, 'out.ogg');
  try {
    await writeFile(src, input);
    await run(
      ffmpegPath() as string,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        // bitexact: without it the Ogg muxer writes a random stream serial, so the
        // same input encodes to different bytes and content-addressing breaks
        // (every ingest would write a new "version" of an identical sound).
        '-fflags',
        '+bitexact',
        '-flags:a',
        '+bitexact',
        '-i',
        src,
        '-c:a',
        'libopus',
        '-b:a',
        `${bitrate}k`,
        '-ac',
        '1',
        '-map_metadata',
        '-1',
        // ...and the Ogg stream serial itself is still random per run.
        '-serial_offset',
        '0',
        out,
      ],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const data = steadyOggSerial(await readFile(out));
    const sha = sha256(data);
    return {
      data,
      ext: 'ogg',
      bytes: data.byteLength,
      sha256: sha,
      file: assetFileName(sha, 'ogg'),
      inlineBytes: Math.ceil((data.byteLength * 4) / 3) + 32,
      durationMs: options.durationHintMs ?? 0,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
