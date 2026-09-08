/**
 * Systematic Hamming(7,4) Code implementation.
 * Encodes 4 data bits into a 7-bit codeword with 3 parity bits.
 * Can detect and correct any single-bit flip per 7-bit block.
 *
 * Generator Matrix G:
 * [1 1 0 1] -> p1 = d1 ^ d2 ^ d4
 * [1 0 1 1] -> p2 = d1 ^ d3 ^ d4
 * [1 0 0 0] -> d1
 * [0 1 1 1] -> p3 = d2 ^ d3 ^ d4
 * [0 1 0 0] -> d2
 * [0 0 1 0] -> d3
 * [0 0 0 1] -> d4
 */

export function encodeHamming74(nibble: number): number {
  const d1 = (nibble >> 3) & 1;
  const d2 = (nibble >> 2) & 1;
  const d3 = (nibble >> 1) & 1;
  const d4 = nibble & 1;

  const p1 = d1 ^ d2 ^ d4;
  const p2 = d1 ^ d3 ^ d4;
  const p3 = d2 ^ d3 ^ d4;

  // 7-bit output: [p1, p2, d1, p3, d2, d3, d4]
  return (p1 << 6) | (p2 << 5) | (d1 << 4) | (p3 << 3) | (d2 << 2) | (d3 << 1) | d4;
}

export function decodeHamming74(code7: number): { data: number; corrected: boolean } {
  let c = code7 & 0x7f;

  const p1 = (c >> 6) & 1;
  const p2 = (c >> 5) & 1;
  const d1 = (c >> 4) & 1;
  const p3 = (c >> 3) & 1;
  const d2 = (c >> 2) & 1;
  const d3 = (c >> 1) & 1;
  const d4 = c & 1;

  // Syndrome bits
  const s1 = p1 ^ d1 ^ d2 ^ d4;
  const s2 = p2 ^ d1 ^ d3 ^ d4;
  const s3 = p3 ^ d2 ^ d3 ^ d4;

  const syndrome = (s1 << 0) | (s2 << 1) | (s3 << 2); // 1-indexed error bit position

  let corrected = false;
  if (syndrome !== 0) {
    // Error detected at bit position `syndrome` (from MSB 1..7 -> bit 7 - syndrome)
    const errorBitIndex = 7 - syndrome;
    c ^= 1 << errorBitIndex;
    corrected = true;
  }

  // Extract original 4 data bits: d1, d2, d3, d4
  const finalD1 = (c >> 4) & 1;
  const finalD2 = (c >> 2) & 1;
  const finalD3 = (c >> 1) & 1;
  const finalD4 = c & 1;

  return {
    data: (finalD1 << 3) | (finalD2 << 2) | (finalD3 << 1) | finalD4,
    corrected
  };
}

/**
 * Encodes an entire byte array into 7-bit symbols (2 symbols per byte).
 */
export function encodeBytesWithHamming(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.length * 2);
  let outIdx = 0;
  for (let i = 0; i < bytes.length; i++) {
    const high = (bytes[i] >> 4) & 0x0f;
    const low = bytes[i] & 0x0f;
    output[outIdx++] = encodeHamming74(high);
    output[outIdx++] = encodeHamming74(low);
  }
  return output;
}

/**
 * Decodes an array of 7-bit symbols back into original bytes.
 */
export function decodeBytesWithHamming(symbols: Uint8Array): { bytes: Uint8Array; corrections: number } {
  const byteCount = Math.floor(symbols.length / 2);
  const output = new Uint8Array(byteCount);
  let corrections = 0;

  for (let i = 0; i < byteCount; i++) {
    const highSym = symbols[i * 2];
    const lowSym = symbols[i * 2 + 1];

    const h = decodeHamming74(highSym);
    const l = decodeHamming74(lowSym);

    if (h.corrected) corrections++;
    if (l.corrected) corrections++;

    output[i] = (h.data << 4) | l.data;
  }

  return { bytes: output, corrections };
}
