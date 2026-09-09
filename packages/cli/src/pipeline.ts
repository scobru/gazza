import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
  /** Cut the carrier into videos of at most this many seconds each. */
  splitSeconds?: number;
  onProgress?: ProgressCallback;
}

export interface EncodeResult {
  /** Every video written, in order. One entry unless the carrier was split. */
  parts: string[];
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

/**
 * Pull the least damaged video-only stream: highest resolution first, then
 * highest bitrate. Audio would only be re-encoded for nothing.
 *
 * No resolution cap. An earlier version preferred height <= 1080, which reads
 * as sensible until the carrier is portrait: Instagram's 720x1280 rendition is
 * 1280 tall, so the cap rejected it and took the 360x640 one instead - a 3x
 * downscale that shrank 12 px cells to 4 px and lost the file. A platform never
 * serves more pixels than were uploaded, so more is always better.
 *
 * The bitrate tiebreak matters on YouTube, which offers the same upload as h264
 * and as AV1: AV1 at a similar bitrate destroys far more of the grid.
 */
/** Hosts yt-dlp has no extractor for. Better said up front than as its error. */
const UNFETCHABLE: { pattern: RegExp; host: string }[] = [
  { pattern: /(^|\.)photos\.google\.com|photos\.app\.goo\.gl/i, host: 'Google Photos' },
];

export function downloadVideo(
  url: string,
  directory: string,
  browser?: string,
  format?: string
): Promise<string> {
  const unfetchable = UNFETCHABLE.find((entry) => entry.pattern.test(url));
  if (unfetchable) {
    return Promise.reject(
      new Error(
        `${unfetchable.host} links cannot be fetched: there is no yt-dlp extractor for them. ` +
          'Download the video from the album and pass the file instead.'
      )
    );
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'yt-dlp',
      [
        '--no-playlist',
        '-f', format ?? 'bv*/b',
        ...(format ? [] : ['-S', 'res,br']),
        ...(browser ? ['--cookies-from-browser', browser] : []),
        '-o', join(directory, 'carrier.%(ext)s'),
        url,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    );
    proc.on('error', (err) =>
      reject(new Error(`Could not run yt-dlp (${err.message}). Is it installed and on PATH?`))
    );
    proc.on('close', async (code) => {
      if (code !== 0) {
        const hint = format
          ? `. Format "${format}" may not exist for this video - list them with: yt-dlp -F "${url}"`
          : '';
        return reject(new Error(`yt-dlp exited ${code}${hint}`));
      }
      const files = await readdir(directory);
      if (files.length === 0) return reject(new Error('yt-dlp downloaded nothing'));
      resolve(join(directory, files[0]));
    });
  });
}


/** Name part n of a split carrier: carrier.mp4 -> carrier-001.mp4 */
function partPath(outputPath: string, index: number): string {
  const dot = outputPath.lastIndexOf('.');
  const stem = dot > 0 ? outputPath.slice(0, dot) : outputPath;
  const extension = dot > 0 ? outputPath.slice(dot) : '';
  return `${stem}-${String(index + 1).padStart(3, '0')}${extension}`;
}

/** Render one run of chunks into one video. */
async function writeVideo(
  chunks: EncodedChunk[],
  outputPath: string,
  profile: VideoProfile,
  crf: number,
  onFrame: () => void
): Promise<void> {
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

  try {
    for (const chunk of chunks) {
      const pixels = renderFrame(serializeChunk(chunk), profile);
      for (let r = 0; r < profile.repeatFrames; r++) {
        await write(proc.stdin, pixels);
        onFrame();
      }
    }
    proc.stdin.end();
  } catch (err) {
    proc.kill();
    throw err;
  }
  await done;
}

/**
 * File bytes -> one or more videos carrying one chunk per frame, repeated for
 * redundancy. Splitting needs no manifest: every chunk header already carries
 * the file hash, its own index and the total, so the parts identify themselves
 * and decoding merges them in any order.
 */
