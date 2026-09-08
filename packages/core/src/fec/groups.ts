import { CHUNK_MAGIC, CHUNK_VERSION } from '../codec/chunk';
import { crc32 } from '../codec/crc32';
import { EncodedChunk } from '../codec/types';
import { decodeReedSolomon, encodeReedSolomon } from './reedsolomon';

/**
 * Erasure coding across chunks. Frame-level FEC repairs what a lossy re-encode
 * does to a frame we can still see; this repairs the frames we never got - the
 * ones a platform dropped, blended or re-timed away.
 *
 * Data chunks are cut into groups of `dataPerGroup`, each group getting
 * `parityPerGroup` extra chunks. Any `dataPerGroup` chunks out of the group
 * plus its parity are enough to rebuild the group.
 */
export interface ParityOptions {
  /** Data chunks protected together. Larger is cheaper but slower to solve. */
  dataPerGroup?: number;
  /** Extra chunks per group. Each one covers one more lost chunk. */
  parityPerGroup?: number;
}

export const DEFAULT_PARITY: Required<ParityOptions> = {
  dataPerGroup: 16,
  parityPerGroup: 4, // 25% overhead, any 4 of every 20 chunks may go missing
};

function padded(payload: Uint8Array, size: number): Uint8Array {
  if (payload.length === size) return payload;
  const out = new Uint8Array(size);
  out.set(payload);
  return out;
}

/** Build the parity chunks that protect a file's data chunks. */
export function buildParityChunks(
  dataChunks: EncodedChunk[],
  options: ParityOptions = {}
): EncodedChunk[] {
  const { dataPerGroup, parityPerGroup } = { ...DEFAULT_PARITY, ...options };
  if (dataPerGroup < 1 || parityPerGroup < 1) throw new Error('Group sizes must be positive');
  if (dataChunks.length === 0) return [];

  const template = dataChunks[0].header;
  const payloadSize = Math.max(...dataChunks.map((c) => c.payload.length));
  const parity: EncodedChunk[] = [];

  for (let start = 0, group = 0; start < dataChunks.length; start += dataPerGroup, group++) {
    const members = dataChunks.slice(start, start + dataPerGroup);
    const payloads = members.map((c) => padded(c.payload, payloadSize));
    const memberIndices = members.map((c) => c.header.chunkIndex);

    encodeReedSolomon(payloads, parityPerGroup).forEach((payload, j) => {
      parity.push({
        header: {
          magic: CHUNK_MAGIC,
          version: CHUNK_VERSION,
          kind: 'parity',
          fileName: template.fileName,
          mimeType: template.mimeType,
          fileSize: template.fileSize,
          fileSha256: template.fileSha256,
          chunkIndex: template.totalChunks + group * parityPerGroup + j,
          totalChunks: template.totalChunks,
          payloadLength: payload.length,
          chunkCrc: crc32(payload),
          parityGroupId: group,
          parityMembers: memberIndices,
          parityIndex: j,
        },
        payload,
      });
    });
  }

  return parity;
}

export interface RecoveryResult {
  chunks: EncodedChunk[];
  /** Chunk indices rebuilt from parity rather than received. */
  recovered: number[];
}

/**
 * Rebuild every missing data chunk from whatever arrived. Groups that are
 * complete are passed through untouched; a group that lost more chunks than it
 * has parity for is reported by index rather than silently returning a hole.
 */
export function recoverDataChunks(received: EncodedChunk[]): RecoveryResult {
  const data = new Map<number, EncodedChunk>();
  const parityByGroup = new Map<number, EncodedChunk[]>();

  for (const chunk of received) {
    if (chunk.header.kind === 'data') {
      if (!data.has(chunk.header.chunkIndex)) data.set(chunk.header.chunkIndex, chunk);
    } else if (chunk.header.kind === 'parity' && chunk.header.parityGroupId !== undefined) {
      const group = parityByGroup.get(chunk.header.parityGroupId) ?? [];
      if (!group.some((c) => c.header.parityIndex === chunk.header.parityIndex)) group.push(chunk);
      parityByGroup.set(chunk.header.parityGroupId, group);
    }
  }

  const template = received[0]?.header;
  if (!template) throw new Error('Nothing to recover from');
  const { totalChunks, fileSize } = template;

  const missing: number[] = [];
  for (let i = 0; i < totalChunks; i++) if (!data.has(i)) missing.push(i);
  if (missing.length === 0) {
    return { chunks: [...data.values()].sort((a, b) => a.header.chunkIndex - b.header.chunkIndex), recovered: [] };
  }

  const recovered: number[] = [];
  const unrecoverable: number[] = [];

  for (const parityChunks of parityByGroup.values()) {
    const members = parityChunks[0].header.parityMembers ?? [];
    const gone = members.filter((index) => !data.has(index));
    if (gone.length === 0) continue;

    const k = members.length;
    // A parity payload is never short, so it carries the padded chunk size.
    const payloadSize = parityChunks[0].payload.length;

    const survivingChunks: Uint8Array[] = [];
    const survivingIndices: number[] = [];
    members.forEach((index, row) => {
      const chunk = data.get(index);
      if (chunk) {
        survivingChunks.push(padded(chunk.payload, payloadSize));
        survivingIndices.push(row);
      }
    });
    for (const chunk of parityChunks) {
      survivingChunks.push(chunk.payload);
      survivingIndices.push(k + (chunk.header.parityIndex ?? 0));
    }

    if (survivingChunks.length < k) {
      unrecoverable.push(...gone);
      continue;
    }

    const payloads = decodeReedSolomon(survivingChunks, survivingIndices, k);
    for (const index of gone) {
      const row = members.indexOf(index);
      const last = index === totalChunks - 1;
      const length = last ? fileSize - index * payloadSize : payloadSize;
      const payload = payloads[row].slice(0, length);
      data.set(index, {
        header: {
          ...template,
          kind: 'data',
          chunkIndex: index,
          payloadLength: payload.length,
          chunkCrc: crc32(payload),
          parityGroupId: undefined,
          parityMembers: undefined,
          parityIndex: undefined,
        },
        payload,
      });
      recovered.push(index);
    }
  }

  const stillMissing = [...missing, ...unrecoverable].filter((i) => !data.has(i));
  if (stillMissing.length > 0) {
    throw new Error(
      `Cannot rebuild chunks ${[...new Set(stillMissing)].sort((a, b) => a - b).join(', ')}: ` +
        'too many lost in one parity group'
    );
  }

  return {
    chunks: [...data.values()].sort((a, b) => a.header.chunkIndex - b.header.chunkIndex),
    recovered: recovered.sort((a, b) => a - b),
  };
}
