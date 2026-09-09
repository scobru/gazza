# dbforall

Store arbitrary files inside a video, so a platform that hosts video hosts your
bytes. The file becomes a grid of coloured cells; the grid survives the
platform's re-encode; the video comes back and the file comes out byte for byte.

```bash
dbforall encode report.pdf carrier.mp4 --encrypt
# upload carrier.mp4 by hand, then:
dbforall decode https://youtu.be/VIDEO_ID
```

Verified end to end on YouTube, Instagram, WhatsApp and Telegram. The numbers below are
measurements, not estimates, and where something has not been verified this
README says so.

## What it costs

| profile | frame | per frame | throughput | overhead |
| --- | --- | --- | --- | --- |
| `youtube` | 1920x1080 | 1114 B | ~16 KB per second of video | ~190x |
| `instagram` | 1080x1920 | 2031 B | ~30 KB per second of video | ~100x |

A 400 KB file becomes 37 seconds of 1080p and about 78 MB of mp4. This is
storage for documents and small archives, not for media libraries.

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

**Parity.** Data chunks are grouped 16 at a time with 4 parity chunks each, so
any 4 of every 20 may vanish entirely. Without it, one lost chunk lost the file.
The generator matrix is Cauchy, not Vandermonde: erasure decoding inverts
whichever rows survived, and only a Cauchy matrix is invertible in *every*
square submatrix. A Vandermonde one fails on particular loss patterns with the
parity sitting right there.

## Measured on real platforms

| platform | came back as | corrections | chunks lost | result |
| --- | --- | --- | --- | --- |
| Telegram | 1280x720 h264, 5.8 Mbps | 0.0 per frame | none | identical |
| WhatsApp | 848x478 h264, 7.0 Mbps | 0.4 per frame | none | identical |
| YouTube | 1920x1080 av1, 4.0 Mbps | 6.8 per frame | 9 of 280 | failed, at 12 px cells |
| YouTube | 1920x1080 h264, 3.2 Mbps | 0.0 per frame | none | identical, at 16 px cells |
| Instagram | 720x1280 h264, 6.9 Mbps | 0.0 per frame | none | identical |

WhatsApp downscaled by 2.26x, well past the cell size the local tests said was
needed, and the file still came back. Rescaling is linear, so a cell's average
colour survives shrinking as long as it stays above roughly three pixels: what
matters is the cell size at encode time, not in the file that comes back.

YouTube is the harsh one, and it broke the first profile. A real upload can come
back as **AV1 at 4 Mbps**, and AV1 destroys far more than VP9 at the same
bitrate - which is what the early simulated transcodes had been measuring. At
12 px cells, 22 frames of 560 were unreadable, 9 chunks of 280 were gone, one
parity group lost both its data and the parity meant to cover it, and the file
did not come back.

Re-measured against AV1 at 4 Mbps:

| cells | per frame | corrections | unreadable |
| --- | --- | --- | --- |
| 12 px | 2011 B | 4.2 per frame | 4 in 92 |
| 14 px | 1467 B | 2.8 per frame | none |
| 16 px | 1114 B | 0.5 per frame | 4 in 172 |

Hence 16 px on YouTube, at 45% of the capacity. A second real upload at 16 px
came back byte for byte: 1104 frames, all readable, no corrections, parity never
needed.

**A codec is not a bitrate.** Measuring against the wrong one flattered the
profile by more than a factor of two.

Instagram caps a Reel at 720x1280, so a 1080x1920 carrier comes back downscaled
by 1.5x - and still decodes without a single correction. The first attempt at
it failed completely, but the platform was not at fault: the downloader asked
for a stream no taller than 1080 px, which reads as sensible until the carrier
is portrait. Instagram's good rendition is 1280 tall, so the cap rejected it and
took a 360x640 one instead, shrinking 12 px cells to 4 px. Reading the same Reel
without the cap recovered the file byte for byte.

## Commands

```bash
dbforall encode  <file> <out.mp4>   [--platform ...] [--encrypt] [--split 60] [--crf 14]
dbforall decode  <video|url>...     [--out file] [--platform ...] [--crop auto|w:h:x:y]
dbforall inspect <video|url>        [--platform ...] [--crop auto|w:h:x:y]
```