export async function encodeFileToVideo(
  data: Uint8Array,
  outputPath: string,
  options: EncodeOptions
): Promise<EncodeResult> {
  const { fileName, mimeType, profile, crf = 14, parity = {}, splitSeconds, onProgress } = options;
  const dataPerGroup = (parity === false ? undefined : parity.dataPerGroup) ?? DEFAULT_PARITY.dataPerGroup;
  const payloadSize = payloadSizeFor(profile, fileName, mimeType, dataPerGroup);

  // A split longer than the platform allows would produce parts it rejects.
  if (splitSeconds !== undefined && profile.maxDurationSeconds !== undefined && splitSeconds > profile.maxDurationSeconds) {
    throw new Error(
      `--split ${splitSeconds} s exceeds what ${profile.platform} accepts per video (${profile.maxDurationSeconds} s)`
    );
  }

  const cap = splitSeconds === undefined ? maxPayloadFor(profile, fileName, mimeType, parity) : undefined;
  if (cap !== undefined && data.length > cap) {
    throw new Error(
      `File is ${data.length} B but the ${profile.platform} profile holds ${cap} B: ` +
        `${profile.maxDurationSeconds} s at ${profile.fps} fps. Use --split to spread it over several videos.`
    );
  }

  const dataChunks = await chunkFile(data, { fileName, mimeType, payloadSize });
  const parityChunks = parity === false ? [] : buildParityChunks(dataChunks, parity);
  const chunks = [...dataChunks, ...parityChunks];

  const limitSeconds = splitSeconds ?? profile.maxDurationSeconds;
  const perPart =
    limitSeconds === undefined
      ? chunks.length
      : Math.max(1, Math.floor((limitSeconds * profile.fps) / profile.repeatFrames));

  const parts: string[] = [];
  const total = Math.max(1, Math.ceil(chunks.length / perPart));
  let frames = 0;

  for (let i = 0; i < total; i++) {
    const path = total === 1 ? outputPath : partPath(outputPath, i);
    await writeVideo(
      chunks.slice(i * perPart, (i + 1) * perPart),
      path,
      profile,
      crf,
      () => {
        frames++;
        onProgress?.({ phase: 'encode', completed: frames, total: chunks.length * profile.repeatFrames });
      }
    );
    parts.push(path);
  }

  return {
    parts,
    outputPath: parts[0],
    chunks: dataChunks.length,
    parityChunks: parityChunks.length,
    frames,
    payloadBytes: data.length,
  };
}

const CROP_PATTERN = /^\d{1,5}:\d{1,5}:\d{1,5}:\d{1,5}$/;

export interface ReadOptions {
  /** ffmpeg crop as "w:h:x:y", or "auto" to locate the grid in the frame. */
  crop?: string;
  onProgress?: ProgressCallback;
}

/** Feed every decoded frame of a video to `onFrame`, streaming, never buffering. */
async function eachFrame(
  inputPath: string,
  profile: VideoProfile,
  crop: string | undefined,
  onFrame: (frame: Buffer) => void
): Promise<void> {
  if (crop !== undefined && !CROP_PATTERN.test(crop)) {
    throw new Error(`Bad crop "${crop}", expected w:h:x:y in pixels`);
  }
  const frameSize = profile.width * profile.height * 3;
  const { proc, done } = ffmpeg([
    '-i', inputPath,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    // Cut the grid out of whatever surrounds it, then undo any rescaling the
    // platform applied, so the cells land where the decoder expects them.
    '-vf', `${crop ? `crop=${crop},` : ''}scale=${profile.width}:${profile.height}`,
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
 * Find where the carrier grid sits inside a frame that also contains something
 * else - a browser around a player, a platform's letterboxing, a crop. The grid
 * is saturated colour end to end while player chrome and page furniture are
 * not, so the bounding box of strongly coloured pixels is the carrier.
 *
 * Returns an ffmpeg crop, or undefined when the grid already fills the frame.
 */
export async function detectCrop(inputPath: string, sampleFrames = 12): Promise<string | undefined> {
  const probed = await probe(inputPath);
  if (!probed) return undefined;
  const { width, height } = probed;

  const { proc, done } = ffmpeg([
    '-i', inputPath,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-frames:v', String(sampleFrames * 20),
    'pipe:1',
  ]);

  const frameSize = width * height * 3;
  const columns = new Float64Array(width);
  const rows = new Float64Array(height);
  let frames = 0;

  const pending: Buffer[] = [];
  let pendingBytes = 0;

  const measure = (px: Buffer) => {
    // Only every 20th frame: enough to average out a transient overlay.
    if (frames++ % 20 !== 0) return;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 3;
        const r = px[o];
        const g = px[o + 1];
        const b = px[o + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 70) {
          columns[x]++;
          rows[y]++;
        }
      }
    }
  };

  for await (const piece of proc.stdout) {
    pending.push(piece as Buffer);
    pendingBytes += (piece as Buffer).length;
    if (pendingBytes < frameSize) continue;
    let joined = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    pending.length = 0;
    while (joined.length >= frameSize) {
      measure(joined.subarray(0, frameSize));
      joined = joined.subarray(frameSize);
    }
    pending.push(joined);
    pendingBytes = joined.length;
  }
  await done;

  const sampled = Math.max(1, Math.ceil(frames / 20));
  const span = (counts: Float64Array, extent: number, threshold: number) => {
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < extent; i++) {
      if (counts[i] < threshold) continue;
      if (lo < 0) lo = i;
      hi = i;
    }
    return [lo, hi];
  };

  const [y0, y1] = span(rows, height, sampled * width * 0.25);
  const [x0, x1] = span(columns, width, sampled * height * 0.15);
  if (x0 < 0 || y0 < 0) return undefined;

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  // Already full frame, give or take a pixel of rounding: nothing to crop.
  if (w >= width - 2 && h >= height - 2) return undefined;
  if (w < 64 || h < 64) return undefined;

  return `${w}:${h}:${x0}:${y0}`;
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
  options: ReadOptions = {}
): Promise<DecodeResult> {
  return decodeVideos([inputPath], profile, options);
}

