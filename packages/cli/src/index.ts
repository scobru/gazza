#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { SEALED_FILE_NAME, SEALED_MIME_TYPE, isSealed, open as unseal, profileFor, seal } from '@gazza/core';
import {
  decodeVideos,
  downloadVideo,
  encodeFileToVideo,
  inspectVideo,
  maxPayloadFor,
  payloadSizeFor,
} from './pipeline';

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.json': 'application/json',
};

const USAGE = `gazza - the magpie that hides your files in video

  gazza encode  <file> <out.mp4>       [--platform ...] [--encrypt] [--split 60]

--platform picks the geometry: youtube, instagram, telegram or whatsapp. Encode
and decode must use the same one.
  gazza decode  <video|url>... [--out file] [--platform ...] [--crop auto|w:h:x:y]
  gazza inspect <video|url>            [--platform ...] [--crop auto|w:h:x:y]

--split <seconds> cuts the carrier into several videos of at most that length,
named carrier-001.mp4, carrier-002.mp4 and so on. Pass them all back to decode
in any order: no manifest is needed, the chunks identify themselves.

--encrypt seals the file with AES-256-GCM before it becomes chunks, hiding the
contents, the file name and the type. The password is asked for on the
terminal, never passed as an argument where the shell history and the process
list would keep it; set GAZZA_PASSWORD to script it. Decoding a sealed
carrier asks for it again. Lose the password and the file is gone.

--stream <id> forces one yt-dlp format instead of the best rendition, e.g.
--stream 399 to read YouTube's AV1 rendition rather than its h264 one.

--crop auto finds the grid inside a larger frame: a screen recording of a
player, letterboxing, anything that does not fill the frame edge to edge.

decode and inspect accept a URL and fetch it with yt-dlp. Add
--cookies-from-browser chrome (or edge, firefox) when YouTube refuses an
anonymous request, which it does for unlisted videos and under rate limiting.
Default: youtube.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Flags that stand alone; every other --flag consumes the argument after it. */
const BOOLEAN_FLAGS = new Set(['--encrypt']);

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) out.push(args[i]);
    else if (!BOOLEAN_FLAGS.has(args[i])) i++;
  }
  return out;
}

/**
 * Read a password without echoing it. Environment first so scripts have a way
 * in that does not involve the command line, where the shell history and the
 * process list would both keep a copy.
 */
function askPassword(prompt: string): Promise<string> {
  const fromEnvironment = process.env.GAZZA_PASSWORD;
  if (fromEnvironment) return Promise.resolve(fromEnvironment);
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error('No terminal to ask for a password on; set GAZZA_PASSWORD'));
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // Print the prompt, swallow everything typed after it.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (chunk: string) => {
      if (chunk.startsWith(prompt)) process.stderr.write(prompt);
    };
    rl.question(prompt, (answer) => {
      process.stderr.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** Run `body` on local paths, fetching any URLs into a temp directory first. */
async function withVideos<T>(
  sources: string[],
  browser: string | undefined,
  format: string | undefined,
  body: (paths: string[]) => Promise<T>
): Promise<T> {
  if (!sources.some(isUrl)) return body(sources);

  const directory = await mkdtemp(join(tmpdir(), 'gazza-'));
  try {
    const paths: string[] = [];
    for (const [i, source] of sources.entries()) {
      if (!isUrl(source)) {
        paths.push(source);
        continue;
      }
      const into = join(directory, String(i));
      await mkdir(into, { recursive: true });
      paths.push(await downloadVideo(source, into, browser, format));
    }
    return await body(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const withVideo = <T,>(
  source: string,
  browser: string | undefined,
  format: string | undefined,
  body: (path: string) => Promise<T>
): Promise<T> => withVideos([source], browser, format, (paths) => body(paths[0]));

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = positional(rest);
  const profile = profileFor(flag(rest, 'platform') ?? 'youtube');
  const browser = flag(rest, 'cookies-from-browser');
  // Force one specific stream, e.g. --stream 399 for YouTube's AV1 rendition.
  const stream = flag(rest, 'stream');

  if (command === 'encode') {
    const [input, output] = args;
    if (!input || !output) throw new Error(USAGE);

    let data = new Uint8Array(await readFile(input));
    let fileName = basename(input);
    let mimeType = MIME_BY_EXT[extname(input).toLowerCase()] ?? 'application/octet-stream';

    if (rest.includes('--encrypt')) {
      const password = await askPassword('Password: ');
      if (!process.env.GAZZA_PASSWORD) {
        // A typo here would be unrecoverable: nothing else knows the key.
        if ((await askPassword('Repeat: ')) !== password) throw new Error('Passwords do not match');
      }
      data = new Uint8Array(await seal({ data, fileName, mimeType }, password));
      fileName = SEALED_FILE_NAME;
      mimeType = SEALED_MIME_TYPE;
      process.stderr.write('sealed: contents, file name and type are all encrypted\n');
    }

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
        `${result.frames} frames (${(result.frames / profile.fps).toFixed(1)} s)`
    );
    for (const part of result.parts) console.log(`  ${part}`);
    return;
  }

  if (command === 'decode') {
    // With --out every positional is an input; without it the old shape holds,
    // one input and an optional output.
    const explicitOut = flag(rest, 'out');
    const inputs = explicitOut ? args : args.slice(0, 1);
    const output = explicitOut ?? args[1];
    if (inputs.length === 0) throw new Error(USAGE);

    const result = await withVideos(inputs, browser, stream, (paths) =>
      decodeVideos(paths, profile, {
        crop: flag(rest, 'crop'),
        onProgress: ({ completed, total }) =>
          process.stderr.write(`\rrecovered chunk ${completed}/${total}`),
      })
    );

    let payload = result.data;
    let name = result.header.fileName;
    if (isSealed(payload)) {
      const opened = await unseal(payload, await askPassword('Password: '));
      payload = opened.data;
      name = opened.fileName;
    }

    const target = output ?? name;
    await writeFile(target, payload);

    process.stderr.write('\r');
    const rebuilt = result.recovered.length > 0 ? `, ${result.recovered.length} rebuilt from parity` : '';
    console.log(
      `${target}: ${payload.length} B recovered from ${result.framesRead} frames ` +
        `(${result.framesRejected} unreadable${rebuilt})`
    );
    return;
  }

  if (command === 'inspect') {
    const [input] = args;
    if (!input) throw new Error(USAGE);

    const r = await withVideo(input, browser, stream, (path) =>
      inspectVideo(path, profile, { crop: flag(rest, 'crop') })
    );
    const rows: [string, string][] = [];
    if (r.crop) rows.push(['crop', `${r.crop} (grid did not fill the frame)`]);
    if (r.source) {
      const mbps = r.source.bitRate / 1_000_000;
      // Our own encoder writes around 30 Mbps. Anything near that was never
      // re-encoded by a platform, whatever the file name says.
      const note = mbps > 20 ? ' - looks untouched, no platform re-encoded this' : '';
      rows.push([
        'source',
        `${r.source.width}x${r.source.height} ${r.source.codec}, ${mbps.toFixed(1)} Mbps${note}`,
      ]);
    }
    rows.push(
      ['frames', `${r.framesRead} read, ${r.framesReadable} readable`],
      ['hamming', `${r.correctionsAverage.toFixed(1)} corrections/frame average, ${r.correctionsMax} worst`],
      ['chunks', `${r.dataChunksFound}/${r.totalChunks} data, ${r.parityChunksFound} parity`],
      ['missing', r.totalChunks === 0 ? 'unknown, nothing decoded' : r.missing.length === 0 ? 'none' : r.missing.join(', ')],
      ['verdict', r.recoverable ? 'file is recoverable' : `not recoverable: ${r.reason}`]
    );
    for (const [label, value] of rows) console.log(`${label.padEnd(9)} ${value}`);
    return;
  }

  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
