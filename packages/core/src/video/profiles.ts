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
 * Those runs used VP9, and VP9 turned out to be the wrong yardstick. A real
 * YouTube upload comes back as AV1, and AV1 at the same bitrate is far more
 * destructive. Measured again against what YouTube actually serves - AV1,
 * 1080p30, 4 Mbps - the picture changes:
 *
 *   cell 12  2011 B/frame  4.2 corrections per frame, 4 frames in 92 unreadable
 *   cell 14  1467 B/frame  2.8 corrections, none unreadable
 *   cell 16  1114 B/frame  0.5 corrections, 4 in 172 unreadable
 *
 * A real 400 KB upload at cell 12 lost 9 of its 280 chunks and did not come
 * back. Hence 16 px on YouTube: it costs 45% of the capacity and buys the same
 * margin the messaging platforms showed.
 *
 * Two lessons. Chroma is the bottleneck, not luminance: 4:2:0 subsampling
 * halves the colour resolution, so four well separated colours beat eight at
 * the same cell size. And the cliff is sharp - 10 px fails everywhere, 12 px
 * survives a bitrate an order of magnitude below what either platform serves.
 * Capacity that does not survive is not capacity.
 */
/** Instagram: still the VP9-era measurement, never verified on a real upload. */
const INSTAGRAM_CELL_SIZE = 12;

/** YouTube: sized for AV1 at 4 Mbps, which is what a real upload comes back as. */
const YOUTUBE_CELL_SIZE = 16;

/**
 * repeatFrames: 2 is also measured. With a single frame per chunk a platform
 * that re-times 30 fps down to 24 drops one frame in five, loses a fifth of the
 * chunks and the file is gone. A second copy survives that; a third adds
 * nothing but bytes.
 */
const REPEAT_FRAMES = 2;

/** Verified against AV1 at 4 Mbps, the format a real 1080p upload comes back as. */
export const YOUTUBE_PROFILE: VideoProfile = {
  platform: 'youtube',
  width: 1920,
  height: 1080,
  fps: 30,
  repeatFrames: REPEAT_FRAMES,
  cellSize: YOUTUBE_CELL_SIZE,
  palette: PALETTE_4,
};

/**
 * Portrait. Verified down to 150 kbps VP9 but never against a real upload, and
 * the YouTube result says a VP9 measurement can flatter a profile. Treat the
 * capacity here as provisional.
 */
export const INSTAGRAM_PROFILE: VideoProfile = {
  platform: 'instagram',
  width: 1080,
  height: 1920,
  fps: 30,
  repeatFrames: REPEAT_FRAMES,
  cellSize: INSTAGRAM_CELL_SIZE,
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