Encode and decode must use the same platform profile (default: `youtube`). The
original file name and MIME type travel inside the chunks, so `decode` with no
output path restores the name.

`decode` and `inspect` accept URLs and fetch them with `yt-dlp`, taking the
highest resolution stream and then the highest bitrate. Add `--cookies-from-browser firefox`
when YouTube refuses an anonymous request, which it does for unlisted videos and
under rate limiting. `--stream <id>` forces one specific format.

### Encryption

`--encrypt` seals the file with AES-256-GCM before it becomes chunks. The
password never appears as an argument, where the shell history and the process
list would both keep a copy: it is asked for on the terminal without echo, or
read from `DBFORALL_PASSWORD` for scripts.

The file name and MIME type travel *inside* the ciphertext and the chunk headers
carry `sealed.dbfa` instead, so a carrier on a public platform gives up neither
the contents nor what they were called. The key is PBKDF2-HMAC-SHA256 over
600,000 rounds: a carrier can be downloaded by anyone and attacked offline for
as long as they like, so the only defence is making each guess expensive. GCM
authenticates, so a wrong password and tampered bytes fail identically and
nothing partial is ever written.

There is no recovery. Lose the password and the file is gone.

### Splitting

`--split <seconds>` cuts the carrier into `carrier-001.mp4`, `carrier-002.mp4`
and so on, and Instagram's 90 second cap splits automatically.

No manifest is written and none is needed: every chunk header already carries
the file hash, its own index and the total, so the parts identify themselves.
Hand them back in any order, duplicated or not, and they reassemble.

```bash
dbforall encode archive.zip carrier.mp4 --split 60
dbforall decode https://youtu.be/AAA https://youtu.be/BBB --out archive.zip
```

Chunks from a different file are rejected on sight rather than quietly ignored:
they share the same indices, so treating them as duplicates would decode the
wrong file without a word.

### Diagnosing a failure

`inspect` reads a video without reassembling anything and reports how close to
the edge it ran:

```
frames    168 read, 168 readable
hamming   1.9 corrections/frame average, 11 worst
chunks    80/84 data, 24 parity
missing   0, 1, 2, 3
verdict   file is recoverable
```

- A **high correction average** means the cells were too small for that
  platform: raise `cellSize`.
- **Chunks in `missing`** mean frames went away instead: raise `repeatFrames` or
  `parityPerGroup`. The error says which of the two a parity group ran out of.
- **`looks untouched`** on the source line means the bitrate is still near our
  own encoder's, so no platform ever re-encoded the file - a round trip that
  proves nothing.
- **Nothing decoded at all** usually means the grid does not fill the frame.
  `--crop auto` finds it inside a screen recording, letterboxing, or a player
  that was not fullscreen.

## Uploading

Upload the file as it is. If the platform offers cropping, filters or
stabilisation, skip all of it: a crop moves the grid and no amount of error
correction brings it back. Wait for the full resolution version to finish
processing before reading it back - immediately after an upload only a
downscaled rendition exists, and the cells do not survive it.

## Requirements

`ffmpeg` on PATH for everything, `yt-dlp` on PATH to read from a URL.

```bash
npm install && npm run build && npm test
```

## Layout

```
packages/core/  chunk.ts     binary chunk format, split and assemble
                frame.ts     optical grid, calibration, interleaving
                profiles.ts  measured platform profiles
                groups.ts    Reed-Solomon across chunks
                box.ts       AES-256-GCM sealing
                crc32, hamming, reedsolomon, palette
packages/cli/   pipeline.ts  ffmpeg streaming, crop detection, inspection
                index.ts     the command line
```

## Limits

- **The 16 px YouTube profile has not made a full AV1 round trip.** It comes
  from reproducing AV1 at 4 Mbps locally after a real upload failed at 12 px;
  the successful upload that followed came back as h264. YouTube generates AV1
  renditions late and not for every video.
- **Upload is manual.** The tool writes an mp4; putting it on a platform and
  getting the URL back is your job. Only downloading is automated.
- **Against the terms of service** of both platforms. The account carrying the
  data can be removed, and with it the data.
