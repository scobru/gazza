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
/** Instagram: verified on a real Reel, which downscales 1080x1920 to 720x1280. */
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
 * Portrait. Verified on a real Reel: Instagram caps at 720x1280, so the carrier
 * comes back downscaled by 1.5x and still decodes with no corrections at all.
 * 12 px cells survive that; they would not survive another halving.
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

/**
 * Telegram re-encodes to 1280x720 but keeps a generous bitrate for it: a real
 * round trip came back at 5.8 Mbps with not a single Hamming correction. The
 * gentlest of the four.
 */
export const TELEGRAM_PROFILE: VideoProfile = {
  platform: 'telegram',
  width: 1920,
  height: 1080,
  fps: 30,
  repeatFrames: REPEAT_FRAMES,
  cellSize: INSTAGRAM_CELL_SIZE,
  palette: PALETTE_4,
};

/**
 * WhatsApp downscales hardest of all - 1920x1080 came back as 848x478, a factor
 * of 2.26 - but keeps 7 Mbps for it, so 12 px cells came through with 0.4
 * corrections per frame and no losses. Send it as a video, not as a document:
 * as a document nothing is re-encoded and nothing is tested.
 */
export const WHATSAPP_PROFILE: VideoProfile = {
  platform: 'whatsapp',
  width: 1920,
  height: 1080,
  fps: 30,
  repeatFrames: REPEAT_FRAMES,
  cellSize: INSTAGRAM_CELL_SIZE,
  palette: PALETTE_4,
};

export const PROFILES: Record<Exclude<Platform, 'custom'>, VideoProfile> = {
  youtube: YOUTUBE_PROFILE,
  instagram: INSTAGRAM_PROFILE,
  telegram: TELEGRAM_PROFILE,
  whatsapp: WHATSAPP_PROFILE,
};

export function profileFor(platform: string): VideoProfile {
  const profile = PROFILES[platform as Exclude<Platform, 'custom'>];
  if (!profile) {
    throw new Error(`Unknown platform "${platform}", expected one of ${Object.keys(PROFILES).join(', ')}`);
  }
  return profile;
}
