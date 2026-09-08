import { Platform, VideoProfile } from '../codec/types';
import { PALETTE_4, PALETTE_8 } from '../palette/colors';

/**
 * YouTube keeps a generous bitrate at 1080p, so cells can be small and the
 * palette wide. Two identical frames per chunk cover a dropped or blended frame.
 */
export const YOUTUBE_PROFILE: VideoProfile = {
  platform: 'youtube',
  width: 1920,
  height: 1080,
  fps: 30,
  repeatFrames: 2,
  cellSize: 8,
  palette: PALETTE_8,
};

/**
 * Instagram re-encodes far more aggressively and crops to vertical, so this
 * trades capacity for survival: bigger cells, four well separated colours.
 */
export const INSTAGRAM_PROFILE: VideoProfile = {
  platform: 'instagram',
  width: 1080,
  height: 1920,
  fps: 30,
  repeatFrames: 3,
  cellSize: 12,
  palette: PALETTE_4,
  maxDurationSeconds: 90,
};

export const PROFILES: Record<Exclude<Platform, 'custom'>, VideoProfile> = {
  youtube: YOUTUBE_PROFILE,
  instagram: INSTAGRAM_PROFILE,
};

export function profileFor(platform: string): VideoProfile {
  const profile = PROFILES[platform as Exclude<Platform, 'custom'>];
  if (!profile) throw new Error(`Unknown platform "${platform}", expected one of ${Object.keys(PROFILES).join(', ')}`);
  return profile;
}
