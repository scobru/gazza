#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { profileFor } from '@dbforall/core';
import { decodeVideoFile, encodeFileToVideo, inspectVideo, maxPayloadFor, payloadSizeFor } from './pipeline';

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.json': 'application/json',
};

const USAGE = `dbforall - store files inside video

  dbforall encode  <file> <out.mp4>       [--platform youtube|instagram] [--crf 14]
  dbforall decode  <video|url> [out-file] [--platform youtube|instagram]
  dbforall inspect <video|url>            [--platform youtube|instagram]

decode and inspect accept a URL and fetch it with yt-dlp. Add
--cookies-from-browser chrome (or edge, firefox) when YouTube refuses an
anonymous request, which it does for unlisted videos and under rate limiting.
Encode and decode must use the same platform profile (default: youtube).
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) i++;
    else out.push(args[i]);
  }
  return out;
}

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * Pull the highest resolution video-only stream. Audio would only be re-encoded
 * for nothing, and a downscaled stream loses the cells we came for.
 */
function download(url: string, directory: string, browser?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'yt-dlp',
      [
        '--no-playlist',
        '-f', 'bv*[height<=?1080]/bv*/b',
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
      if (code !== 0) return reject(new Error(`yt-dlp exited ${code}`));
      const files = await readdir(directory);
      if (files.length === 0) return reject(new Error('yt-dlp downloaded nothing'));
      resolve(join(directory, files[0]));
    });
  });
}

/** Run `body` on a local path, fetching the URL into a temp directory first. */
async function withVideo<T>(
  source: string,
  browser: string | undefined,
  body: (path: string) => Promise<T>
): Promise<T> {
  if (!isUrl(source)) return body(source);

  const directory = await mkdtemp(join(tmpdir(), 'dbforall-'));
  try {
    return await body(await download(source, directory, browser));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = positional(rest);
  const profile = profileFor(flag(rest, 'platform') ?? 'youtube');
  const browser = flag(rest, 'cookies-from-browser');

  if (command === 'encode') {
    const [input, output] = args;
    if (!input || !output) throw new Error(USAGE);

    const data = new Uint8Array(await readFile(input));
    const fileName = basename(input);
    const mimeType = MIME_BY_EXT[extname(input).toLowerCase()] ?? 'application/octet-stream';

    const result = await encodeFileToVideo(data, output, {
      fileName,
      mimeType,
      profile,
      crf: Number(flag(rest, 'crf') ?? 14),
      onProgress: ({ completed, total }) => process.stderr.write(`\rencoding chunk ${completed}/${total}`),
    });

    process.stderr.write('\r');
    console.log(
      `${result.payloadBytes} B -> ${result.chunks} chunks of ` +
        `${payloadSizeFor(profile, fileName, mimeType)} B + ${result.parityChunks} parity -> ` +
        `${result.frames} frames (${(result.frames / profile.fps).toFixed(1)} s) -> ${result.outputPath}`
    );
    return;
  }

  if (command === 'decode') {
    const [input, output] = args;
    if (!input) throw new Error(USAGE);

    const result = await withVideo(input, browser, (path) =>
      decodeVideoFile(path, profile, ({ completed, total }) =>
        process.stderr.write(`\rrecovered chunk ${completed}/${total}`)
      )
    );

    const target = output ?? result.header.fileName;
    await writeFile(target, result.data);

    process.stderr.write('\r');
    const rebuilt = result.recovered.length > 0 ? `, ${result.recovered.length} rebuilt from parity` : '';
    console.log(
      `${target}: ${result.data.length} B recovered from ${result.framesRead} frames ` +
        `(${result.framesRejected} unreadable${rebuilt})`
    );
    return;
  }

  if (command === 'inspect') {
    const [input] = args;
    if (!input) throw new Error(USAGE);

    const r = await withVideo(input, browser, (path) => inspectVideo(path, profile));
    const rows: [string, string][] = [
      ['frames', `${r.framesRead} read, ${r.framesReadable} readable`],
      ['hamming', `${r.correctionsAverage.toFixed(1)} corrections/frame average, ${r.correctionsMax} worst`],
      ['chunks', `${r.dataChunksFound}/${r.totalChunks} data, ${r.parityChunksFound} parity`],
      ['missing', r.totalChunks === 0 ? 'unknown, nothing decoded' : r.missing.length === 0 ? 'none' : r.missing.join(', ')],
      ['verdict', r.recoverable ? 'file is recoverable' : `not recoverable: ${r.reason}`],
    ];
    for (const [label, value] of rows) console.log(`${label.padEnd(9)} ${value}`);
    return;
  }

  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
