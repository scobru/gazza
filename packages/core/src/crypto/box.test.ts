import test from 'node:test';
import assert from 'node:assert/strict';
import { SEALED_FILE_NAME, isSealed, open, seal } from './box';

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

const CONTENTS = {
  data: randomBytes(5000, 2),
  fileName: 'bilancio 2026.pdf',
  mimeType: 'application/pdf',
};

test('a sealed file comes back whole, name and type included', async () => {
  const sealed = await seal(CONTENTS, 'correct horse battery staple');
  const opened = await open(sealed, 'correct horse battery staple');

  assert.deepEqual(opened.data, CONTENTS.data);
  assert.equal(opened.fileName, CONTENTS.fileName);
  assert.equal(opened.mimeType, CONTENTS.mimeType);
});

test('the wrong password yields nothing, not partial plaintext', async () => {
  const sealed = await seal(CONTENTS, 'right');
  await assert.rejects(() => open(sealed, 'wrong'), /Wrong password/);
});

test('a tampered container is refused', async () => {
  const sealed = await seal(CONTENTS, 'pw');
  sealed[sealed.length - 20] ^= 0x01;
  await assert.rejects(() => open(sealed, 'pw'), /Wrong password, or the sealed payload was tampered/);
});

test('the file name is nowhere in the sealed bytes', async () => {
  const sealed = await seal(CONTENTS, 'pw');
  const haystack = Buffer.from(sealed).toString('latin1');

  assert.equal(haystack.includes('bilancio'), false, 'file name leaked');
  assert.equal(haystack.includes('application/pdf'), false, 'mime type leaked');
  // The placeholder is what the chunk headers carry instead.
  assert.equal(SEALED_FILE_NAME, 'sealed.dbfa');
});

test('sealing twice gives unrelated carriers', async () => {
  const a = await seal(CONTENTS, 'pw');
  const b = await seal(CONTENTS, 'pw');

  assert.equal(a.length, b.length);
  assert.notDeepEqual(a, b, 'a fresh salt and nonce should make these differ');
  // Both still open.
  assert.deepEqual((await open(a, 'pw')).data, CONTENTS.data);
  assert.deepEqual((await open(b, 'pw')).data, CONTENTS.data);
});

test('sealed payloads are recognisable, plain ones are not', async () => {
  assert.equal(isSealed(await seal(CONTENTS, 'pw')), true);
  assert.equal(isSealed(CONTENTS.data), false);
  assert.equal(isSealed(new Uint8Array(0)), false);
  assert.equal(isSealed(new Uint8Array([0x44, 0x42])), false);
});

test('an empty file seals and opens', async () => {
  const empty = { data: new Uint8Array(0), fileName: 'x', mimeType: 'text/plain' };
  const opened = await open(await seal(empty, 'pw'), 'pw');
  assert.deepEqual(opened.data, new Uint8Array(0));
  assert.equal(opened.fileName, 'x');
});

test('an empty password is refused rather than silently weak', async () => {
  await assert.rejects(() => seal(CONTENTS, ''), /must not be empty/);
});

test('a plain file is not mistaken for a sealed one', async () => {
  await assert.rejects(() => open(CONTENTS.data, 'pw'), /Not a sealed payload/);
});
