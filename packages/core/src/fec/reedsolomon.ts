/**
 * Pure TypeScript Reed-Solomon Erasure Coding over Galois Field GF(2^8).
 * Uses standard AES/QR polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1).
 * Supports systematic erasure coding: given K data packets and M parity packets,
 * any K surviving packets out of the total K + M packets are sufficient to
 * reconstruct all original K data packets via Gaussian Elimination.
 */

const GF_SIZE = 256;
const PRIM_POLY = 0x11d;

const EXP_TABLE = new Uint8Array(GF_SIZE * 2);
const LOG_TABLE = new Uint8Array(GF_SIZE);

// Precompute Log & Exp tables for fast GF(2^8) math
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    EXP_TABLE[i + 255] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= PRIM_POLY;
    }
  }
  LOG_TABLE[0] = 0; // Special case: log(0) is undefined, handled in mul/div
})();

export function gfAdd(a: number, b: number): number {
  return a ^ b;
}

export function gfSub(a: number, b: number): number {
  return a ^ b;
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero in GF(2^8)');
  if (a === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + 255 - LOG_TABLE[b]];
}

export function gfInv(a: number): number {
  if (a === 0) throw new Error('Inverse of zero in GF(2^8)');
  return EXP_TABLE[255 - LOG_TABLE[a]];
}

/**
 * Builds a systematic Cauchy generator matrix of size (k + m) x k.
 * The top k x k is the identity, so data chunks travel unchanged.
 *
 * The parity rows are Cauchy, not Vandermonde: every square submatrix of a
 * Cauchy matrix is invertible, which is exactly what erasure decoding needs,
 * because it inverts whichever rows happen to survive. A Vandermonde matrix is
 * invertible whole but not in every subset, so some loss patterns produce a
 * singular system and fail to decode with the parity sitting right there.
 */
export function buildGeneratorMatrix(k: number, m: number): number[][] {
  if (k + m > 256) throw new Error(`Cannot build a ${k}+${m} matrix over GF(256)`);

  const matrix: number[][] = Array.from({ length: k + m }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) matrix[i][i] = 1;

  // Cauchy: a[r][c] = 1 / (x_r + y_c), the two sets disjoint so no sum is zero.
  // Addition in GF(2^8) is xor. The y set counts down from 255 so a row depends
  // only on r and c, never on m - the decoder rebuilds this matrix without
  // knowing how many parity rows the encoder actually wrote.
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < k; c++) {
      matrix[k + r][c] = gfInv(r ^ (255 - c));
    }
  }

  return matrix;
}

/**
 * The Vandermonde parity rows written by chunk version 2. Kept only so carriers
 * made before the Cauchy fix still decode; never write with this. Its square
 * submatrices are not all invertible, which is the bug it was replaced for, so
 * some loss patterns still fail here - correctly reported rather than guessed.
 */
export function buildLegacyGeneratorMatrix(k: number, m: number): number[][] {
  const matrix: number[][] = Array.from({ length: k + m }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) matrix[i][i] = 1;

  for (let r = 0; r < m; r++) {
    const base = (r + 1) & 0xff;
    for (let c = 0; c < k; c++) {
      matrix[k + r][c] = c === 0 ? 1 : gfMul(matrix[k + r][c - 1], base);
    }
  }
  return matrix;
}

export type GeneratorMatrixBuilder = (k: number, m: number) => number[][];

/**
 * Encodes K data blocks of length L into M parity blocks of length L.
 */
export function encodeReedSolomon(
  dataChunks: Uint8Array[],
  parityCount: number,
  buildMatrix: GeneratorMatrixBuilder = buildGeneratorMatrix
): Uint8Array[] {
  const k = dataChunks.length;
  if (k === 0) return [];
  const chunkSize = dataChunks[0].length;
  const matrix = buildMatrix(k, parityCount);

  const parityChunks: Uint8Array[] = Array.from(
    { length: parityCount },
    () => new Uint8Array(chunkSize)
  );

  for (let p = 0; p < parityCount; p++) {
    const parityRow = matrix[k + p];
    const out = parityChunks[p];

    for (let c = 0; c < k; c++) {
      const coeff = parityRow[c];
      if (coeff === 0) continue;
      const data = dataChunks[c];

      for (let byteIdx = 0; byteIdx < chunkSize; byteIdx++) {
        out[byteIdx] ^= gfMul(coeff, data[byteIdx]);
      }
    }
  }

  return parityChunks;
}

