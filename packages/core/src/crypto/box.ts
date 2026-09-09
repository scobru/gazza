/**
 * Encrypt a file before it becomes chunks, so a carrier on a public platform
 * gives up nothing to whoever finds it - not the bytes, not the file name, not
 * even the type.
 *
 * The sealed container holds the original name and MIME type inside the
 * ciphertext, so the chunk headers can carry a placeholder. That hides the
 * metadata without a second header format: the decoder learns what the file
 * was called only after the password checks out.
 */

const MAGIC = new Uint8Array([0x44, 0x42, 0x46, 0x41, 0x45, 0x31]); // "DBFAE1"
const SALT_BYTES = 16;
const IV_BYTES = 12;

/**
 * PBKDF2 rounds. Deliberately expensive: a carrier can be downloaded by anyone
 * and attacked offline for as long as they like, so the only defence is making
 * each guess cost.
 */
export const KDF_ITERATIONS = 600_000;

/** What the chunk headers say when the payload is sealed. */
export const SEALED_FILE_NAME = 'sealed.dbfa';
export const SEALED_MIME_TYPE = 'application/octet-stream';

export interface SealedContents {
  data: Uint8Array;
  fileName: string;
  mimeType: string;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** True when these bytes are a sealed container rather than a plain file. */
export function isSealed(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  return MAGIC.every((byte, i) => bytes[i] === byte);
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    utf8.encode(password) as unknown as ArrayBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** name and type live inside the ciphertext, length-prefixed ahead of the data. */
function pack(contents: SealedContents): Uint8Array {
  const name = utf8.encode(contents.fileName);
  const mime = utf8.encode(contents.mimeType);
  const out = new Uint8Array(4 + name.length + mime.length + contents.data.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, name.length);
  view.setUint16(2, mime.length);
  out.set(name, 4);
  out.set(mime, 4 + name.length);
  out.set(contents.data, 4 + name.length + mime.length);
  return out;
}

function unpack(bytes: Uint8Array): SealedContents {
  if (bytes.length < 4) throw new Error('Sealed payload is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = view.getUint16(0);
  const mimeLength = view.getUint16(2);
  if (bytes.length < 4 + nameLength + mimeLength) throw new Error('Sealed payload is truncated');

  return {
    fileName: utf8Decoder.decode(bytes.subarray(4, 4 + nameLength)),
    mimeType: utf8Decoder.decode(bytes.subarray(4 + nameLength, 4 + nameLength + mimeLength)),
    data: bytes.slice(4 + nameLength + mimeLength),
  };
}

/**
 * file -> sealed container: magic, salt, nonce, then AES-256-GCM ciphertext.
 * A fresh salt and nonce every time, so sealing the same file twice with the
 * same password produces unrelated carriers.
 */
export async function seal(contents: SealedContents, password: string): Promise<Uint8Array> {
  if (password.length === 0) throw new Error('Password must not be empty');

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const packed = pack(contents);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
      key,
      packed as unknown as ArrayBuffer
    )
  );

  const out = new Uint8Array(MAGIC.length + SALT_BYTES + IV_BYTES + ciphertext.length);
  out.set(MAGIC);
  out.set(salt, MAGIC.length);
  out.set(iv, MAGIC.length + SALT_BYTES);
  out.set(ciphertext, MAGIC.length + SALT_BYTES + IV_BYTES);
  return out;
}

/**
 * sealed container -> file. GCM authenticates, so a wrong password and tampered
 * bytes fail the same way: nothing comes out. Never returns partial plaintext.
 */
export async function open(sealed: Uint8Array, password: string): Promise<SealedContents> {
  if (!isSealed(sealed)) throw new Error('Not a sealed payload');

  const headerSize = MAGIC.length + SALT_BYTES + IV_BYTES;
  if (sealed.length <= headerSize) throw new Error('Sealed container is truncated');

  const salt = sealed.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = sealed.subarray(MAGIC.length + SALT_BYTES, headerSize);
  const key = await deriveKey(password, salt);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
      key,
      sealed.slice(headerSize) as unknown as ArrayBuffer
    );
  } catch {
    throw new Error('Wrong password, or the sealed payload was tampered with');
  }

  return unpack(new Uint8Array(plaintext));
}
