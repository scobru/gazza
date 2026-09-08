export type Platform = 'instagram' | 'youtube' | 'custom';

export type RGBColor = [number, number, number];
export type YUVColor = [number, number, number];

export type ChunkKind = 'data' | 'parity' | 'cover';

export interface ChunkHeader {
  magic: number; // 0x44424641 = "DBFA"
  version: number; // e.g. 1
  kind: ChunkKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileSha256: string;
  chunkIndex: number;
  totalChunks: number;
  payloadLength: number;
  chunkCrc: number;
  parityGroupId?: number;
  /** Data chunk indices this parity group protects. Parity chunks only. */
  parityMembers?: number[];
  /** Position of this parity chunk within its group, i.e. its Reed-Solomon row. */
  parityIndex?: number;
}

export interface EncodedChunk {
  header: ChunkHeader;
  payload: Uint8Array;
}

export interface VideoProfile {
  platform: Platform;
  width: number;
  height: number;
  fps: number;
  repeatFrames: number;
  cellSize: number;
  maxDurationSeconds?: number;
  palette: RGBColor[];
}

export interface ProgressUpdate {
  phase: string;
  completed: number;
  total: number;
  detail?: string;
}

export type ProgressCallback = (update: ProgressUpdate) => void;
