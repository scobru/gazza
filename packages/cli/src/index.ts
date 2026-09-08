#!/usr/bin/env node
import { basename, extname } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { profileFor } from '@dbforall/core';
import { decodeVideoFile, encodeFileToVideo, payloadSizeFor } from './pipeline';

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

  dbforall encode <file> <out.mp4> [--platform youtube|instagram] [--crf 14]
  dbforall decode <video> [out-file]  [--platform youtube|instagram]

Encode and decode must use the same platform profile (default: youtube).
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const positional = (args: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) i++;
    else out.push(args[i]);
  }
  return out;
};

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = positional(rest);
  const profile = profileFor(flag(rest, 'platform') ?? 'youtube');

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

    const perChunk = payloadSizeFor(profile, fileName, mimeType);
    process.stderr.write('\r');
    console.log(
      `${result.payloadBytes} B -> ${result.chunks} chunks of ${perChunk} B -> ` +
        `${result.frames} frames (${(result.frames / profile.fps).toFixed(1)} s) -> ${result.outputPath}`
    );
    return;
  }

  if (command === 'decode') {
    const [input, output] = args;
    if (!input) throw new Error(USAGE);

    const result = await decodeVideoFile(input, profile, ({ completed, total }) =>
      process.stderr.write(`\rrecovered chunk ${completed}/${total}`)
    );
    const target = output ?? result.header.fileName;
    await writeFile(target, result.data);

    process.stderr.write('\r');
    console.log(
      `${target}: ${result.data.length} B recovered from ${result.framesRead} frames ` +
        `(${result.framesRejected} unreadable)`
    );
    return;
  }

  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
