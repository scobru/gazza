import { crc32 } from './crc32';
import { ChunkHeader, ChunkKind, EncodedChunk } from './types';

export const CHUNK_MAGIC = 0x44424641; // "DBFA"
export const CHUNK_VERSION = 2;

/** Sentinels written when a chunk takes no part in a parity group. */
const NO_PARITY_GROUP = 0xffffffff;
const NO_PARITY_INDEX = 0xffff;

const KIND_TO_CODE: Record<ChunkKind, number> = { data: 0, parity: 1, cover: 2 };
const CODE_TO_KIND: ChunkKind[] = ['data', 'parity', 'cover'];

/*
 * Fixed part of the header, big-endian:
 *
 *   0  4  magic                     28  4  parityGroupId (0xffffffff = none)
 *   4  1  version                   32  8  fileSize
 *   5  1  kind                      40 32  fileSha256 (raw)
 *   6  2  fileName byte length      72  2  parityIndex (0xffff = none)
 *   8  2  mimeType byte length      74  .. fileName, mimeType, parityMembers
 *  10  2  parityMembers count       ..  4  headerCrc (crc32 of everything above)
 *  12  4  chunkIndex
 *  16  4  totalChunks
 *  20  4  payloadLength
 *  24  4  chunkCrc (crc32 of the payload)
 */
const FIXED_SIZE = 74;
const HEADER_CRC_SIZE = 4;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

function hexToBytes(hex: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (!hex) return out;
  if (hex.length !== length * 2) {
    throw new Error(`Expected ${length * 2} hex chars, got ${hex.length}`);
  }
  for (let i = 0; i < length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`Invalid hex in "${hex}"`);
    out[i] = byte;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/** Serialized size of the header for a given set of variable-length fields. */
export function headerSize(header: Pick<ChunkHeader, 'fileName' | 'mimeType' | 'parityMembers'>): number {
  return (
    FIXED_SIZE +
    utf8.encode(header.fileName).length +
    utf8.encode(header.mimeType).length +
    (header.parityMembers?.length ?? 0) * 4 +
    HEADER_CRC_SIZE
  );
}

/** header + payload -> one self-describing byte string, ready for the FEC layer. */
export function serializeChunk(chunk: EncodedChunk): Uint8Array {
  const { header, payload } = chunk;
  const name = utf8.encode(header.fileName);
  const mime = utf8.encode(header.mimeType);
  const members = header.parityMembers ?? [];
  const sha = hexToBytes(header.fileSha256, 32);

  if (name.length > 0xffff) throw new Error('fileName too long');
  if (mime.length > 0xffff) throw new Error('mimeType too long');
  if (members.length > 0xffff) throw new Error('too many parity members');

  const size = headerSize(header);
  const out = new Uint8Array(size + payload.length);
  const view = new DataView(out.buffer);

  view.setUint32(0, CHUNK_MAGIC);
  out[4] = header.version;
  out[5] = KIND_TO_CODE[header.kind];
  view.setUint16(6, name.length);
  view.setUint16(8, mime.length);
  view.setUint16(10, members.length);
  view.setUint32(12, header.chunkIndex);
  view.setUint32(16, header.totalChunks);
  view.setUint32(20, payload.length);
  view.setUint32(24, crc32(payload));
  view.setUint32(28, header.parityGroupId ?? NO_PARITY_GROUP);
  view.setBigUint64(32, BigInt(header.fileSize));
  out.set(sha, 40);
  view.setUint16(72, header.parityIndex ?? NO_PARITY_INDEX);

  let off = FIXED_SIZE;
  out.set(name, off);
  off += name.length;
  out.set(mime, off);
  off += mime.length;
  for (const member of members) {
    view.setUint32(off, member);
    off += 4;
  }

  view.setUint32(off, crc32(out.subarray(0, off)));
  out.set(payload, size);
  return out;
}

/**
 * Inverse of serializeChunk. Throws on a wrong magic, an unknown version, or a
 * failed CRC - a chunk that does not verify must never reach the assembler.
 */
export function parseChunk(bytes: Uint8Array): EncodedChunk {
  if (bytes.length < FIXED_SIZE + HEADER_CRC_SIZE) throw new Error('Chunk truncated: shorter than a header');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== CHUNK_MAGIC) throw new Error('Bad magic: not a dbforall chunk');

  const version = bytes[4];
  if (version !== CHUNK_VERSION) throw new Error(`Unsupported chunk version ${version}`);

  const kind = CODE_TO_KIND[bytes[5]];
  if (!kind) throw new Error(`Unknown chunk kind ${bytes[5]}`);

  const nameLen = view.getUint16(6);
  const mimeLen = view.getUint16(8);
  const memberCount = view.getUint16(10);
  const varSize = nameLen + mimeLen + memberCount * 4;
  const size = FIXED_SIZE + varSize + HEADER_CRC_SIZE;
  if (bytes.length < size) throw new Error('Chunk truncated: header longer than the buffer');

  const headerCrcOffset = FIXED_SIZE + varSize;
  if (view.getUint32(headerCrcOffset) !== crc32(bytes.subarray(0, headerCrcOffset))) {
    throw new Error('Header CRC mismatch');
  }

  const payloadLength = view.getUint32(20);
  if (bytes.length < size + payloadLength) throw new Error('Chunk truncated: payload shorter than declared');
  const payload = bytes.slice(size, size + payloadLength);
  if (view.getUint32(24) !== crc32(payload)) throw new Error('Payload CRC mismatch');

  let off = FIXED_SIZE;
  const fileName = utf8Decoder.decode(bytes.subarray(off, off + nameLen));
  off += nameLen;
  const mimeType = utf8Decoder.decode(bytes.subarray(off, off + mimeLen));
  off += mimeLen;
  const parityMembers: number[] = [];
  for (let i = 0; i < memberCount; i++) {
    parityMembers.push(view.getUint32(off));
    off += 4;
  }

  const parityGroupId = view.getUint32(28);
  const parityIndex = view.getUint16(72);

  const header: ChunkHeader = {
    magic: CHUNK_MAGIC,
    version,
    kind,
    fileName,
    mimeType,
    fileSize: Number(view.getBigUint64(32)),
    fileSha256: bytesToHex(bytes.subarray(40, 72)),
    chunkIndex: view.getUint32(12),
    totalChunks: view.getUint32(16),
    payloadLength,
    chunkCrc: view.getUint32(24),
  };
  if (parityGroupId !== NO_PARITY_GROUP) header.parityGroupId = parityGroupId;
  if (parityMembers.length > 0) header.parityMembers = parityMembers;
  if (parityIndex !== NO_PARITY_INDEX) header.parityIndex = parityIndex;

  return { header, payload };
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return bytesToHex(new Uint8Array(digest));
}

