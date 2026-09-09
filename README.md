# dbforall

Store arbitrary files inside a video, so a platform that hosts video hosts your
bytes. The file becomes a grid of coloured cells; the grid survives the
platform's re-encode; the video comes back and the file comes out byte for byte.

```bash
dbforall encode report.pdf carrier.mp4          # file  -> video
# upload carrier.mp4 by hand, then:
dbforall decode https://youtu.be/VIDEO_ID       # video -> file
```

## How it holds together

A platform does four things to an upload, and each layer answers one of them.

| what the platform does | what answers it |
| --- | --- |
| re-encodes lossily, blurs edges, shifts colour | large cells, four widely separated colours, a calibration strip |
| corrupts pixels inside a frame | Hamming(7,4) per nibble, bit-interleaved across the frame |
| drops, blends or re-times frames | every chunk written twice |
| loses whole chunks anyway | Reed-Solomon parity across chunks |

**Calibration strip.** The first and last cell row cycle through every palette
colour. The decoder measures the palette *as it survived* the re-encode and
classifies against that, not against the nominal colours.

**Interleaving.** A misread cell corrupts as many consecutive bits as the cell
carries, and Hamming(7,4) repairs only one bit per symbol. Bit *j* of every
symbol is written before bit *j+1* of any of them, so a ruined compression block
becomes one repairable bit per symbol instead of one dead symbol.

**Parity.** Data chunks are grouped 16 at a time with 4 parity chunks each. Any
4 of every 20 chunks may vanish entirely. Without this, one lost chunk lost the
file.

## Profiles

The defaults are measured, not guessed. Each candidate was encoded, pushed
through a VP9 transcode at a capped bitrate, and decoded again.

| geometry | capacity | survives down to |
| --- | --- | --- |
| 1080p, palette 8, cell 8 px | 6840 B/frame | dies at 2 Mbps |
| 1080p, palette 8, cell 12 px | 3017 B/frame | dies at 2 Mbps |
| 1080p, palette 4, cell 10 px | 2907 B/frame | dies at 1 Mbps |
| **1080p, palette 4, cell 12 px** | **2011 B/frame** | **300 kbps** |
| 1080p, palette 4, cell 14 px | 1467 B/frame | 300 kbps |

Two things came out of that. Chroma is the bottleneck, not luminance: 4:2:0
subsampling halves the colour resolution, so four separated colours beat eight
at the same cell size. And the failure is a cliff, not a slope — 10 px cells
fail everywhere, 12 px survive a bitrate an order of magnitude below what either
platform serves. Capacity that does not survive was never capacity.

`repeatFrames: 2` is measured the same way. With one frame per chunk, a platform
re-timing 30 fps to 24 drops a fifth of the chunks and the file is gone. A
second copy survives it; a third only adds bytes.

### Measured on real platforms

Two round trips through platforms that actually re-encode, decoded byte for
byte with the `youtube` profile:

| platform | came back as | corrections | frames lost | result |
| --- | --- | --- | --- | --- |
| WhatsApp | 848x478 h264, 7.0 Mbps | 0.4 per frame | none | identical |
| Telegram | 1280x720 h264, 5.8 Mbps | 0.0 per frame | none | identical |

WhatsApp downscaled by 2.26x, well past the 12 px cell threshold measured
above, and the file still came back. Rescaling is linear, so a cell's average
colour survives shrinking as long as it stays above roughly 3 pixels — what
matters is the cell size at encode time, not in the file that comes back.

Neither test stresses what YouTube does, though: both kept a high bitrate for
their resolution, while YouTube keeps the resolution and cuts the bitrate. That
axis is still only covered by the simulated transcodes.

| profile | frame | capacity | throughput | largest file |
| --- | --- | --- | --- | --- |
| `youtube` | 1920x1080 | 2011 B/frame | ~30 KB per second of video | no limit |
| `instagram` | 1080x1920 | 2031 B/frame | ~30 KB per second of video | ~1.9 MB |

Instagram caps a post at 90 seconds, which caps the file at roughly 1.9 MB.
`encode` refuses an oversized file up front rather than spending minutes in
x264 producing a video the platform will reject.

A 150 KB file becomes 84 data chunks plus 24 parity, 216 frames, 7.2 seconds of
video, and about 5 MB of mp4.

## Commands

```bash
dbforall encode  <file> <out.mp4>       [--platform youtube|instagram] [--crf 14]
dbforall decode  <video|url> [out-file] [--platform youtube|instagram]
dbforall inspect <video|url>            [--platform youtube|instagram]
```

Encode and decode must use the same platform profile. `decode` and `inspect`
accept a URL and fetch it with `yt-dlp`; the original file name and MIME type
travel inside the chunks, so `decode` with no output path restores the name.

`inspect` reads a video without reassembling anything and reports how close to
the edge it ran. Reach for it when a real upload fails to decode:

```
frames    168 read, 168 readable
hamming   1.9 corrections/frame average, 11 worst
chunks    80/84 data, 24 parity
missing   0, 1, 2, 3
verdict   file is recoverable
```

That is a real carrier after a VP9 transcode at 600 kbps, re-timed to 24 fps,
with its first frames cut off: four chunks gone, rebuilt from parity, file
intact. A clean carrier reports 0.0 corrections and nothing missing.

A high correction average means the cells were too small for that platform —
raise `cellSize`. Chunks in `missing` mean frames went away instead — raise
`repeatFrames` or `parityPerGroup`.

## Requirements

`ffmpeg` on PATH for everything, `yt-dlp` on PATH to read from a URL.

```bash
npm install && npm run build && npm test
```

## Limits

- **Upload is manual.** The tool writes an mp4; putting it on a platform and
  getting the URL back is your job. Only downloading is automated.
- **YouTube itself is unverified.** WhatsApp and Telegram round trips pass, but
  neither reproduces YouTube's 1080p bitrate ladder; that part rests on
  simulated transcodes. Reading a video back off YouTube needs an access route
  this project does not have.
- **Instagram is the less tested of the two.** Its geometry was measured the
  same way as YouTube's, but a Reel goes through more than a transcode: the
  app re-frames, and reading one back with `yt-dlp` may need cookies for
  anything not public.
- **No encryption.** The payload sits in the video in the clear. Anyone who
  knows the format reads it.
- **Against the terms of service** of both platforms. The account carrying the
  data can be removed, and with it the data.
