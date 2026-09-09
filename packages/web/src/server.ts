import { createReadStream } from 'node:fs';
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
const PAGE = join(__dirname, '..', 'src', 'index.html');

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

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
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
const ready = new Map<string, { directory: string; parts: string[] }>();

async function handleEncode(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const fileName = basename(url.searchParams.get('name') ?? 'payload.bin');
  const profile = profileFor(url.searchParams.get('platform') ?? 'youtube');
  const splitParameter = url.searchParams.get('split');
  const splitSeconds = splitParameter ? Number(splitParameter) : undefined;

  let data = new Uint8Array(await readBody(req));
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
    const result = await encodeFileToVideo(data, join(directory, `${carriedName}.mp4`), {
      fileName: carriedName,
      mimeType: carriedType,
      profile,
      ...(splitSeconds ? { splitSeconds } : {}),
      onProgress: ({ completed, total }) => send({ phase: 'encode', completed, total }),
    });

    const id = basename(directory);
    ready.set(id, { directory, parts: result.parts });

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
const jobs = new Map<string, { directory: string; files: string[] }>();

async function handleDecode(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const job = jobs.get(url.searchParams.get('job') ?? '');
  if (!job) return json(res, 404, { error: 'Unknown decode job' });

  const profile = profileFor(url.searchParams.get('platform') ?? 'youtube');
  const password = passwordOf(req);
  const urls = url.searchParams.getAll('url').filter(Boolean);

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const send = (event: unknown) => res.write(`${JSON.stringify(event)}
`);

  try {
    for (const [i, source] of urls.entries()) {
      send({ phase: 'fetch', completed: i, total: urls.length });
      const into = join(job.directory, `url-${i}`);
      await mkdir(into, { recursive: true });
      job.files.push(await downloadVideo(source, into));
    }
    if (job.files.length === 0) throw new Error('No video to decode: add a link or a file');

    const read = { crop: undefined as string | undefined, onProgress: (u: { completed: number; total: number }) => send({ phase: 'decode', ...u }) };
    let result;
    try {
      result = await decodeVideos(job.files, profile, read);
    } catch (first) {
      // A screen recording, letterboxing or a player that was not fullscreen:
      // the grid is in there but not filling the frame. Worth one more try.
      send({ phase: 'retry', message: 'looking for the grid inside the frame' });
      try {
        result = await decodeVideos(job.files, profile, { ...read, crop: 'auto' });
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
    if (req.method === 'GET' && url.pathname === '/') {
      const page = await readFile(PAGE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
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
      jobs.set(id, { directory, files: [] });
      return json(res, 200, { id });
    }

    if (req.method === 'POST' && url.pathname === '/decode/upload') {
      const job = jobs.get(url.searchParams.get('job') ?? '');
      if (!job) return json(res, 404, { error: 'Unknown decode job' });
      const path = join(job.directory, `part-${job.files.length}.mp4`);
      await writeFile(path, await readBody(req));
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
    json(res, 500, { error: (error as Error).message });
  }
});

// Loopback only. This serves file contents and shells out to ffmpeg; it has no
// business being reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`gazza is awake on http://127.0.0.1:${PORT}\n`);
});

const cleanup = async () => {
  const directories = [...ready.values(), ...jobs.values()].map((e) => e.directory);
  await Promise.all(directories.map((d) => rm(d, { recursive: true, force: true })));
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