export interface ChunkOptions {
  fileName: string;
  mimeType: string;
  /** Payload bytes per chunk. Driven by how much one video frame can carry. */
  payloadSize: number;
}

/** Split a file into fixed-size data chunks. The last chunk is short, never padded. */
export async function chunkFile(data: Uint8Array, options: ChunkOptions): Promise<EncodedChunk[]> {
  const { fileName, mimeType, payloadSize } = options;
  if (payloadSize <= 0) throw new Error('payloadSize must be positive');

  const fileSha256 = await sha256Hex(data);
  const totalChunks = Math.max(1, Math.ceil(data.length / payloadSize));
  const chunks: EncodedChunk[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const payload = data.slice(i * payloadSize, Math.min((i + 1) * payloadSize, data.length));
    chunks.push({
      header: {
        magic: CHUNK_MAGIC,
        version: CHUNK_VERSION,
        kind: 'data',
        fileName,
        mimeType,
        fileSize: data.length,
        fileSha256,
        chunkIndex: i,
        totalChunks,
        payloadLength: payload.length,
        chunkCrc: crc32(payload),
      },
      payload,
    });
  }
  return chunks;
}

/**
 * Reassemble data chunks into the original file. Chunks may arrive in any order
 * and may repeat; a missing index is fatal here, recovery is the FEC layer's job.
 */
export async function assembleFile(chunks: EncodedChunk[]): Promise<Uint8Array> {
  const dataChunks = chunks.filter((c) => c.header.kind === 'data');
  if (dataChunks.length === 0) throw new Error('No data chunks to assemble');

  const { totalChunks, fileSize, fileSha256 } = dataChunks[0].header;
  const byIndex = new Map<number, EncodedChunk>();
  for (const chunk of dataChunks) {
    if (chunk.header.fileSha256 !== fileSha256) throw new Error('Chunks belong to different files');
    byIndex.set(chunk.header.chunkIndex, chunk);
  }

  const missing: number[] = [];
  for (let i = 0; i < totalChunks; i++) if (!byIndex.has(i)) missing.push(i);
  if (missing.length > 0) throw new Error(`Missing chunks: ${missing.join(', ')}`);

  const out = new Uint8Array(fileSize);
  let off = 0;
  for (let i = 0; i < totalChunks; i++) {
    const payload = byIndex.get(i)!.payload;
    out.set(payload, off);
    off += payload.length;
  }
  if (off !== fileSize) throw new Error(`Assembled ${off} bytes, header declares ${fileSize}`);

  const actual = await sha256Hex(out);
  if (actual !== fileSha256) throw new Error('SHA-256 mismatch after assembly');
  return out;
}
