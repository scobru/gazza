import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import {
  ChunkHeader,
  EncodedChunk,
  ProgressCallback,
  VideoProfile,
  assembleFile,
  chunkFile,
  frameGeometry,
  headerSize,
  parseChunk,
  readFrame,
  renderFrame,
  serializeChunk,
} from '@dbforall/core';

export interface EncodeOptions {
  fileName: string;
  mimeType: string;
  profile: VideoProfile;
  /** x264 quality. Lower is better; the platform will re-encode anyway. */
  crf?: number;
  onProgress?: ProgressCallback;
}

export interface EncodeResult {
  outputPath: string;
  chunks: number;
  frames: number;
  payloadBytes: number;
}

export interface DecodeResult {
  data: Uint8Array;
  header: ChunkHeader;
  framesRead: number;
  /** Frames that carried no readable chunk: transitions, blends, dropped frames. */
  framesRejected: number;
}

/** Payload bytes each chunk may carry once its own header is in the frame. */
export function payloadSizeFor(profile: VideoProfile, fileName: string, mimeType: string): number {
  const capacity = frameGeometry(profile).capacityBytes;
  const overhead = headerSize({ fileName, mimeType, parityMembers: undefined });
  const payloadSize = capacity - overhead;
  if (payloadSize <= 0) {
    throw new Error(`Frame holds ${capacity} B, the chunk header alone needs ${overhead} B`);
  }
  return payloadSize;
}

function write(stream: Writable, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

function ffmpeg(args: string[]) {
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', (err) =>
      reject(new Error(`Could not run ffmpeg (${err.message}). Is it installed and on PATH?`))
    );
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${stderr}`))
    );
  });
  return { proc, done, stderr: () => stderr };
}

/** File bytes -> a video carrying one chunk per frame, repeated for redundancy. */
export async function encodeFileToVideo(
  data: Uint8Array,
  outputPath: string,
  options: EncodeOptions
): Promise<EncodeResult> {
  const { fileName, mimeType, profile, crf = 14, onProgress } = options;
  const payloadSize = payloadSizeFor(profile, fileName, mimeType);
  const chunks = await chunkFile(data, { fileName, mimeType, payloadSize });

  const { proc, done } = ffmpeg([
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-s', `${profile.width}x${profile.height}`,
    '-r', String(profile.fps),
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', String(crf),
    // Every frame a keyframe: no inter-frame prediction to smear our cells.
    '-g', '1',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
  proc.stdout.resume();

  let frames = 0;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const pixels = renderFrame(serializeChunk(chunks[i]), profile);
      for (let r = 0; r < profile.repeatFrames; r++) {
        await write(proc.stdin, pixels);
        frames++;
      }
      onProgress?.({ phase: 'encode', completed: i + 1, total: chunks.length });
    }
    proc.stdin.end();
  } catch (err) {
    proc.kill();
    throw err;
  }
  await done;

  return { outputPath, chunks: chunks.length, frames, payloadBytes: data.length };
}

/**
 * Video -> the original file. Every frame is tried independently and the first
 * valid copy of each chunk wins, so a changed frame rate, a dropped frame or a
 * blended transition costs nothing as long as one clean copy survives.
 */
export async function decodeVideoFile(
  inputPath: string,
  profile: VideoProfile,
  onProgress?: ProgressCallback
): Promise<DecodeResult> {
  const frameSize = profile.width * profile.height * 3;
  const { proc, done } = ffmpeg([
    '-i', inputPath,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    // Undo any rescaling the platform applied before sampling the grid.
    '-vf', `scale=${profile.width}:${profile.height}`,
    'pipe:1',
  ]);

  const byIndex = new Map<number, EncodedChunk>();
  let framesRead = 0;
  let framesRejected = 0;

  const pending: Buffer[] = [];
  let pendingBytes = 0;

  const consume = (frame: Buffer) => {
    framesRead++;
    try {
      const chunk = parseChunk(readFrame(frame, profile).bytes);
      if (!byIndex.has(chunk.header.chunkIndex)) {
        byIndex.set(chunk.header.chunkIndex, chunk);
        onProgress?.({
          phase: 'decode',
          completed: byIndex.size,
          total: chunk.header.totalChunks,
        });
      }
    } catch {
      framesRejected++;
    }
  };

  for await (const piece of proc.stdout) {
    pending.push(piece as Buffer);
    pendingBytes += (piece as Buffer).length;
    if (pendingBytes < frameSize) continue;

    let joined = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    pending.length = 0;
    while (joined.length >= frameSize) {
      consume(joined.subarray(0, frameSize));
      joined = joined.subarray(frameSize);
    }
    pending.push(joined);
    pendingBytes = joined.length;
  }
  await done;

  if (byIndex.size === 0) {
    throw new Error(`No readable chunk in ${framesRead} frames. Wrong platform profile?`);
  }

  const chunks = [...byIndex.values()].sort((a, b) => a.header.chunkIndex - b.header.chunkIndex);
  return {
    data: await assembleFile(chunks),
    header: chunks[0].header,
    framesRead,
    framesRejected,
  };
}
