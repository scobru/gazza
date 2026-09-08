import { Platform, VideoProfile } from '../codec/types';
import { PALETTE_4 } from '../palette/colors';

/*
 * These numbers are measured, not guessed. Each candidate was encoded, pushed
 * through a VP9 transcode at a capped bitrate and decoded again:
 *
 *   1080p, palette 8, cell  8  6840 B/frame  dies at 2 Mbps
 *   1080p, palette 8, cell 12  3017 B/frame  dies at 2 Mbps
 *   1080p, palette 4, cell 10  2907 B/frame  dies at 1 Mbps
 *   1080p, palette 4, cell 12  2011 B/frame  survives 300 kbps
 *   1080p, palette 4, cell 14  1467 B/frame  survives 300 kbps
 *
 * Two lessons. Chroma is the bottleneck, not luminance: 4:2:0 subsampling
 * halves the colour resolution, so four well separated colours beat eight at
 * the same cell size. And the cliff is sharp - 10 px fails everywhere, 12 px
 * survives a bitrate an order of magnitude below what either platform serves.
 * Capacity that does not survive is not capacity.
 */
const CELL_SIZE = 12;

/**
 * repeatFrames: 2 is also measured. With a single frame per chunk a platform
 * that re-times 30 fps down to 24 drops one frame in five, loses a fifth of the
 * chunks and the file is gone. A second copy survives that; a third adds
 * nothing but bytes.
 */
const REPEAT_FRAMES = 2;

/** Verified down to 300 kbps VP9, roughly a tenth of what YouTube serves at 1080p. */
export const YOUTUBE_PROFILE: VideoProfile = {
  platform: 'youtube',
  width: 1920,
  height: 1080,
  fps: 30,
  repeatFrames: REPEAT_FRAMES,
  cellSize: CELL_SIZE,
  palette: PALETTE_4,
};

/** Same grid, portrait. Verified down to 150 kbps VP9. */
export const INSTAGRAM_PROFILE: VideoProfile = {
  platform: 'instagram',
  width: 1080,
  height: 1920,
  fps: 30,
  repeatFrames: REPEAT_FRAMES,
  cellSize: CELL_SIZE,
  palette: PALETTE_4,
  maxDurationSeconds: 90,
};

export const PROFILES: Record<Exclude<Platform, 'custom'>, VideoProfile> = {
  youtube: YOUTUBE_PROFILE,
  instagram: INSTAGRAM_PROFILE,
};

export function profileFor(platform: string): VideoProfile {
  const profile = PROFILES[platform as Exclude<Platform, 'custom'>];
  if (!profile) {
    throw new Error(`Unknown platform "${platform}", expected one of ${Object.keys(PROFILES).join(', ')}`);
  }
  return profile;
}
