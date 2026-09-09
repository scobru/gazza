import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleFile, chunkFile } from '../codec/chunk';
import { EncodedChunk } from '../codec/types';
import { DEFAULT_PARITY, buildParityChunks, recoverDataChunks } from './groups';

const OPTS = { fileName: 'payload.bin', mimeType: 'application/octet-stream', payloadSize: 100 };

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

/** A file of `chunks` chunks, the last one deliberately short. */
async function makeFile(chunks: number, seed = 1) {
  const data = randomBytes((chunks - 1) * OPTS.payloadSize + 37, seed);
  const dataChunks = await chunkFile(data, OPTS);
  assert.equal(dataChunks.length, chunks);
  return { data, dataChunks, parity: buildParityChunks(dataChunks) };
}

const drop = (chunks: EncodedChunk[], indices: number[]): EncodedChunk[] =>
  chunks.filter((c) => !(c.header.kind === 'data' && indices.includes(c.header.chunkIndex)));

test('parity chunks are added at a fixed cost per group', async () => {
  const { dataChunks, parity } = await makeFile(40);
  const groups = Math.ceil(40 / DEFAULT_PARITY.dataPerGroup);
  assert.equal(parity.length, groups * DEFAULT_PARITY.parityPerGroup);
  assert.ok(parity.every((c) => c.header.kind === 'parity'));
  // Parity indices continue past the data chunks, so nothing collides.
  const dataIndices = new Set(dataChunks.map((c) => c.header.chunkIndex));
  assert.ok(parity.every((c) => !dataIndices.has(c.header.chunkIndex)));
});

test('a complete file passes straight through', async () => {
  const { data, dataChunks, parity } = await makeFile(20);
  const result = recoverDataChunks([...dataChunks, ...parity]);
  assert.deepEqual(result.recovered, []);
  assert.deepEqual(await assembleFile(result.chunks), data);
});

test('rebuilds the maximum number of losses a group can absorb', async () => {
  const { data, dataChunks, parity } = await makeFile(20, 2);
  // First group holds chunks 0..15; lose four of them, the parity limit.
  const lost = [1, 4, 9, 15];
  const result = recoverDataChunks(drop([...dataChunks, ...parity], lost));
  assert.deepEqual(result.recovered, lost);
  assert.deepEqual(await assembleFile(result.chunks), data);
});

test('rebuilds a short final chunk, length and all', async () => {
  const { data, dataChunks, parity } = await makeFile(20, 3);
  const lastIndex = dataChunks.length - 1;
  const result = recoverDataChunks(drop([...dataChunks, ...parity], [lastIndex]));

  assert.deepEqual(result.recovered, [lastIndex]);
  const rebuilt = result.chunks.find((c) => c.header.chunkIndex === lastIndex)!;
  assert.equal(rebuilt.payload.length, 37);
  assert.deepEqual(await assembleFile(result.chunks), data);
});

test('losing parity chunks costs nothing while the data is intact', async () => {
  const { data, dataChunks, parity } = await makeFile(20, 4);
  const result = recoverDataChunks([...dataChunks, ...parity.slice(2)]);
  assert.deepEqual(result.recovered, []);
  assert.deepEqual(await assembleFile(result.chunks), data);
});

test('losses spread across groups are repaired independently', async () => {
  const { data, dataChunks, parity } = await makeFile(40, 5);
  const lost = [2, 7, 20, 33, 39]; // group 0, group 1 and group 2
  const result = recoverDataChunks(drop([...dataChunks, ...parity], lost));
  assert.deepEqual(result.recovered, lost);
  assert.deepEqual(await assembleFile(result.chunks), data);
});

test('one loss too many is reported, not silently patched', async () => {
  const { dataChunks, parity } = await makeFile(20, 6);
  const lost = [0, 1, 2, 3, 4]; // five gone from a group carrying four parity chunks
  assert.throws(
    () => recoverDataChunks(drop([...dataChunks, ...parity], lost)),
    /Cannot rebuild chunks 0, 1, 2, 3, 4/
  );
});

test('a missing chunk with no parity at all is reported', async () => {
  const { dataChunks } = await makeFile(20, 7);
  assert.throws(() => recoverDataChunks(drop(dataChunks, [5])), /Cannot rebuild chunks 5/);
});

test('more parity per group buys more tolerance', async () => {
  const data = randomBytes(16 * OPTS.payloadSize, 8);
  const dataChunks = await chunkFile(data, OPTS);
  const parity = buildParityChunks(dataChunks, { parityPerGroup: 8 });

  const lost = [0, 2, 4, 6, 8, 10, 12, 14];
  const result = recoverDataChunks(drop([...dataChunks, ...parity], lost));
  assert.deepEqual(result.recovered, lost);
  assert.deepEqual(await assembleFile(result.chunks), data);
});

test('a single chunk file is still protected', async () => {
  const data = randomBytes(50, 9);
  const dataChunks = await chunkFile(data, OPTS);
  const parity = buildParityChunks(dataChunks);
  const result = recoverDataChunks(drop([...dataChunks, ...parity], [0]));
  assert.deepEqual(result.recovered, [0]);
  assert.deepEqual(await assembleFile(result.chunks), data);
});

test('every loss pattern a group can absorb is actually recoverable', async () => {
  // Erasure decoding inverts whichever rows survived, so the generator matrix
  // must be invertible for EVERY subset of rows, not just as a whole. A
  // Vandermonde matrix is not: it fails on particular combinations of missing
  // columns, with the parity sitting right there. Only an exhaustive sweep
  // finds those, which is why this walks all 2516 patterns of up to 4 losses.
  const { dataChunks, parity } = await makeFile(16, 21);
  const all = [...dataChunks, ...parity];
  const expected = dataChunks.map((c) => c.payload);

  let checked = 0;
  const sweep = (lost: number[], next: number) => {
    if (lost.length > 0) {
      const result = recoverDataChunks(drop(all, lost));
      for (let i = 0; i < expected.length; i++) {
        assert.deepEqual(result.chunks[i].payload, expected[i], `lost ${lost.join(',')} chunk ${i}`);
      }
      checked++;
    }
    if (lost.length === DEFAULT_PARITY.parityPerGroup) return;
    for (let i = next; i < 16; i++) sweep([...lost, i], i + 1);
  };
  sweep([], 0);

  assert.equal(checked, 2516);
});

test('scattered losses recover as well as contiguous ones', async () => {
  const { data, dataChunks, parity } = await makeFile(16, 22);
  const patterns = [
    [0, 5, 10, 15],
    [1, 2, 13, 14],
    [0, 1, 2, 3],
    [12, 13, 14, 15],
    [3, 6, 9, 12],
    [0, 15],
    [7],
  ];

  for (const indices of patterns) {
    const result = recoverDataChunks(drop([...dataChunks, ...parity], indices));
    assert.deepEqual(result.recovered, indices, `pattern ${indices.join(',')}`);
    assert.deepEqual(await assembleFile(result.chunks), data);
  }
});

test('recovery works when parity chunks are missing too', async () => {
  const { data, dataChunks, parity } = await makeFile(16, 23);
  // Two data chunks and two parity chunks gone: two survivors, two holes.
  const survivors = [...drop(dataChunks, [4, 9]), ...parity.slice(2)];
  const result = recoverDataChunks(survivors);
  assert.deepEqual(result.recovered, [4, 9]);
  assert.deepEqual(await assembleFile(result.chunks), data);
});