/**
 * Several videos -> one file. A split carrier needs no manifest to reassemble:
 * every chunk header carries the file hash, its own index and the total, so the
 * parts can arrive in any order and duplicates cost nothing.
 */
export async function decodeVideos(
  inputPaths: string[],
  profile: VideoProfile,
  options: ReadOptions = {}
): Promise<DecodeResult> {
  if (inputPaths.length === 0) throw new Error('No video to decode');
  const { onProgress } = options;

  const byIndex = new Map<number, EncodedChunk>();
  let dataSeen = 0;
  let framesRead = 0;
  let framesRejected = 0;
  // Chunks of two different files share the same indices, so a foreign chunk
  // would be dropped as a duplicate and the wrong file would decode cleanly.
  // Catch it on the way in, by hash, not by counting hashes afterwards.
  let expectedHash: string | undefined;
  let foreign = 0;

  for (const inputPath of inputPaths) {
    const crop = options.crop === 'auto' ? await detectCrop(inputPath) : options.crop;
    await eachFrame(inputPath, profile, crop, (frame) => {
      framesRead++;
      try {
        const chunk = parseChunk(readFrame(frame, profile).bytes);
        expectedHash ??= chunk.header.fileSha256;
        if (chunk.header.fileSha256 !== expectedHash) {
          foreign++;
          return;
        }
        if (!byIndex.has(chunk.header.chunkIndex)) {
          byIndex.set(chunk.header.chunkIndex, chunk);
          if (chunk.header.kind === 'data') dataSeen++;
          // Parity chunks are not part of the file, so counting them here would
          // report more chunks recovered than the file has.
          onProgress?.({ phase: 'decode', completed: dataSeen, total: chunk.header.totalChunks });
        }
      } catch {
        framesRejected++;
      }
    });
  }

  if (byIndex.size === 0) {
    throw new Error(`No readable chunk in ${framesRead} frames. Wrong platform profile?`);
  }

  if (foreign > 0) {
    throw new Error(
      `These videos carry different files: ${foreign} chunks belong to another one`
    );
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
  /** Region the grid was read from, when it did not fill the frame. */
  crop?: string;
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

export async function inspectVideo(
  inputPath: string,
  profile: VideoProfile,
  options: ReadOptions = {}
): Promise<InspectResult> {
  const source = await probe(inputPath);
  const crop = options.crop === 'auto' ? await detectCrop(inputPath) : options.crop;
  const chunks: EncodedChunk[] = [];
  const seen = new Set<number>();
  let framesRead = 0;
  let framesReadable = 0;
  let correctionsTotal = 0;
  let correctionsMax = 0;

  await eachFrame(inputPath, profile, crop, (frame) => {
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
    ...(crop ? { crop } : {}),
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
