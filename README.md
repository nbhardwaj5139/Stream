# Stream

Watch the movies on your laptop together with someone in another country.

You run one command, it prints two links. You open one, they open the other —
on a PC, an iPad, a phone, whatever. Same movie, same moment, either of you can
pause. Nothing to install on their side.

```
$ node bin/stream.js ~/Movies

Found 38 video files in:
  /Users/you/Movies

Starting public tunnel... done

────────────────────────────────────────────────────────────────
  Your link:   https://quiet-forest-1234.trycloudflare.com/?k=8f2a…
  Their link:  https://quiet-forest-1234.trycloudflare.com/?k=c41b…
────────────────────────────────────────────────────────────────
```

## Why not just share your screen?

You can — there's a **Share screen** button, and it's the right tool when the
thing you want to watch isn't a file you own (a streaming site, a live sports
feed). But for a movie sitting on your disk it's the worse option:

| | Share the file (default) | Share your screen |
|---|---|---|
| Picture | the original, untouched | re-encoded, softer, blocky in dark scenes |
| Audio | original track, perfectly in sync | drifts out of sync over a long film |
| Your laptop | reads a file off disk | encodes video continuously; fans on, battery down |
| Subtitles | real subtitle tracks they can toggle | burned into the picture, if at all |
| If their connection hiccups | it buffers, then catches up | they lose that moment forever |
| Reliability | plain HTTPS; works everywhere | peer-to-peer; sometimes blocked by strict networks |

So: file streaming is the default, and screen share is there for everything else.

## Getting started

**Requirements**

- **Node 18+** — the app itself has zero npm dependencies.
- **ffmpeg** *(recommended)* — needed for `.mkv`, `.avi`, HEVC video and
  AC3/DTS audio, which browsers can't play directly. `.mp4` and `.webm` work
  without it.
- **cloudflared** *(recommended)* — creates the public link. Without it you can
  still watch together on the same Wi-Fi.

```bash
# macOS
brew install ffmpeg cloudflared

# Windows
winget install Gyan.FFmpeg
winget install Cloudflare.cloudflared

# Debian/Ubuntu
sudo apt install ffmpeg
# cloudflared: https://github.com/cloudflare/cloudflared/releases
```

**Run it**

```bash
git clone https://github.com/nbhardwaj5139/Stream.git
cd Stream
node bin/stream.js ~/Movies
```

Send the "their link" to whoever you're watching with. Keep your laptop awake
and the terminal open; when you press Ctrl+C the links stop working.

## Options

```
-d, --dir <path>       Folder to serve (repeatable; default ~/Movies or ~/Videos)
-p, --port <number>    Port to listen on (default 8420)
    --host-only        Only you can play/pause/seek; they just watch
    --no-tunnel        Don't create a public link (LAN only, or bring your own tunnel)
    --no-auto-pause    Don't pause everyone when one side is buffering
    --no-transcode     Never invoke ffmpeg
    --host-key <key>   Reuse a fixed key so your link stays the same between runs
    --guest-key <key>  Same, for their link
```

Reusing keys is handy so you don't have to send a new link every week:

```bash
node bin/stream.js ~/Movies --host-key "$MY_KEY" --guest-key "$HER_KEY"
```

## How the syncing works

The server keeps one piece of truth: *the movie was at position P at server-time
T, playing at rate R*. From that, any browser can work out where it should be
right now.

Each browser measures its clock offset against the server (a few round trips,
keeping the fastest sample, which has the least queuing noise), then compares
where it actually is against where it should be:

- **under 0.25s out** — leave it alone, nobody can tell.
- **0.25s to 1.5s out** — nudge the playback rate by ±6% for a few seconds.
  Time stretches slightly instead of the picture jumping; you don't notice.
- **over 1.5s out** — seek. Something real happened (a stall, a tab that slept).

When either side starts buffering, the room pauses for everyone and shows
*"Waiting for Priya to buffer…"*. When they recover, it resumes. Nobody has to
say "wait, go back" — that's `--no-auto-pause` if you'd rather it didn't.

## What each side can do

