# gazza

**English** · [Italiano](README.it.md)

*A magpie steals shiny things and hides them where nobody looks.*

Store arbitrary files inside a video, so a platform that hosts video hosts your
bytes. The file becomes a grid of coloured cells; the grid survives the
platform's re-encode; the video comes back and the file comes out byte for byte.

```bash
gazza encode report.pdf carrier.mp4 --encrypt
# upload carrier.mp4 by hand, then:
gazza decode https://youtu.be/VIDEO_ID
```

Verified end to end on YouTube, Instagram, WhatsApp and Telegram. The numbers below are
measurements, not estimates, and where something has not been verified this
README says so.

## What it costs

| profile | frame | per frame | throughput | notes |
| --- | --- | --- | --- | --- |
| `youtube` | 1920x1080 | 1114 B | ~16 KB per second of video | 16 px cells, sized for AV1 |
| `instagram` | 1080x1920 | 2031 B | ~30 KB per second of video | portrait, 90 s per post |
| `telegram` | 1920x1080 | 2011 B | ~29 KB per second of video | send as video, not as a document |
| `whatsapp` | 1920x1080 | 2011 B | ~29 KB per second of video | send as video; heavy size limits |
| `googlephotos` | 1920x1080 | 1114 B | ~16 KB per second of video | storage saver; download the file, links do not work |

YouTube costs the most per byte because it is the only one that re-encodes to
AV1, which needs bigger cells. The others keep a generous bitrate for the
resolution they downscale to, so 12 px cells are enough.

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
| YouTube | 1920x1080 h264, 2.1 Mbps | 0.0 per frame | none | identical, sealed payload |
| Instagram | 720x1280 h264, 6.9 Mbps | 0.0 per frame | none | identical |
| Google Photos | storage saver | not measured | none | identical, at 16 px cells |

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
needed. A third, this one sealed and served at 2.1 Mbps, did the same - the
lowest bitrate YouTube has handed back so far, and the error correction still
had nothing to do.

**A codec is not a bitrate.** Measuring against the wrong one flattered the
profile by more than a factor of two.

Instagram caps a Reel at 720x1280, so a 1080x1920 carrier comes back downscaled
by 1.5x - and still decodes without a single correction. The first attempt at
it failed completely, but the platform was not at fault: the downloader asked
for a stream no taller than 1080 px, which reads as sensible until the carrier
is portrait. Instagram's good rendition is 1280 tall, so the cap rejected it and
took a 360x640 one instead, shrinking 12 px cells to 4 px. Reading the same Reel
without the cap recovered the file byte for byte.

## Local web interface

A browser front end for encoding, if the command line is not where you want to
be. It is the same pipeline underneath - same profiles, same parity, same
ffmpeg - only driven from a page.

```bash
npm run web:dev      # http://127.0.0.1:4321
```

**Encode.** Choose a file, pick a platform, optionally a password, and it says how long the video will
run, roughly how large it will be and how many chunks it takes *before* encoding
anything. If the result would exceed what a platform accepts per video, it says
so and offers to split rather than letting you find out after the upload.

**Decode.** Paste the links, one per line, or drop the carrier videos - several
parts at once is fine. If the first attempt finds no grid it retries looking for
one inside the frame, which covers a screen recording or a platform that
letterboxed the upload. A sealed carrier asks for its password.

The server binds to loopback only: it reads file contents and shells out to
ffmpeg, so it has no business being reachable from the network.

Both panes take a password. It travels in a request header rather than the
query string, because a URL is kept in browser history and written to any access
log in the way. Encoding asks for it twice: a typo cannot be undone later.

## Commands

