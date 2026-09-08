import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleFile, chunkFile, parseChunk, serializeChunk, sha256Hex } from './chunk';

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

const OPTS = { fileName: 'hôtel-piñata.pdf', mimeType: 'application/pdf', payloadSize: 700 };

test('chunk survives a serialize/parse round trip', async () => {
  const [chunk] = await chunkFile(randomBytes(500), OPTS);
  const parsed = parseChunk(serializeChunk(chunk));
  assert.deepEqual(parsed.header, chunk.header);
  assert.deepEqual(parsed.payload, chunk.payload);
});

test('non-ASCII names and parity fields round trip', async () => {
  const [base] = await chunkFile(randomBytes(10), OPTS);
  const chunk = {
    header: { ...base.header, kind: 'parity' as const, parityGroupId: 7, parityMembers: [0, 1, 2, 9] },
    payload: base.payload,
  };
  const parsed = parseChunk(serializeChunk(chunk));
  assert.equal(parsed.header.fileName, 'hôtel-piñata.pdf');
  assert.equal(parsed.header.kind, 'parity');
  assert.equal(parsed.header.parityGroupId, 7);
  assert.deepEqual(parsed.header.parityMembers, [0, 1, 2, 9]);
});

test('a chunk with no parity group omits both parity fields', async () => {
  const [chunk] = await chunkFile(randomBytes(10), OPTS);
  const parsed = parseChunk(serializeChunk(chunk));
  assert.equal('parityGroupId' in parsed.header, false);
  assert.equal('parityMembers' in parsed.header, false);
});

test('file splits and reassembles byte for byte', async () => {
  const data = randomBytes(5000, 3);
  const chunks = await chunkFile(data, OPTS);
  assert.equal(chunks.length, 8); // 5000 / 700 rounded up
  assert.equal(chunks.at(-1)!.payload.length, 5000 - 7 * 700);

  const shuffled = [...chunks].reverse();
  const wire = shuffled.map(serializeChunk).map(parseChunk);
  assert.deepEqual(await assembleFile(wire), data);
});

test('an empty file still produces one chunk', async () => {
  const chunks = await chunkFile(new Uint8Array(0), OPTS);
  assert.equal(chunks.length, 1);
  assert.deepEqual(await assembleFile(chunks), new Uint8Array(0));
});

test('a flipped payload byte is rejected, not returned', async () => {
  const [chunk] = await chunkFile(randomBytes(200), OPTS);
  const wire = serializeChunk(chunk);
  wire[wire.length - 1] ^= 0x01;
  assert.throws(() => parseChunk(wire), /Payload CRC mismatch/);
});

test('a flipped header byte is rejected before the payload is trusted', async () => {
  const [chunk] = await chunkFile(randomBytes(200), OPTS);
  const wire = serializeChunk(chunk);
  wire[16] ^= 0x40; // totalChunks
  assert.throws(() => parseChunk(wire), /Header CRC mismatch/);
});

test('foreign bytes are rejected by magic', () => {
  assert.throws(() => parseChunk(randomBytes(200, 9)), /Bad magic|Chunk truncated/);
});

test('a missing chunk is reported by index', async () => {
  const chunks = await chunkFile(randomBytes(2000), OPTS);
  await assert.rejects(() => assembleFile(chunks.filter((c) => c.header.chunkIndex !== 1)), /Missing chunks: 1/);
});

test('chunks from two different files never assemble together', async () => {
  const a = await chunkFile(randomBytes(1000, 4), OPTS);
  const b = await chunkFile(randomBytes(1000, 5), OPTS);
  await assert.rejects(() => assembleFile([a[0], b[1]]), /different files/);
});

test('sha256 matches the known digest of an empty input', async () => {
  assert.equal(
    await sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
});
