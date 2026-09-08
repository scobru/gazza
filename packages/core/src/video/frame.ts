import { RGBColor, VideoProfile } from '../codec/types';
import { classifyColor } from '../palette/colors';
import { decodeBytesWithHamming, encodeBytesWithHamming } from '../fec/hamming';

/** Bits carried by one Hamming(7,4) symbol. */
const SYMBOL_BITS = 7;

/** First and last cell row carry the palette reference, not data. */
export const CALIBRATION_ROWS = 2;

export function bitsPerCell(palette: RGBColor[]): number {
  const bits = Math.log2(palette.length);
  if (!Number.isInteger(bits) || bits < 1) {
    throw new Error(
      `Palette size must be a power of two (got ${palette.length}); ` +
        'non-power-of-two palettes need radix packing, which is not implemented'
    );
  }
  return bits;
}

export interface FrameGeometry {
  cols: number;
  rows: number;
  /** Pixel offset of the grid, so leftover pixels sit at the frame edges. */
  originX: number;
  originY: number;
  bitsPerCell: number;
  dataCells: number;
  /** Hamming symbols per frame; always even so bytes stay whole. */
  symbolCapacity: number;
  capacityBytes: number;
}

export function frameGeometry(profile: VideoProfile): FrameGeometry {
  const { width, height, cellSize, palette } = profile;
  if (cellSize < 2) throw new Error('cellSize must be at least 2 px');

  const cols = Math.floor(width / cellSize);
  const rows = Math.floor(height / cellSize);
  if (rows <= CALIBRATION_ROWS) throw new Error('Frame too short for a calibration strip plus data');
  if (cols < palette.length) throw new Error('Frame too narrow to show every palette colour');

  const bpc = bitsPerCell(palette);
  const dataCells = (rows - CALIBRATION_ROWS) * cols;
  const symbolCapacity = Math.floor((dataCells * bpc) / SYMBOL_BITS) & ~1;
  if (symbolCapacity < 2) throw new Error('Frame carries less than one byte');

  return {
    cols,
    rows,
    originX: Math.floor((width - cols * cellSize) / 2),
    originY: Math.floor((height - rows * cellSize) / 2),
    bitsPerCell: bpc,
    dataCells,
    symbolCapacity,
    capacityBytes: symbolCapacity / 2,
  };
}

/**
 * Bit interleaver. A misread cell corrupts `bitsPerCell` consecutive bits, and
 * Hamming(7,4) only fixes one bit per symbol - so consecutive bits are spread
 * across different symbols. Bit `j` of every symbol is emitted before bit `j+1`
 * of any of them, which turns a cell-sized burst into isolated single-bit errors.
 *
 * Limit: this only guarantees separation for cells that are near each other.
 * Two far-apart bad cells whose distance happens to be a multiple of the symbol
 * count still land in the same symbol, and Hamming cannot fix two bits there -
 * that is what the outer Reed-Solomon layer is for. Widen this to a proper
 * block interleaver only if per-frame corrections stop being enough.
 */
function interleavedIndex(position: number, symbolCount: number): { symbol: number; bit: number } {
  return {
    symbol: position % symbolCount,
    bit: Math.floor(position / symbolCount),
  };
}

function symbolsToBits(symbols: Uint8Array): Uint8Array {
  const bits = new Uint8Array(symbols.length * SYMBOL_BITS);
  for (let p = 0; p < bits.length; p++) {
    const { symbol, bit } = interleavedIndex(p, symbols.length);
    bits[p] = (symbols[symbol] >> (SYMBOL_BITS - 1 - bit)) & 1;
  }
  return bits;
}

function bitsToSymbols(bits: Uint8Array, symbolCount: number): Uint8Array {
  const symbols = new Uint8Array(symbolCount);
  for (let p = 0; p < symbolCount * SYMBOL_BITS; p++) {
    const { symbol, bit } = interleavedIndex(p, symbolCount);
    symbols[symbol] |= bits[p] << (SYMBOL_BITS - 1 - bit);
  }
  return symbols;
}

function paintCell(
  pixels: Uint8Array,
  width: number,
  geo: FrameGeometry,
  cellSize: number,
  col: number,
  row: number,
  colour: RGBColor
): void {
  const x0 = geo.originX + col * cellSize;
  const y0 = geo.originY + row * cellSize;
  for (let y = y0; y < y0 + cellSize; y++) {
    let offset = (y * width + x0) * 3;
    for (let x = 0; x < cellSize; x++) {
      pixels[offset++] = colour[0];
      pixels[offset++] = colour[1];
      pixels[offset++] = colour[2];
    }
  }
}

