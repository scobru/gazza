import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  DEFAULT_PARITY,
  SEALED_FILE_NAME,
  SEALED_MIME_TYPE,
  VideoProfile,
  frameGeometry,
  isSealed,
  open as unseal,
  profileFor,
  seal,
} from '@gazza/core';
import { decodeVideos, downloadVideo, encodeFileToVideo, payloadSizeFor } from '@gazza/cli/dist/pipeline';

const PORT = Number(process.env.PORT ?? 4321);

/**
 * Loopback on a workstation, every interface inside a container.
 *
 * Binding loopback in a container means nothing outside it can connect, which
 * is how this first met a 502 from the proxy in front. Relying on the image to
 * set HOST turned out to be fragile - a platform can start a container without
 * carrying the Dockerfile's environment through - so the container detects
 * itself instead. HOST still overrides both.
 */
function containerSignal(): string | undefined {
  if (existsSync('/.dockerenv')) return '/.dockerenv';
  // The CMD of a container is PID 1. Nothing on a workstation runs node as PID 1.
  if (process.pid === 1) return 'pid 1';
  if (process.env.CAPROVER_GIT_COMMIT_SHA) return 'caprover';
  return undefined;
}

const signal = containerSignal();
const HOST = process.env.HOST ?? (signal ? '0.0.0.0' : '127.0.0.1');
const PAGE = join(__dirname, '..', 'src', 'index.html');

/** Just the head: a whole magpie is unreadable at 16 px. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#14151d"/>
  <circle cx="14" cy="17" r="9" fill="#101420"/>
  <path d="M14 8 a9 9 0 0 1 9 9 q-5-3-9-3 -4 0-9 3 a9 9 0 0 1 9-9Z" fill="#3d8f7d"/>
  <circle cx="17.5" cy="14.5" r="3" fill="#fbfcff"/>
  <circle cx="18.3" cy="14.5" r="1.5" fill="#0b0e16"/>
  <path d="M22 16 L31 18 L22 20 Z" fill="#f2b134"/>
</svg>`;

/*
 * Limits for an instance anyone can reach. Every one of these exists because
 * without it a single request can take the whole thing down: the body was read
 * into memory unbounded, ffmpeg was spawned once per request with no ceiling,
 * finished carriers were deleted only if somebody downloaded them, and yt-dlp
 * would fetch whatever URL it was handed - including the host's own network.
 */
const MAX_FILE = Number(process.env.GAZZA_MAX_FILE ?? 8 * 1024 * 1024);
/** Streamed to disk, so this is a size limit and not a memory one. */
const MAX_VIDEO = Number(process.env.GAZZA_MAX_VIDEO ?? 256 * 1024 * 1024);
const MAX_QUEUE = Number(process.env.GAZZA_MAX_QUEUE ?? 4);
const JOB_TTL_MS = Number(process.env.GAZZA_JOB_TTL_MS ?? 30 * 60 * 1000);

/** A shared secret, if the operator wants one. Empty means open. */
const TOKEN = process.env.GAZZA_TOKEN ?? '';

/**
 * Fetching a URL means this server makes a request of the requester's choosing,
 * which reaches everything the container can: sibling apps by name, the
 * provider's metadata endpoint, anything on the private network. So it is off
 * unless asked for, and even then only to hosts that plausibly hold a carrier.
 */
const ALLOW_URLS = process.env.GAZZA_ALLOW_URLS === '1';
const URL_HOSTS = (process.env.GAZZA_URL_HOSTS ?? 'youtube.com,youtu.be,instagram.com')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