| | Host (your link) | Guest (their link) |
|---|---|---|
| Watch, chat | yes | yes |
| Play, pause, seek | yes | yes, unless `--host-only` |
| Choose the movie | yes | yes, unless `--host-only` |
| Share their screen | yes | no |
| Rescan the folder | yes | no |
| See your folder paths | yes | no |

Keyboard: <kbd>space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> jump 10s ·
<kbd>esc</kbd> close the library.

For transcoded files a quality selector appears next to **Re-sync**. It defaults
to **Original**, which keeps ffmpeg in cheap remux mode; picking 1080p/720p/480p
downscales instead, which helps a weak connection but costs you CPU.

## File format support

The server checks each file with `ffprobe` and picks one of two routes:

- **Direct** — `.mp4`/`.webm` holding H.264/VP9/AV1 video and AAC/MP3/Opus audio
  are sent byte-for-byte, with HTTP range requests so seeking is instant. No
  re-encoding, no quality loss, barely any CPU.
- **Transcoded** — everything else goes through ffmpeg into a fragmented MP4.
  Streams that are already browser-safe are copied rather than re-encoded, so a
  typical `.mkv` holding H.264+AC3 only re-encodes the audio: cheap, and the
  picture is untouched. HEVC or VC-1 video does need a real re-encode, which is
  CPU-heavy — expect fans.

Subtitles are found automatically: `Movie.srt`, `Movie.en.srt` and friends next
to the file, plus text tracks embedded in the `.mkv`. SRT and ASS/SSA are
converted to WebVTT on the fly. Bitmap subtitles (PGS, VOBSUB) are not supported
— they're images, and would have to be burned into the picture.

## Known limits

- **Seeking inside a transcoded file restarts ffmpeg** at the new position. It
  takes a second or two to resume. Direct-streamed files seek instantly.
- **Screen share needs a direct connection.** It uses public STUN servers and no
  TURN relay, so on a locked-down corporate or hotel network it may fail to
  connect. File streaming goes over ordinary HTTPS and isn't affected.
- **Your laptop has to stay awake** with the terminal open. On macOS,
  `caffeinate -i node bin/stream.js ~/Movies` stops it sleeping mid-film.
- **Cloudflare quick tunnels get a new address each run.** Fixed keys keep the
  `?k=` part stable, but the domain changes; use a named Cloudflare tunnel if
  you want a permanent URL.
- **Upload speed is the real limit.** A 1080p film is often 8–15 Mbps. If your
  upload can't carry that, drop the quality selector to 720p or 480p — ffmpeg
  will downscale on the fly, at the cost of real CPU work on your laptop.

## Security

The links are the credentials. Anyone with the full link — including the part
after `?k=` — can browse and watch the folders you shared, so treat it like a
password and send it somewhere private.

- Two separate keys, so you can hand out guest access without giving up control.
- Keys are compared in constant time, and a valid one sets an `HttpOnly` cookie
  so the key stops travelling in URLs after the first load.
- Files are addressed by an opaque id, never by a path from the request, so
  there's no way to walk out of the folders you chose.
- Only video files inside the folders you named are ever served.

There's no rate limiting and no TLS of its own — the Cloudflare tunnel provides
HTTPS. This is built for two people who know each other, not for the open web.

## Development

```bash
npm test          # 45 unit and integration tests, no dependencies needed

# optional end-to-end run: two real browsers against a real video file
npm install --no-save playwright
npx playwright install chromium
node test/e2e/browser.mjs /path/to/a/folder/with/a/video
```

The pieces:

| File | Does |
|---|---|
| `bin/stream.js` | CLI, key generation, tunnel startup |
| `src/server.js` | HTTP routes, range streaming, WebSocket wiring |
| `src/room.js` | the shared playback clock — where the movie *should* be |
| `src/ws.js` | a small RFC 6455 WebSocket server (keeps dependencies at zero) |
| `src/media.js` | folder scanning, ffprobe, direct-vs-transcode decision |
| `src/transcode.js` | ffmpeg argument construction |
| `src/subtitles.js` | SRT/ASS → WebVTT |
| `public/app.js` | the player, drift correction, chat, WebRTC screen share |
