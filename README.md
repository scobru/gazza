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

| platform | came back as | corrections | chunks lost | result |
| --- | --- | --- | --- | --- |
| WhatsApp | 848x478 h264, 7.0 Mbps | 0.4 per frame | none | identical |
| Telegram | 1280x720 h264, 5.8 Mbps | 0.0 per frame | none | identical |
| YouTube | 1920x1080 av1, 4.0 Mbps | 6.8 per frame | 9 of 280 | failed, at 12 px cells |
| YouTube | 1920x1080 h264, 3.2 Mbps | 0.0 per frame | none | identical, at 16 px cells |

WhatsApp downscaled by 2.26x, well past the 12 px cell threshold measured
above, and the file still came back. Rescaling is linear, so a cell's average
colour survives shrinking as long as it stays above roughly 3 pixels — what
matters is the cell size at encode time, not in the file that comes back.

YouTube is the harsh one, and it broke the profile. A real upload comes back as
**AV1 at 4 Mbps**, and AV1 destroys far more than VP9 does at the same bitrate -
which is what the simulated transcodes had been measuring. At 12 px cells, 22
frames of 560 were unreadable, 9 chunks of 280 were gone, and one parity group
lost both data and the parity that would have covered it. The file did not come
back.

Re-measured against AV1 at 4 Mbps, cells of 16 px bring the damage back down to
0.5 corrections per frame, so that is what the `youtube` profile now uses. It
costs 45% of the capacity. A second real upload at 16 px came back byte for
byte: 1104 frames, all readable, no corrections, parity never needed.

That second round trip came back as h264 rather than AV1, so it does not by
itself retire the AV1 result - it confirms the retuned profile against the
gentler of the two streams YouTube serves. The 16 px sizing rests on the local
AV1 measurement.

The lesson generalises: a codec is not a bitrate. Measuring against the wrong
codec flattered the profile by more than a factor of two.

| profile | frame | capacity | throughput | largest file |
| --- | --- | --- | --- | --- |
| `youtube` | 1920x1080 | 1114 B/frame | ~17 KB per second of video | no limit |
| `instagram` | 1080x1920 | 2031 B/frame | ~30 KB per second of video | ~1.9 MB |

Instagram caps a post at 90 seconds, which caps the file at roughly 1.9 MB.
`encode` refuses an oversized file up front rather than spending minutes in
x264 producing a video the platform will reject.

A 150 KB file becomes about 150 data chunks plus parity on the YouTube profile,
roughly 12 seconds of video.

## Commands

```bash
dbforall encode  <file> <out.mp4>       [--platform youtube|instagram] [--crf 14]
dbforall decode  <video|url> [out-file] [--platform youtube|instagram]
dbforall inspect <video|url>            [--platform youtube|instagram]
```

## Splitting

At roughly 17 KB per second of video, a large file makes an unwieldy one.
`--split <seconds>` cuts the carrier into `carrier-001.mp4`, `carrier-002.mp4`
and so on, and Instagram's 90 second cap splits automatically.

No manifest is written and none is needed. Every chunk header already carries
the file hash, its own index and the total, so the parts identify themselves:
hand them back in any order, duplicated or not, and they reassemble.

```bash
dbforall encode archive.zip carrier.mp4 --split 60
dbforall decode https://youtu.be/AAA https://youtu.be/BBB --out archive.zip
```

Chunks from a different file are rejected on sight rather than quietly ignored:
they share the same indices, so treating them as duplicates would decode the
wrong file without a word.

## Encryption

`--encrypt` seals the file with AES-256-GCM before it becomes chunks. The
password never appears as an argument, where the shell history and the process
list would both keep a copy: it is asked for on the terminal, or read from
`DBFORALL_PASSWORD` for scripts.

The file name and MIME type travel *inside* the ciphertext, and the chunk
headers carry `sealed.dbfa` instead, so a carrier on a public platform gives up
neither the contents nor what they were called. Decoding asks for the password
and restores the original name.

The key is PBKDF2-HMAC-SHA256 over 600,000 rounds: a carrier can be downloaded
by anyone and attacked offline for as long as they like, so the only defence is
making each guess expensive. GCM authenticates, so a wrong password and tampered
bytes fail identically and nothing partial is ever written.

There is no recovery. Lose the password and the file is gone.

## Commands, continued

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
- **The YouTube profile has not been re-verified end to end.** The 16 px cells
  come from reproducing AV1 at 4 Mbps locally after a real upload failed at
  12 px; the corrected profile has not itself made the full round trip yet.
- **Instagram rests on VP9 measurements**, the same yardstick that flattered
  YouTube. Treat its capacity as provisional until a real Reel confirms it.
- **Instagram is the less tested of the two.** Its geometry was measured the
  same way as YouTube's, but a Reel goes through more than a transcode: the
  app re-frames, and reading one back with `yt-dlp` may need cookies for
  anything not public.
- **Against the terms of service** of both platforms. The account carrying the
  data can be removed, and with it the data.
