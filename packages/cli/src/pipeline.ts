import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import {
  ChunkHeader,
  EncodedChunk,
  DEFAULT_PARITY,
  ParityOptions,
  ProgressCallback,
  VideoProfile,
  assembleFile,
  buildParityChunks,
  chunkFile,
  frameGeometry,
  headerSize,
  parseChunk,
  readFrame,
  recoverDataChunks,
  renderFrame,
  serializeChunk,
} from '@dbforall/core';

export interface EncodeOptions {
  fileName: string;
  mimeType: string;
  profile: VideoProfile;
  /** x264 quality. Lower is better; the platform will re-encode anyway. */
  crf?: number;
  /** Erasure coding across chunks. Pass false to ship data chunks only. */
  parity?: ParityOptions | false;
  onProgress?: ProgressCallback;
}

export interface EncodeResult {
  outputPath: string;
  chunks: number;
  parityChunks: number;
  frames: number;
  payloadBytes: number;
}

export interface DecodeResult {
  data: Uint8Array;
  header: ChunkHeader;
  /** Chunk indices rebuilt from parity because no frame carried them. */
  recovered: number[];
  framesRead: number;
  /** Frames that carried no readable chunk: transitions, blends, dropped frames. */
  framesRejected: number;
}

/**
 * Payload bytes each chunk may carry once its own header is in the frame.
 * Sized for the widest header, the one on a parity chunk: it lists every data
 * chunk it protects, and every chunk has to fit the same frame.
 */
export function payloadSizeFor(
  profile: VideoProfile,
  fileName: string,
  mimeType: string,
  dataPerGroup: number = DEFAULT_PARITY.dataPerGroup
): number {
  const capacity = frameGeometry(profile).capacityBytes;
  const overhead = headerSize({ fileName, mimeType, parityMembers: new Array(dataPerGroup).fill(0) });
  const payloadSize = capacity - overhead;
  if (payloadSize <= 0) {
    throw new Error(`Frame holds ${capacity} B, the widest chunk header needs ${overhead} B`);
  }
  return payloadSize;
}

/**
 * Largest file this profile can carry, when the platform caps video length.
 * Instagram stops at 90 seconds, so the grid is not the only limit.
 */
export function maxPayloadFor(
  profile: VideoProfile,
  fileName: string,
  mimeType: string,
  parity: ParityOptions | false = {}
): number | undefined {
  if (profile.maxDurationSeconds === undefined) return undefined;

  const { dataPerGroup, parityPerGroup } =
    parity === false
      ? { dataPerGroup: DEFAULT_PARITY.dataPerGroup, parityPerGroup: 0 }
      : { ...DEFAULT_PARITY, ...parity };

  const payloadSize = payloadSizeFor(profile, fileName, mimeType, dataPerGroup);
  const frames = Math.floor(profile.maxDurationSeconds * profile.fps);
  const chunks = Math.floor(frames / profile.repeatFrames);

  // Chunks travel in blocks of dataPerGroup + parityPerGroup; a partial block
  // still pays for its parity before it carries any data.
  const perBlock = dataPerGroup + parityPerGroup;
  const wholeBlocks = Math.floor(chunks / perBlock);
  const spare = chunks % perBlock;
  const dataChunks =
    wholeBlocks * dataPerGroup + Math.min(dataPerGroup, Math.max(0, spare - parityPerGroup));

  return dataChunks * payloadSize;
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
  const { fileName, mimeType, profile, crf = 14, parity = {}, onProgress } = options;
  const dataPerGroup = (parity === false ? undefined : parity.dataPerGroup) ?? DEFAULT_PARITY.dataPerGroup;
  const payloadSize = payloadSizeFor(profile, fileName, mimeType, dataPerGroup);

  // Fail before spending minutes in x264 on a video the platform will refuse.
  const limit = maxPayloadFor(profile, fileName, mimeType, parity);
  if (limit !== undefined && data.length > limit) {
    throw new Error(
      `File is ${data.length} B but the ${profile.platform} profile holds ${limit} B: ` +
        `${profile.maxDurationSeconds} s at ${profile.fps} fps. Split the file or use another platform.`
    );
  }
  const dataChunks = await chunkFile(data, { fileName, mimeType, payloadSize });
  const parityChunks = parity === false ? [] : buildParityChunks(dataChunks, parity);
  const chunks = [...dataChunks, ...parityChunks];

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

  return {
    outputPath,
    chunks: dataChunks.length,
    parityChunks: parityChunks.length,
    frames,
    payloadBytes: data.length,
  };
}

/** Feed every decoded frame of a video to `onFrame`, streaming, never buffering. */
async function eachFrame(
  inputPath: string,
  profile: VideoProfile,
  onFrame: (frame: Buffer) => void
): Promise<void> {
  const frameSize = profile.width * profile.height * 3;
  const { proc, done } = ffmpeg([
    '-i', inputPath,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    // Undo any rescaling the platform applied before sampling the grid.
    '-vf', `scale=${profile.width}:${profile.height}`,
    'pipe:1',
  ]);

  const pending: Buffer[] = [];
  let pendingBytes = 0;

  for await (const piece of proc.stdout) {
    pending.push(piece as Buffer);
    pendingBytes += (piece as Buffer).length;
    if (pendingBytes < frameSize) continue;

    let joined = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    pending.length = 0;
    while (joined.length >= frameSize) {
      onFrame(joined.subarray(0, frameSize));
      joined = joined.subarray(frameSize);
    }
    pending.push(joined);
    pendingBytes = joined.length;
  }
  await done;
}

