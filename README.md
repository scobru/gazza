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

| profile | frame | capacity | throughput |
| --- | --- | --- | --- |
| `youtube` | 1920x1080 | 2011 B/frame | ~30 KB per second of video |
| `instagram` | 1080x1920 | 2031 B/frame | ~30 KB per second of video |

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
- **Not verified against a real platform.** Every number here comes from a
  local VP9 transcode standing in for the real thing. A live upload may do
  things ffmpeg does not — sharpening, cropping, overlays.
- **No encryption.** The payload sits in the video in the clear. Anyone who
  knows the format reads it.
- **Against the terms of service** of both platforms. The account carrying the
  data can be removed, and with it the data.