function urlIsAllowed(candidate: string): boolean {
  let host: string;
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Suffix match on a dot boundary, so evil-youtube.com does not pass as youtube.com.
  return URL_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

/**
 * One ffmpeg at a time. It is CPU-bound and a carrier is minutes of encoding;
 * running several in parallel does not finish them sooner, it just runs the
 * machine out of cores. Anything past a short queue is turned away rather than
 * left waiting forever.
 */
let running = 0;
let queued = 0;

async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (queued >= MAX_QUEUE) throw Object.assign(new Error('Too many people are asking her at once. Try again in a minute.'), { status: 503 });
  queued++;
  try {
    while (running > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    running++;
    try {
      return await work();
    } finally {
      running--;
    }
  } finally {
    queued--;
  }
}

/**
 * Bytes of mp4 per frame, measured on real carriers: 81.5 MB over 1104 frames
 * on the YouTube profile, 27.8 MB over 214 on Instagram. Smaller cells mean
 * more detail per frame and a bigger file, so this is per profile rather than
 * one number. Only an estimate - x264 decides the real size.
 */
const BYTES_PER_FRAME: Record<string, number> = {
  youtube: 73_800,
  instagram: 129_700,
  // 12 px cells at 1080p, measured at 11.3 MB over 92 frames.
  telegram: 122_800,
  whatsapp: 122_800,
  googlephotos: 73_800,
};

interface Estimate {
  payloadSize: number;
  dataChunks: number;
  parityChunks: number;
  frames: number;
  seconds: number;
  /** Videos this becomes, and how long the longest one runs. */
  parts: number;
  partSeconds: number;
  approximateBytes: number;
  capacityPerFrame: number;
  overSizeLimit?: number;
}

function estimate(profile: VideoProfile, fileSize: number, fileName: string, splitSeconds?: number): Estimate {
  const payloadSize = payloadSizeFor(profile, fileName, 'application/octet-stream');
  const dataChunks = Math.max(1, Math.ceil(fileSize / payloadSize));
  const groups = Math.ceil(dataChunks / DEFAULT_PARITY.dataPerGroup);
  const parityChunks = groups * DEFAULT_PARITY.parityPerGroup;
  const frames = (dataChunks + parityChunks) * profile.repeatFrames;

  const seconds = frames / profile.fps;
  // The platform's cap applies to each video, not to their total: splitting is
  // exactly how a long payload gets under it.
  const parts = splitSeconds ? Math.ceil(seconds / splitSeconds) : 1;
  const partSeconds = splitSeconds ? Math.min(splitSeconds, seconds) : seconds;
  const cap = profile.maxDurationSeconds;

  return {
    payloadSize,
    dataChunks,
    parityChunks,
    frames,
    seconds,
    parts,
    partSeconds,
    approximateBytes: frames * (BYTES_PER_FRAME[profile.platform] ?? 100_000),
    capacityPerFrame: frameGeometry(profile).capacityBytes,
    ...(cap !== undefined && partSeconds > cap ? { overSizeLimit: cap } : {}),
  };
}

/** Sizes people can read: a 256 KB limit rounded to MB is "0 MB". */
const humanSize = (bytes: number): string =>
  bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.round(bytes / 1024)} KB`;

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop keeping it, but keep listening: destroying the request here
        // would take the connection down before the refusal could be sent, and
        // the caller would see a reset instead of a reason.
        over = true;
        parts.length = 0;
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      if (over) {
        reject(
          Object.assign(
            new Error(`That is larger than ${humanSize(limit)}, which is as much as this instance accepts.`),
            { status: 413 }
          )
        );
        return;
      }
      resolve(Buffer.concat(parts));
    });
    req.on('error', reject);
  });
}

/**
 * Write an upload to disk as it arrives.
 *
 * A carrier is tens of megabytes; reading one into a Buffer first made every
 * upload cost that much RAM at once, and a couple of concurrent ones could take
 * the process down on a small host. Over the limit it stops writing and deletes
 * what it wrote, but keeps consuming the request: hanging up here would take
 * the socket down before the refusal could be sent.
 */
function streamToFile(req: IncomingMessage, path: string, limit: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path);
    let size = 0;
    let over = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (over) return;
      if (size > limit) {
        over = true;
        out.destroy();
        void rm(path, { force: true });
        return;
      }
      out.write(chunk);
    });

    req.on('error', reject);
    out.on('error', (error) => {
      if (!over) reject(error);
    });

    req.on('end', () => {
      if (over) {
        reject(
          Object.assign(
            new Error(`That is larger than ${humanSize(limit)}, which is as much as this instance accepts.`),
            { status: 413 }
          )
        );
        return;
      }
      out.end(() => resolve());
    });
  });
}

/**
 * The password travels in a header, never in the query string: a URL is kept in
 * browser history and written to any access log in the way, a header is not.
 */
const passwordOf = (req: IncomingMessage): string => {
  const value = req.headers['x-gazza-password'];
  return (Array.isArray(value) ? value[0] : value) ?? '';
};

/** Finished carriers, waiting to be downloaded once and then deleted. */
const ready = new Map<string, { directory: string; parts: string[]; born: number }>();

async function handleEncode(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const fileName = basename(url.searchParams.get('name') ?? 'payload.bin');
  const profile = profileFor(url.searchParams.get('platform') ?? 'youtube');
  const splitParameter = url.searchParams.get('split');
  const splitSeconds = splitParameter ? Number(splitParameter) : undefined;

  let data = new Uint8Array(await readBody(req, MAX_FILE));
  if (data.length === 0) return json(res, 400, { error: 'No file received' });

  // Seal before chunking, exactly as the command line does, so the name and the
  // type end up inside the ciphertext rather than in the chunk headers.
  const password = passwordOf(req);
  let carriedName = fileName;
  let carriedType = 'application/octet-stream';
  if (password) {
    data = new Uint8Array(
      await seal({ data, fileName, mimeType: carriedType }, password)
    );
    carriedName = SEALED_FILE_NAME;
    carriedType = SEALED_MIME_TYPE;
  }

  // Newline-delimited JSON: the browser reads progress as it arrives instead of
  // staring at a spinner for a minute.
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const send = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

  const directory = await mkdtemp(join(tmpdir(), 'gazza-web-'));
  try {
    const result = await exclusive(() => encodeFileToVideo(data, join(directory, `${carriedName}.mp4`), {
      fileName: carriedName,
      mimeType: carriedType,
      profile,
      ...(splitSeconds ? { splitSeconds } : {}),
      onProgress: ({ completed, total }) => send({ phase: 'encode', completed, total }),
    }));

    const id = basename(directory);
    ready.set(id, { directory, parts: result.parts, born: Date.now() });

    const sizes = await Promise.all(result.parts.map(async (p) => (await stat(p)).size));
    send({
      done: true,
      id,
      sealed: password.length > 0,
      chunks: result.chunks,
      parityChunks: result.parityChunks,
      frames: result.frames,
      seconds: result.frames / profile.fps,
      parts: result.parts.map((path, i) => ({ name: basename(path), bytes: sizes[i], index: i })),
    });
    res.end();
  } catch (error) {
    send({ error: (error as Error).message });
    res.end();
    await rm(directory, { recursive: true, force: true });
  }
}

/** A decode in the making: uploaded parts and fetched URLs land in one directory. */
const jobs = new Map<string, { directory: string; files: string[]; born: number }>();

async function handleDecode(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const job = jobs.get(url.searchParams.get('job') ?? '');
  if (!job) return json(res, 404, { error: 'Unknown decode job' });

  const profile = profileFor(url.searchParams.get('platform') ?? 'youtube');
  const password = passwordOf(req);
  const urls = url.searchParams.getAll('url').filter(Boolean);

  if (urls.length > 0 && !ALLOW_URLS) {
    return json(res, 403, {
      error: 'This instance does not fetch links. Download the video and upload the file instead.',
    });
  }
  const refused = urls.filter((candidate) => !urlIsAllowed(candidate));
  if (refused.length > 0) {
    return json(res, 403, {
      error: `Not a host this instance will fetch from: ${refused.join(', ')}. Allowed: ${URL_HOSTS.join(', ')}.`,
    });
  }

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const send = (event: unknown) => res.write(`${JSON.stringify(event)}
`);

  try {
    for (const [i, source] of urls.entries()) {
      send({ phase: 'fetch', completed: i, total: urls.length });
      const into = join(job.directory, `url-${i}`);
      await mkdir(into, { recursive: true });
      job.files.push(await downloadVideo(source, into, undefined, undefined, MAX_VIDEO));
    }
    if (job.files.length === 0) throw new Error('No video to decode: add a link or a file');

    const read = { crop: undefined as string | undefined, onProgress: (u: { completed: number; total: number }) => send({ phase: 'decode', ...u }) };
    let result;
    try {
      result = await exclusive(() => decodeVideos(job.files, profile, read));
    } catch (first) {
      // A screen recording, letterboxing or a player that was not fullscreen:
      // the grid is in there but not filling the frame. Worth one more try.
      send({ phase: 'retry', message: 'looking for the grid inside the frame' });
      try {
        result = await exclusive(() => decodeVideos(job.files, profile, { ...read, crop: 'auto' }));
      } catch {
        throw first;
      }
    }

    let payload = result.data;
    let name = result.header.fileName;
    if (isSealed(payload)) {
      if (!password) throw new Error('This carrier is sealed: enter its password');
      const opened = await unseal(payload, password);
      payload = opened.data;
      name = opened.fileName;
    }

    const recovered = join(job.directory, 'recovered');
    await writeFile(recovered, payload);
    send({
      done: true,
      name,
      bytes: payload.length,
      framesRead: result.framesRead,
      framesRejected: result.framesRejected,
      recovered: result.recovered.length,
    });
    res.end();
  } catch (error) {
    send({ error: (error as Error).message });
    res.end();
  }
}

async function handleDownload(res: ServerResponse, id: string, index: number): Promise<void> {
  const entry = ready.get(id);
  const path = entry?.parts[index];
  if (!entry || !path) return json(res, 404, { error: 'Unknown or already collected carrier' });

  const { size } = await stat(path);
  res.writeHead(200, {
    'content-type': 'video/mp4',
    'content-length': size,
    'content-disposition': `attachment; filename="${basename(path)}"`,
  });
  createReadStream(path).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (TOKEN) {
      const offered = req.headers['x-gazza-token'] ?? url.searchParams.get('token') ?? '';
      if ((Array.isArray(offered) ? offered[0] : offered) !== TOKEN) {
        return json(res, 401, { error: 'This instance is not open. A token is required.' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const page = await readFile(PAGE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }

    if (req.method === 'GET' && url.pathname === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
      return res.end(FAVICON);
    }

    if (req.method === 'GET' && url.pathname === '/limits') {
      return json(res, 200, {
        maxFile: MAX_FILE,
        maxVideo: MAX_VIDEO,
        maxQueue: MAX_QUEUE,
        jobTtlMinutes: Math.round(JOB_TTL_MS / 60000),
        allowUrls: ALLOW_URLS,
        urlHosts: URL_HOSTS,
        tokenRequired: TOKEN.length > 0,
      });
    }

    if (req.method === 'GET' && url.pathname === '/estimate') {
      const profile = profileFor(url.searchParams.get('platform') ?? 'youtube');
      const size = Number(url.searchParams.get('size') ?? 0);
      const split = url.searchParams.get('split');
      return json(
        res,
        200,
        estimate(profile, size, url.searchParams.get('name') ?? 'payload.bin', split ? Number(split) : undefined)
      );
    }

    if (req.method === 'POST' && url.pathname === '/encode') {
      return await handleEncode(req, res, url);
    }

    if (req.method === 'POST' && url.pathname === '/decode/job') {
      const directory = await mkdtemp(join(tmpdir(), 'gazza-job-'));
      const id = basename(directory);
      jobs.set(id, { directory, files: [], born: Date.now() });
      return json(res, 200, { id });
    }

    if (req.method === 'POST' && url.pathname === '/decode/upload') {
      const job = jobs.get(url.searchParams.get('job') ?? '');
      if (!job) return json(res, 404, { error: 'Unknown decode job' });
      const path = join(job.directory, `part-${job.files.length}.mp4`);
      await streamToFile(req, path, MAX_VIDEO);
      job.files.push(path);
      return json(res, 200, { files: job.files.length });
    }

    if (req.method === 'POST' && url.pathname === '/decode') {
      return await handleDecode(req, res, url);
    }

    const recovered = url.pathname.match(/^\/recovered\/([^/]+)$/);
    if (req.method === 'GET' && recovered) {
      const job = jobs.get(recovered[1]);
      if (!job) return json(res, 404, { error: 'Unknown decode job' });
      const path = join(job.directory, 'recovered');
      const { size } = await stat(path);
      const name = url.searchParams.get('name') ?? 'recovered.bin';
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': size,
        'content-disposition': `attachment; filename="${basename(name)}"`,
      });
      return void createReadStream(path).pipe(res);
    }

    const download = url.pathname.match(/^\/download\/([^/]+)\/(\d+)$/);
    if (req.method === 'GET' && download) {
      return await handleDownload(res, download[1], Number(download[2]));
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    json(res, status, { error: (error as Error).message });
  }
});

/**
 * Carriers are deleted when collected, but nobody has to collect them. Without
 * this sweep an instance fills its disk with videos no one ever came back for.
 */
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, entry] of [...ready, ...jobs]) {
    if (entry.born > cutoff) continue;
    void rm(entry.directory, { recursive: true, force: true });
    ready.delete(id);
    jobs.delete(id);
  }
}, 60_000).unref();

server.listen(PORT, HOST, () => {
  // Say why this address was chosen. Without it a wrong bind is
  // indistinguishable from an old build still running, and the proxy in front
  // says only 502.
  const why = process.env.HOST ? 'HOST was set'
    : signal ? 'container detected via ' + signal
    : 'no container detected';
  process.stdout.write(`gazza is awake on http://${HOST}:${PORT} (${why})\n`);

  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    process.stdout.write(
      `reachable beyond loopback. files <= ${humanSize(MAX_FILE)}, ` +
        `videos <= ${humanSize(MAX_VIDEO)}, one encode at a time, ` +
        `temporaries swept after ${Math.round(JOB_TTL_MS / 60000)} min, ` +
        `links ${ALLOW_URLS ? 'allowed from ' + URL_HOSTS.join('/') : 'refused'}, ` +
        `token ${TOKEN ? 'required' : 'not set'}.\n`
    );
  }
});

const cleanup = async () => {
  const directories = [...ready.values(), ...jobs.values()].map((e) => e.directory);
  await Promise.all(directories.map((d) => rm(d, { recursive: true, force: true })));
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
