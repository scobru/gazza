import test from 'node:test';
import assert from 'node:assert/strict';
import { frameGeometry } from './frame';
import {
  INSTAGRAM_PROFILE,
  PROFILES,
  GOOGLE_PHOTOS_PROFILE,
  TELEGRAM_PROFILE,
  WHATSAPP_PROFILE,
  YOUTUBE_PROFILE,
  profileFor,
} from './profiles';

// These capacities came out of the transcode measurements documented in
// profiles.ts. If a change moves them, it changed how much survives a platform.
test('the shipped profiles carry the capacity they were tuned for', () => {
  assert.equal(frameGeometry(YOUTUBE_PROFILE).capacityBytes, 1114);
  assert.equal(frameGeometry(INSTAGRAM_PROFILE).capacityBytes, 2031);
});

test('every profile repeats each chunk twice', () => {
  // One copy per chunk loses a fifth of the file when a platform re-times
  // 30 fps to 24. Do not lower this without re-running that test.
  assert.equal(YOUTUBE_PROFILE.repeatFrames, 2);
  assert.equal(INSTAGRAM_PROFILE.repeatFrames, 2);
});

test('profiles are looked up by name and unknown names are refused', () => {
  assert.equal(profileFor('youtube'), YOUTUBE_PROFILE);
  assert.equal(profileFor('instagram'), INSTAGRAM_PROFILE);
  assert.equal(profileFor('telegram'), TELEGRAM_PROFILE);
  assert.equal(profileFor('whatsapp'), WHATSAPP_PROFILE);
  assert.equal(profileFor('googlephotos'), GOOGLE_PHOTOS_PROFILE);
  assert.throws(() => profileFor('tiktok'), /Unknown platform "tiktok"/);
});

test('Google Photos inherits the most robust cells we have', () => {
  // Its round trip works but its margin was never characterised, so it keeps
  // the setting that survived the harshest codec seen rather than a guessed one.
  assert.equal(GOOGLE_PHOTOS_PROFILE.cellSize, YOUTUBE_PROFILE.cellSize);
});

test('the messaging profiles keep the cells that survived their round trips', () => {
  // WhatsApp shrank 1920x1080 to 848x478 and Telegram to 1280x720; 12 px cells
  // came through both. Raising them would only cost capacity.
  assert.equal(TELEGRAM_PROFILE.cellSize, 12);
  assert.equal(WHATSAPP_PROFILE.cellSize, 12);
  assert.equal(TELEGRAM_PROFILE.maxDurationSeconds, undefined);
});

test('every profile is a geometry the frame layer accepts', () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    const geo = frameGeometry(profile);
    assert.ok(geo.capacityBytes > 0, `${name} carries nothing`);
    assert.equal(geo.bitsPerCell, 2, `${name} should use the 4 colour palette`);
  }
});