/**
 * Video -> the original file. Every frame is tried independently and the first
 * valid copy of each chunk wins, so a changed frame rate, a dropped frame or a
 * blended transition costs nothing as long as one clean copy survives. Chunks
 * that no frame carried are rebuilt from parity.
 */
export async function decodeVideoFile(
  inputPath: string,
  profile: VideoProfile,
  onProgress?: ProgressCallback
): Promise<DecodeResult> {
  const byIndex = new Map<number, EncodedChunk>();
  let framesRead = 0;
  let framesRejected = 0;

  await eachFrame(inputPath, profile, (frame) => {
    framesRead++;
    try {
      const chunk = parseChunk(readFrame(frame, profile).bytes);
      if (!byIndex.has(chunk.header.chunkIndex)) {
        byIndex.set(chunk.header.chunkIndex, chunk);
        onProgress?.({ phase: 'decode', completed: byIndex.size, total: chunk.header.totalChunks });
      }
    } catch {
      framesRejected++;
    }
  });

  if (byIndex.size === 0) {
    throw new Error(`No readable chunk in ${framesRead} frames. Wrong platform profile?`);
  }

  const { chunks, recovered } = recoverDataChunks([...byIndex.values()]);
  return {
    data: await assembleFile(chunks),
    header: chunks[0].header,
    recovered,
    framesRead,
    framesRejected,
  };
}

export interface SourceInfo {
  width: number;
  height: number;
  codec: string;
  /** Bits per second. Near the encoder's own rate means nothing re-encoded it. */
  bitRate: number;
}

export interface InspectResult {
  source?: SourceInfo;
  framesRead: number;
  framesReadable: number;
  /** Hamming repairs per readable frame. A high average means cells are too small. */
  correctionsAverage: number;
  correctionsMax: number;
  dataChunksFound: number;
  parityChunksFound: number;
  totalChunks: number;
  missing: number[];
  /** Whether what survived is enough to rebuild the file. */
  recoverable: boolean;
  /** Why not, when it is not. */
  reason?: string;
}

/**
 * Read a video without reassembling anything, and report how close to the edge
 * it is. Run this when a real upload comes back and the decode fails: the
 * correction counts say whether the cells were too small for that platform,
 * and the missing list says whether frames went missing instead.
 */
async function probe(inputPath: string): Promise<SourceInfo | undefined> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name',
      '-show_entries', 'format=bit_rate',
      '-of', 'default=nw=1',
      inputPath,
    ]);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve(undefined));
    proc.on('close', () => {
      const field = (name: string) => out.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];
      const width = Number(field('width'));
      const height = Number(field('height'));
      if (!width || !height) return resolve(undefined);
      resolve({
        width,
        height,
        codec: field('codec_name') ?? 'unknown',
        bitRate: Number(field('bit_rate')) || 0,
      });
    });
  });
}

export async function inspectVideo(inputPath: string, profile: VideoProfile): Promise<InspectResult> {
  const source = await probe(inputPath);
  const chunks: EncodedChunk[] = [];
  const seen = new Set<number>();
  let framesRead = 0;
  let framesReadable = 0;
  let correctionsTotal = 0;
  let correctionsMax = 0;

  await eachFrame(inputPath, profile, (frame) => {
    framesRead++;
    try {
      const { bytes, corrections } = readFrame(frame, profile);
      const chunk = parseChunk(bytes);
      framesReadable++;
      correctionsTotal += corrections;
      correctionsMax = Math.max(correctionsMax, corrections);
      if (!seen.has(chunk.header.chunkIndex)) {
        seen.add(chunk.header.chunkIndex);
        chunks.push(chunk);
      }
    } catch {
      /* unreadable frame, counted by difference */
    }
  });

  const dataChunks = chunks.filter((c) => c.header.kind === 'data');
  const totalChunks = chunks[0]?.header.totalChunks ?? 0;
  const missing: number[] = [];
  const present = new Set(dataChunks.map((c) => c.header.chunkIndex));
  for (let i = 0; i < totalChunks; i++) if (!present.has(i)) missing.push(i);

  let recoverable = chunks.length > 0;
  let reason: string | undefined;
  if (recoverable) {
    try {
      recoverDataChunks(chunks);
    } catch (err) {
      recoverable = false;
      reason = (err as Error).message;
    }
  } else {
    reason = `No readable chunk in ${framesRead} frames`;
  }

  return {
    ...(source ? { source } : {}),
    framesRead,
    framesReadable,
    correctionsAverage: framesReadable > 0 ? correctionsTotal / framesReadable : 0,
    correctionsMax,
    dataChunksFound: dataChunks.length,
    parityChunksFound: chunks.length - dataChunks.length,
    totalChunks,
    missing,
    recoverable,
    ...(reason ? { reason } : {}),
  };
}