/**
 * Reconstructs original K data chunks given any K surviving chunks and their indices.
 * @param survivingChunks Array of surviving chunks (can be data or parity).
 * @param survivingIndices The corresponding row indices in the generator matrix (0..K-1 for data, K..K+M-1 for parity).
 * @param k Total number of original data chunks.
 */
export function decodeReedSolomon(
  survivingChunks: Uint8Array[],
  survivingIndices: number[],
  k: number,
  buildMatrix: GeneratorMatrixBuilder = buildGeneratorMatrix
): Uint8Array[] {
  if (survivingChunks.length < k) {
    throw new Error(`Insufficient chunks for RS recovery: have ${survivingChunks.length}, need ${k}`);
  }

  // Select first k surviving chunks
  const usedChunks = survivingChunks.slice(0, k);
  const usedIndices = survivingIndices.slice(0, k);
  const chunkSize = usedChunks[0].length;

  // Check if we already have all K original data chunks (indices 0..k-1)
  let hasAllData = true;
  for (let i = 0; i < k; i++) {
    if (!usedIndices.includes(i)) {
      hasAllData = false;
      break;
    }
  }

  if (hasAllData) {
    // Sort in order of original data indices
    const ordered: Uint8Array[] = new Array(k);
    for (let i = 0; i < k; i++) {
      const idx = usedIndices.indexOf(i);
      ordered[i] = usedChunks[idx];
    }
    return ordered;
  }

  // Extract the k x k submatrix corresponding to the surviving rows
  const fullMatrix = buildMatrix(k, Math.max(...usedIndices) - k + 1);
  const subMatrix: number[][] = Array.from({ length: k }, (_, row) => {
    const origRowIdx = usedIndices[row];
    return [...fullMatrix[origRowIdx]];
  });

  // Invert the k x k submatrix using Gaussian Elimination
  const invMatrix = invertMatrix(subMatrix, k);

  // Multiply invMatrix with the surviving chunks to recover original data chunks
  const recoveredData: Uint8Array[] = Array.from({ length: k }, () => new Uint8Array(chunkSize));

  for (let row = 0; row < k; row++) {
    const out = recoveredData[row];
    for (let col = 0; col < k; col++) {
      const coeff = invMatrix[row][col];
      if (coeff === 0) continue;
      const src = usedChunks[col];

      for (let b = 0; b < chunkSize; b++) {
        out[b] ^= gfMul(coeff, src[b]);
      }
    }
  }

  return recoveredData;
}

/**
 * Inverts a k x k matrix in GF(2^8) via Gauss-Jordan elimination.
 */
function invertMatrix(mat: number[][], n: number): number[][] {
  // Augmented matrix [A | I]
  const a: number[][] = Array.from({ length: n }, (_, r) => {
    const row = new Array(2 * n).fill(0);
    for (let c = 0; c < n; c++) row[c] = mat[r][c];
    row[n + r] = 1;
    return row;
  });

  for (let col = 0; col < n; col++) {
    // Find pivot
    let pivotRow = col;
    while (pivotRow < n && a[pivotRow][col] === 0) {
      pivotRow++;
    }

    if (pivotRow === n) {
      throw new Error('Matrix is singular and cannot be inverted');
    }

    // Swap pivot row if needed
    if (pivotRow !== col) {
      const temp = a[col];
      a[col] = a[pivotRow];
      a[pivotRow] = temp;
    }

    // Scale pivot row to make diagonal element 1
    const pivotVal = a[col][col];
    const invPivot = gfInv(pivotVal);
    for (let c = 0; c < 2 * n; c++) {
      a[col][c] = gfMul(a[col][c], invPivot);
    }

    // Eliminate column elements in all other rows
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;

      for (let c = 0; c < 2 * n; c++) {
        a[r][c] ^= gfMul(factor, a[col][c]);
      }
    }
  }

  // Extract right half (inverted matrix)
  return Array.from({ length: n }, (_, r) => a[r].slice(n, 2 * n));
}