/** Average colour of a cell, ignoring its outer quarter where ringing lives. */
function sampleCell(
  pixels: Uint8Array,
  width: number,
  geo: FrameGeometry,
  cellSize: number,
  col: number,
  row: number
): RGBColor {
  const inset = Math.min(Math.floor(cellSize / 4), Math.floor((cellSize - 1) / 2));
  const span = cellSize - 2 * inset;
  const x0 = geo.originX + col * cellSize + inset;
  const y0 = geo.originY + row * cellSize + inset;

  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = y0; y < y0 + span; y++) {
    let offset = (y * width + x0) * 3;
    for (let x = 0; x < span; x++) {
      r += pixels[offset++];
      g += pixels[offset++];
      b += pixels[offset++];
    }
  }
  const n = span * span;
  return [r / n, g / n, b / n];
}

const calibrationRowsOf = (geo: FrameGeometry): number[] => [0, geo.rows - 1];

/** Payload bytes -> one RGB frame (width * height * 3, 8 bit per channel). */
export function renderFrame(payload: Uint8Array, profile: VideoProfile): Uint8Array {
  const geo = frameGeometry(profile);
  if (payload.length > geo.capacityBytes) {
    throw new Error(`Payload of ${payload.length} B exceeds frame capacity of ${geo.capacityBytes} B`);
  }

  const padded = new Uint8Array(geo.capacityBytes);
  padded.set(payload);
  const bits = symbolsToBits(encodeBytesWithHamming(padded));

  const { width, height, cellSize, palette } = profile;
  const pixels = new Uint8Array(width * height * 3);

  for (const row of calibrationRowsOf(geo)) {
    for (let col = 0; col < geo.cols; col++) {
      paintCell(pixels, width, geo, cellSize, col, row, palette[col % palette.length]);
    }
  }

  let bitPos = 0;
  for (let row = 1; row < geo.rows - 1; row++) {
    for (let col = 0; col < geo.cols; col++) {
      let index = 0;
      for (let b = 0; b < geo.bitsPerCell; b++) {
        index = (index << 1) | (bitPos < bits.length ? bits[bitPos++] : 0);
      }
      paintCell(pixels, width, geo, cellSize, col, row, palette[index]);
    }
  }

  return pixels;
}

/**
 * Measure what the platform's encoder did to our colours. Every palette entry
 * appears many times in the calibration rows, so the mean of those samples is
 * the palette as it survived, drift included.
 */
export function calibratePalette(pixels: Uint8Array, profile: VideoProfile): RGBColor[] {
  const geo = frameGeometry(profile);
  const { width, cellSize, palette } = profile;

  const sums: RGBColor[] = palette.map(() => [0, 0, 0]);
  const counts = new Array(palette.length).fill(0);

  for (const row of calibrationRowsOf(geo)) {
    for (let col = 0; col < geo.cols; col++) {
      const index = col % palette.length;
      const [r, g, b] = sampleCell(pixels, width, geo, cellSize, col, row);
      sums[index][0] += r;
      sums[index][1] += g;
      sums[index][2] += b;
      counts[index]++;
    }
  }

  return sums.map(([r, g, b], i) =>
    counts[i] > 0 ? ([r / counts[i], g / counts[i], b / counts[i]] as RGBColor) : palette[i]
  );
}

export interface FrameReadResult {
  bytes: Uint8Array;
  /** Single-bit errors Hamming repaired. A rising count means the cell size is too small. */
  corrections: number;
}

/** One RGB frame -> the payload bytes it carries, padding included. */
export function readFrame(pixels: Uint8Array, profile: VideoProfile): FrameReadResult {
  const geo = frameGeometry(profile);
  const { width, height, cellSize, palette } = profile;
  if (pixels.length < width * height * 3) throw new Error('Pixel buffer smaller than the profile frame');

  const calibrated = calibratePalette(pixels, profile);
  const bits = new Uint8Array(geo.symbolCapacity * SYMBOL_BITS);

  let bitPos = 0;
  for (let row = 1; row < geo.rows - 1 && bitPos < bits.length; row++) {
    for (let col = 0; col < geo.cols && bitPos < bits.length; col++) {
      const index = classifyColor(sampleCell(pixels, width, geo, cellSize, col, row), palette, calibrated);
      for (let b = geo.bitsPerCell - 1; b >= 0 && bitPos < bits.length; b--) {
        bits[bitPos++] = (index >> b) & 1;
      }
    }
  }

  return decodeBytesWithHamming(bitsToSymbols(bits, geo.symbolCapacity));
}
