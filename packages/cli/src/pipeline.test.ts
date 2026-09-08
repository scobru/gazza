import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoProfile } from '@dbforall/core';
import { PALETTE_8 } from '@dbforall/core';
import { decodeVideoFile, encodeFileToVideo, inspectVideo, payloadSizeFor } from './pipeline';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** 640x360 keeps the round trip a few seconds instead of a few minutes. */
const PROFILE: VideoProfile = {
  platform: 'custom',
  width: 640,
  height: 360,
  fps: 30,
  repeatFrames: 2,
  cellSize: 8,
  palette: PALETTE_8,
};

function randomBytes(n: number, seed = 1): Uint8Array {
  let s = seed >>> 0 || 1;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    b[i] = s & 0xff;
  }
  return b;
}

let dir = '';
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbforall-'));
});
test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('payload size leaves room for the chunk header', () => {
  const size = payloadSizeFor(PROFILE, 'report.pdf', 'application/pdf');
  assert.ok(size > 0);
  // A longer file name eats into the payload, byte for byte.
  const longer = payloadSizeFor(PROFILE, 'report-final-v2.pdf', 'application/pdf');
  assert.equal(size - longer, 'report-final-v2.pdf'.length - 'report.pdf'.length);
});

test('a frame too small for a header is refused with a clear message', () => {
  assert.throws(
    () => payloadSizeFor({ ...PROFILE, width: 96, height: 96, cellSize: 8 }, 'x.bin', 'application/octet-stream'),
    /widest chunk header needs/
  );
});

test('round trip through a real mp4', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const data = randomBytes(40000, 2);
  const video = join(dir, 'carrier.mp4');

  const encoded = await encodeFileToVideo(data, video, {
    fileName: 'payload.bin',
    mimeType: 'application/octet-stream',
    profile: PROFILE,
  });
  assert.ok(encoded.parityChunks > 0, 'parity should be on by default');
  assert.equal(encoded.frames, (encoded.chunks + encoded.parityChunks) * PROFILE.repeatFrames);

  const decoded = await decodeVideoFile(video, PROFILE);
  assert.deepEqual(decoded.data, data);
  assert.equal(decoded.header.fileName, 'payload.bin');
  assert.equal(decoded.header.mimeType, 'application/octet-stream');
});

test('round trip survives a VP9 transcode at a fraction of the bitrate', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const data = randomBytes(20000, 3);
  const video = join(dir, 'carrier2.mp4');
  const transcoded = join(dir, 'platform.webm');

  await encodeFileToVideo(data, video, {
    fileName: 'payload.bin',
    mimeType: 'application/octet-stream',
    profile: PROFILE,
  });

  // Roughly what a platform does to an upload: different codec, capped bitrate.
  const result = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', video,
    '-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'good', '-cpu-used', '4',
    transcoded,
  ]);
  assert.equal(result.status, 0, result.stderr?.toString());

  const decoded = await decodeVideoFile(transcoded, PROFILE);
  assert.deepEqual(decoded.data, data);
});

test('parity rebuilds chunks whose frames were cut out of the video', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const data = randomBytes(20000, 7);
  const video = join(dir, 'cut-source.mp4');
  const cut = join(dir, 'cut.mp4');

  await encodeFileToVideo(data, video, {
    fileName: 'payload.bin',
    mimeType: 'application/octet-stream',
    profile: PROFILE,
  });

  // Cut the first six frames off: three chunks vanish, both copies with them.
  const result = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', video,
    '-vf', 'trim=start_frame=6,setpts=PTS-STARTPTS',
    '-c:v', 'libx264', '-crf', '14', '-g', '1', '-pix_fmt', 'yuv420p', cut,
  ]);
  assert.equal(result.status, 0, result.stderr?.toString());

  const decoded = await decodeVideoFile(cut, PROFILE);
  assert.ok(decoded.recovered.length > 0, 'expected parity to have rebuilt something');
  assert.deepEqual(decoded.data, data);
});

test('decoding with the wrong geometry fails loudly', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const video = join(dir, 'carrier3.mp4');
  await encodeFileToVideo(randomBytes(3000, 4), video, {
    fileName: 'payload.bin',
    mimeType: 'application/octet-stream',
    profile: PROFILE,
  });

  await assert.rejects(
    () => decodeVideoFile(video, { ...PROFILE, cellSize: 16 }),
    /No readable chunk/
  );
});

test('inspect reports margin on a healthy video', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const video = join(dir, 'inspect.mp4');
  const encoded = await encodeFileToVideo(randomBytes(9000, 11), video, {
    fileName: 'payload.bin',
    mimeType: 'application/octet-stream',
    profile: PROFILE,
  });

  const report = await inspectVideo(video, PROFILE);
  assert.equal(report.framesRead, report.framesReadable);
  assert.equal(report.dataChunksFound, encoded.chunks);
  assert.equal(report.parityChunksFound, encoded.parityChunks);
  assert.deepEqual(report.missing, []);
  assert.equal(report.recoverable, true);
});

test('inspect names the chunks that went missing', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const video = join(dir, 'inspect-cut.mp4');
  const cut = join(dir, 'inspect-cut-trimmed.mp4');
  await encodeFileToVideo(randomBytes(9000, 12), video, {
    fileName: 'payload.bin',
    mimeType: 'application/octet-stream',
    profile: PROFILE,
  });

  // Drop enough frames that parity cannot cover the hole.
  const result = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', video,
    '-vf', 'trim=start_frame=14,setpts=PTS-STARTPTS',
    '-c:v', 'libx264', '-crf', '14', '-g', '1', '-pix_fmt', 'yuv420p', cut,
  ]);
  assert.equal(result.status, 0, result.stderr?.toString());

  const report = await inspectVideo(cut, PROFILE);
  assert.deepEqual(report.missing, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(report.recoverable, false);
  assert.match(report.reason ?? '', /too many lost in one parity group/);
});