```bash
gazza encode  <file> <out.mp4>   [--platform ...] [--encrypt] [--split 60] [--crf 14]
gazza decode  <video|url>...     [--out file] [--platform ...] [--crop auto|w:h:x:y]
gazza inspect <video|url>        [--platform ...] [--crop auto|w:h:x:y]
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
read from `GAZZA_PASSWORD` for scripts.

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
gazza encode archive.zip carrier.mp4 --split 60
gazza decode https://youtu.be/AAA https://youtu.be/BBB --out archive.zip
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

Google Photos is the one host where the video wrapper earns its overhead
outright: an encrypted file cannot be stored there at all, a video can. Anywhere
that keeps files as they are - a shared drive, object storage - the wrapper is
pure cost, roughly 190x, and encrypting the file on its own is strictly better.

Uploading is yours to do, on purpose. The tool writes an mp4 and reads one back;
what happens in between is a decision about which account, which platform and
which risk, and none of that belongs in a library. Automating it would also mean
publishing on a schedule, which is the behaviour that gets an account closed.

Upload the file as it is. If the platform offers cropping, filters, music or
stabilisation, skip all of it: a crop moves the grid and no amount of error
correction brings it back.

Wait for the full resolution version to finish processing before reading it
back. Immediately after an upload only a downscaled rendition exists, and the
cells do not survive it - `yt-dlp -F <url>` shows what is ready.

On Instagram, post a **Reel**, not a feed video: the feed crops to 4:5 while
Reels keep the full 9:16. Post from a public account, or reading it back needs
cookies.

On Telegram and WhatsApp, send the carrier **as a video, from the gallery** -
not as a document. A document is transported untouched, which sounds better and
is not: nothing re-encodes it, so nothing about it is tested, and WhatsApp
enforces tight size limits on video anyway. Use `--split` there.

## Running it as a container

`ffmpeg`, `ffprobe` and `yt-dlp` are all in the image, so nothing has to be
installed on the host.

```bash
docker compose up -d --build    # http://127.0.0.1:4321
```

For [CapRover](https://caprover.com), the `captain-definition` in the root points
at the same Dockerfile:

```bash
caprover deploy
```

### Running it where anyone can reach it

`.env.example` lists every setting with what it is for, and the defaults are
the safe posture: copy the lines you want rather than all of them.

A public instance is a video encoder handed to strangers, so it refuses more
than it accepts. All of these are environment variables:

| | default | what it stops |
| --- | --- | --- |
| `GAZZA_MAX_FILE` | 8 MB | a file read into memory without a ceiling |
| `GAZZA_MAX_VIDEO` | 256 MB | the same on the decode side, streamed to disk |
| `GAZZA_MAX_QUEUE` | 4 | requests piling up behind one another |
| `GAZZA_JOB_TTL_MS` | 30 min | carriers nobody collected filling the disk |
| `GAZZA_ALLOW_URLS` | off | **the important one** - see below |
| `GAZZA_URL_HOSTS` | youtube, youtu.be, instagram | where a link may point |
| `GAZZA_TOKEN` | unset | anyone using it at all |

Only one encode runs at a time: ffmpeg is CPU-bound and running several does
not finish them sooner, it just runs the machine out of cores.

**Fetching links is off by default**, and turning it on is a decision about
bandwidth rather than a gamble. A link means this server makes a request of the
caller's choosing, so two things bound it: the host has to be one of
`GAZZA_URL_HOSTS`, matched on a dot boundary so `evil-youtube.com` is not
`youtube.com`, and the download is capped at `GAZZA_MAX_VIDEO`, because
otherwise a link to a ten hour recording would fill the disk. Neither the
private network nor unbounded storage is reachable through it.

**Read this before exposing it.** The server binds loopback on a workstation
and every interface inside a container, which it detects for itself; `HOST`
overrides both. The compose file publishes it on `127.0.0.1` only. That is
deliberate: whoever reaches gazza can spend your CPU on ffmpeg and read whatever
they decode through her. Put authentication in front - CapRover's basic auth is
enough - before letting anyone else near it. She will say so in her own logs if
you bind beyond loopback.

Carriers live in `/tmp` and are deleted once collected, so there is no volume to
mount and nothing to back up. Compose mounts that as a 2 GB tmpfs: a 400 KB file
becomes 78 MB of mp4 that exists only until it is downloaded, and that is better
kept out of the disk.

## Why not serverless

Vercel and friends cannot host this. The request and response bodies are capped
around 4.5 MB while gazza moves tens of megabytes per operation; a 400 KB file
takes about 40 seconds of x264, against a 60 second function limit; and ffmpeg,
ffprobe and yt-dlp are not there to begin with. A container is the right shape
for it.

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
packages/web/   server.ts    loopback server, estimates and progress
                index.html   the page, no framework and no build step
```

## Limits

- **Google Photos cannot be read back from a link.** There is no yt-dlp
  extractor for it, so the video has to be downloaded from the album by hand and
  passed as a file. The round trip itself works: 1662 frames, none unreadable,
  parity never needed. Its cell size was inherited from YouTube rather than
  measured for it, so the margin is unknown, only sufficient.
- **The 16 px YouTube profile has not made a full AV1 round trip.** It comes
  from reproducing AV1 at 4 Mbps locally after a real upload failed at 12 px;
  the successful upload that followed came back as h264. YouTube generates AV1
  renditions late and not for every video.
- **Against the terms of service** of these platforms. The account carrying the
  data can be removed, and with it the data.

## Getting started

```bash
git clone https://github.com/scobru/gazza.git
cd gazza
npm install && npm run build && npm test
```

Then either the command line:

```bash
node packages/cli/dist/index.js encode report.pdf carrier.mp4 --encrypt
```

or the page:

```bash
npm run web:dev      # http://127.0.0.1:4321
```

---

Made by [scobru](https://github.com/scobru) · [github.com/scobru/gazza](https://github.com/scobru/gazza) · MIT
