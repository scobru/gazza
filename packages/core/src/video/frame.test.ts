import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoProfile } from '../codec/types';
import { PALETTE_4, PALETTE_6, PALETTE_8 } from '../palette/colors';
import { calibratePalette, frameGeometry, readFrame, renderFrame } from './frame';

function profile(overrides: Partial<VideoProfile> = {}): VideoProfile {
  return {
    platform: 'custom',
    width: 320,
    height: 180,
    fps: 15,
    repeatFrames: 3,
    cellSize: 8,
    palette: PALETTE_8,
    ...overrides,
  };
}

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

/** What a lossy re-encode does: soften edges, shift levels, tint, add noise. */
function degrade(pixels: Uint8Array, p: VideoProfile, seed = 7): Uint8Array {
  let s = seed >>> 0 || 1;
  const noise = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return ((s & 0xff) / 255 - 0.5) * 24;
  };
  const tint = [1.06, 0.97, 0.92];
  const out = new Uint8Array(pixels.length);

  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= p.height || xx >= p.width) continue;
            sum += pixels[(yy * p.width + xx) * 3 + c];
            n++;
          }
        }
        // blur, squeeze contrast, tint the channel, then add noise
        const v = ((sum / n) * 0.8 + 24) * tint[c] + noise();
        out[(y * p.width + x) * 3 + c] = Math.max(0, Math.min(255, v | 0));
      }
    }
  }
  return out;
}

test('geometry reserves the calibration rows and reports whole bytes', () => {
  const geo = frameGeometry(profile());
  assert.equal(geo.cols, 40);
  assert.equal(geo.rows, 22);
  assert.equal(geo.bitsPerCell, 3);
  assert.equal(geo.dataCells, 20 * 40);
  assert.equal(geo.symbolCapacity % 2, 0);
  assert.equal(geo.capacityBytes, geo.symbolCapacity / 2);
});

test('a smaller palette carries fewer bits per cell', () => {
  assert.equal(frameGeometry(profile({ palette: PALETTE_4 })).bitsPerCell, 2);
  assert.ok(
    frameGeometry(profile({ palette: PALETTE_4 })).capacityBytes <
      frameGeometry(profile({ palette: PALETTE_8 })).capacityBytes
  );
});

test('a non-power-of-two palette is refused, not silently truncated', () => {
  assert.throws(() => frameGeometry(profile({ palette: PALETTE_6 })), /power of two/);
});

test('clean frame round trip returns the payload', () => {
  const p = profile();
  const payload = randomBytes(frameGeometry(p).capacityBytes, 2);
  const { bytes, corrections } = readFrame(renderFrame(payload, p), p);
  assert.deepEqual(bytes, payload);
  assert.equal(corrections, 0);
});

test('round trip survives blur, contrast loss, colour tint and noise', () => {
  const p = profile();
  const payload = randomBytes(frameGeometry(p).capacityBytes, 3);
  const { bytes } = readFrame(degrade(renderFrame(payload, p), p), p);
  assert.deepEqual(bytes, payload);
});

test('the 4-colour palette survives the same degradation', () => {
  const p = profile({ palette: PALETTE_4 });
  const payload = randomBytes(frameGeometry(p).capacityBytes, 4);
  const { bytes } = readFrame(degrade(renderFrame(payload, p), p), p);
  assert.deepEqual(bytes, payload);
});

test('calibration recovers the drifted palette, not the nominal one', () => {
  const p = profile();
  const drifted = calibratePalette(degrade(renderFrame(randomBytes(50), p), p), p);
  assert.equal(drifted.length, PALETTE_8.length);
  const movedChannels = drifted.flatMap((c, i) => c.map((v, j) => Math.abs(v - PALETTE_8[i][j])));
  assert.ok(Math.max(...movedChannels) > 5, 'expected the measured palette to differ from the nominal one');
});

test('interleaving lets Hamming absorb a burst of miscoloured cells', () => {
  // The realistic failure: one compression block ruins a run of neighbouring
  // cells. Interleaving sends those bits to consecutive - so distinct - symbols,
  // leaving Hamming one repairable bit each.
  const p = profile();
  const geo = frameGeometry(p);
  const payload = randomBytes(geo.capacityBytes, 5);
  const pixels = renderFrame(payload, p);

  const wrong = PALETTE_8[5];
  const row = 6;
  for (let col = 4; col < 12; col++) {
    const x0 = geo.originX + col * p.cellSize;
    const y0 = geo.originY + row * p.cellSize;
    for (let y = y0; y < y0 + p.cellSize; y++) {
      for (let x = x0; x < x0 + p.cellSize; x++) {
        const o = (y * p.width + x) * 3;
        pixels[o] = wrong[0];
        pixels[o + 1] = wrong[1];
        pixels[o + 2] = wrong[2];
      }
    }
  }

  const { bytes, corrections } = readFrame(pixels, p);
  assert.ok(corrections > 0, 'expected Hamming to have repaired something');
  assert.deepEqual(bytes, payload);
});

test('an oversized payload is refused', () => {
  const p = profile();
  const tooBig = randomBytes(frameGeometry(p).capacityBytes + 1);
  assert.throws(() => renderFrame(tooBig, p), /exceeds frame capacity/);
});

test('a short payload is zero padded and still readable', () => {
  const p = profile();
  const payload = randomBytes(10, 6);
  const { bytes } = readFrame(renderFrame(payload, p), p);
  assert.deepEqual(bytes.slice(0, 10), payload);
  assert.ok(bytes.slice(10).every((b) => b === 0));
});
