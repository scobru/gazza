import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_PARITY, VideoProfile, frameGeometry, profileFor } from '@dbforall/core';
import { encodeFileToVideo, payloadSizeFor } from '@dbforall/cli/dist/pipeline';

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

/** Finished carriers, waiting to be downloaded once and then deleted. */
const ready = new Map<string, { directory: string; parts: string[] }>();

async function handleEncode(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const fileName = basename(url.searchParams.get('name') ?? 'payload.bin');
  const profile = profileFor(url.searchParams.get('platform') ?? 'youtube');
  const splitParameter = url.searchParams.get('split');
  const splitSeconds = splitParameter ? Number(splitParameter) : undefined;

  const data = new Uint8Array(await readBody(req));
  if (data.length === 0) return json(res, 400, { error: 'No file received' });

  // Newline-delimited JSON: the browser reads progress as it arrives instead of
  // staring at a spinner for a minute.
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const send = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

  const directory = await mkdtemp(join(tmpdir(), 'dbforall-web-'));
  try {
    const result = await encodeFileToVideo(data, join(directory, `${fileName}.mp4`), {
      fileName,
      mimeType: 'application/octet-stream',
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
  process.stdout.write(`dbforall web interface on http://127.0.0.1:${PORT}\n`);
});

const cleanup = async () => {
  await Promise.all([...ready.values()].map((e) => rm(e.directory, { recursive: true, force: true })));
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
