import { RGBColor, YUVColor } from '../codec/types';

/**
 * Standard 6-color palette carefully optimized for maximum separation
 * in both Luminance (Y) and Chrominance (U, V) color spaces to resist
 * aggressive H.264/H.265 lossy compression.
 */
export const PALETTE_6: RGBColor[] = [
  [16, 16, 16],     // 0: Deep Black
  [246, 246, 246], // 1: Crisp White
  [220, 38, 38],   // 2: Bold Red
  [37, 99, 235],   // 3: Electric Blue
  [22, 163, 74],   // 4: Emerald Green
  [245, 128, 32]   // 5: Safety Orange
];

/**
 * High-density 8-color palette (3 bits per cell)
 */
export const PALETTE_8: RGBColor[] = [
  [16, 16, 16],     // 0: Black
  [245, 245, 245], // 1: White
  [220, 38, 38],   // 2: Red
  [37, 99, 235],   // 3: Blue
  [22, 163, 74],   // 4: Green
  [234, 179, 8],   // 5: Amber Yellow
  [168, 85, 247],  // 6: Purple
  [6, 182, 212]    // 7: Cyan
];

/**
 * Ultra-safe 4-color palette (2 bits per cell) for extreme compression environments
 */
export const PALETTE_4: RGBColor[] = [
  [16, 16, 16],     // 00: Black
  [246, 246, 246], // 01: White
  [220, 38, 38],   // 10: Red
  [37, 99, 235]    // 11: Blue
];

/**
 * Converts standard sRGB to BT.601 YUV
 */
export function rgbToYuv([r, g, b]: RGBColor): YUVColor {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const u = -0.14713 * r - 0.28886 * g + 0.436 * b + 128;
  const v = 0.615 * r - 0.51499 * g - 0.10001 * b + 128;
  return [y, u, v];
}

/**
 * Computes weighted perceptual distance between two colors in YUV space.
 * Weights chrominance (U, V) and luminance (Y) to guard against chroma subsampling blur.
 */
export function yuvColorDistance(c1: RGBColor, c2: RGBColor): number {
  const [y1, u1, v1] = rgbToYuv(c1);
  const [y2, u2, v2] = rgbToYuv(c2);

  const dy = y1 - y2;
  const du = u1 - u2;
  const dv = v1 - v2;

  // Weight chrominance heavily because compression blurs chroma, but also respect luminance
  return Math.sqrt(dy * dy * 1.0 + du * du * 1.5 + dv * dv * 1.5);
}

/**
 * Classifies an RGB sample to the closest palette index using nearest neighbor in YUV space.
 * Optional calibratedPalette accounts for observed color drift measured from calibration strips.
 */
export function classifyColor(
  sample: RGBColor,
  palette: RGBColor[],
  calibratedPalette?: RGBColor[]
): number {
  const referencePalette = calibratedPalette && calibratedPalette.length === palette.length
    ? calibratedPalette
    : palette;

  let minDistance = Infinity;
  let bestIndex = 0;

  for (let i = 0; i < referencePalette.length; i++) {
    const dist = yuvColorDistance(sample, referencePalette[i]);
    if (dist < minDistance) {
      minDistance = dist;
      bestIndex = i;
    }
  }

  return bestIndex;
}
