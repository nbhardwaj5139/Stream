# Stream

Watch the movies on your laptop together with someone in another country.

You run one command and get a link and a passcode. You text her both. She opens
the link on a PC, an iPad, a phone — anything with a browser — types the
passcode, and she's in the room. Same movie, same moment, either of you can
pause. Nothing to install on her side, no account to create.

```
$ node bin/stream.js "D:\Movies"

Found 38 video files in:
  D:\Movies

  Using h264_nvenc for 4K re-encoding (GPU accelerated).

Starting public link... done

──────────────────────────────────────────────────────────────
  Send her this link and this passcode:

    https://quiet-forest-1234.trycloudflare.com
    passcode:  K7M4PQ

  Your own passcode (same link):  R3XB9T
──────────────────────────────────────────────────────────────
```

The passcode is never in the URL, so the link is safe to paste anywhere. She
enters it once and her browser remembers her for 30 days.

## Getting started

**Requirements**

- **Node 18+** — the app itself has zero npm dependencies.
- **ffmpeg** — needed for `.mkv`, `.avi`, HEVC video, AC3/DTS audio, and
  anything 4K. Only plain `.mp4`/`.webm` work without it.
- **cloudflared** *(recommended)* — creates the public link. Without it you can
  still watch together on the same Wi-Fi.

```powershell
winget install Gyan.FFmpeg
winget install Cloudflare.cloudflared
```

```bash
# macOS / Linux
brew install ffmpeg cloudflared
```

**Run it**

```bash
git clone https://github.com/nbhardwaj5139/Stream.git
cd Stream
node bin/stream.js "D:\Movies"
```

After the first run it remembers the folder and the address, so from then on
you can just double-click `start.cmd` (or run `start.sh` on macOS/Linux). Both
work from any directory — they find the project themselves, which `node
bin/stream.js` cannot do if you are not already inside the folder.

Keep your laptop awake and the terminal open. When you press Ctrl+C the link
stops working.

New passcodes are generated every time you start it, so last week's code stops
working when the evening ends. Pass `--keep-passcodes` to reuse the previous
set, or `--passcode` / `--host-passcode` to pin your own.

The passcode is asked for every time the page is opened, including a reload —
loading the page drops the session, and the passcode screen is part of the page
rather than a separate one, so joining never navigates away from it.

## Options

```
-d, --dir <path>          Folder to serve (repeatable; default ~/Movies or ~/Videos)
-p, --port <number>       Port to listen on (default 8420)
    --passcode <code>     Set her passcode instead of generating one
    --host-passcode <code>  Set your own passcode
    --keep-passcodes      Reuse last session's passcodes instead of new ones
    --host-only           Only you can play/pause/seek; she just watches
    --shared-library      Let her browse your files too (default: host only)
    --room-name <text>    Heading on the passcode screen
    --no-tunnel           Don't create a public link (same Wi-Fi only)
    --no-auto-pause       Don't pause everyone when one side is buffering
    --no-transcode        Never invoke ffmpeg
    --software-encoding   Force CPU encoding even if a GPU encoder exists
```

## Using your own domain

A quick tunnel gets a new address on every restart. If you own a domain on
Cloudflare, a **named tunnel** gives you one permanent address instead, so the
link you sent her keeps working forever.

One-time setup — this does all of it, and is safe to re-run:

```bash
node bin/setup-tunnel.js movies.example.com
```

It logs you in (a browser opens; pick your domain), creates the tunnel, points
the DNS record at it, and writes cloudflared's config file — backing up any
config you already had. Every step is skipped if it's already done.

If you'd rather do it by hand, it's these four:

```bash
cloudflared tunnel login
cloudflared tunnel create movies
cloudflared tunnel route dns movies movies.example.com
# then write ~/.cloudflared/config.yml (%USERPROFILE%\.cloudflared\config.yml
# on Windows) with an ingress block for the hostname, and a
# `- service: http_status:404` catch-all after it
```

Either way, then run:

```bash
node bin/stream.js "D:\Movies" --tunnel-name movies --hostname movies.example.com
```

If you already run cloudflared as a background service, leave it alone and just
tell the app what address to print:

```bash
node bin/stream.js "D:\Movies" --hostname movies.example.com --no-tunnel
```

Either way your laptop still has to be awake and running the server — Cloudflare
is a front door, not a host.

### What a domain does and doesn't protect

It genuinely gives you:

- **Real HTTPS** on a certificate for your own domain.
- **No open ports and no exposed home IP.** The tunnel dials out; nothing on
  your router is forwarded inward, and your address never appears in DNS.
- **DDoS filtering** at Cloudflare's edge, before anything reaches your laptop.

It does not, by itself, keep anyone out. The passcode is still the only thing
standing between a visitor and your library, and a permanent domain is *more*
discoverable than a random quick-tunnel address, not less — every certificate
Cloudflare issues for `movies.example.com` is published in the public
Certificate Transparency logs, which people scan. Expect strangers to find the
door eventually; the rate limiter is what makes that boring rather than
dangerous.

If you want a real second lock, put **Cloudflare Access** in front of the
hostname (Zero Trust → Access → Applications). It's free for small numbers of
users, and it authenticates people at Cloudflare's edge — by email one-time
code, Google, whatever — so an unauthorised visitor never reaches your laptop
at all. Then the passcode becomes the second factor rather than the only one.
The one cost is that she has to pass Cloudflare's login as well as the
passcode, which is more friction on an iPad.

One caveat worth knowing: Cloudflare's self-serve terms restrict using the
proxy to serve large volumes of video. Two people watching a film a week is
not what that rule is aimed at, but sustained heavy streaming through an
orange-clouded hostname has gotten people warned before. If that matters to
you, Tailscale is the alternative — no ToS question, at the cost of installing
an app on her device.

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
*"Waiting for Priya to buffer…"*. When she recovers, it resumes. Nobody has to
say "wait, go back" — that's `--no-auto-pause` if you'd rather it didn't.

## Quality, and what 4K actually costs

There are two ways a file reaches her, and the quality selector in the player
picks between them:

**Original** sends the file byte-for-byte with HTTP range requests. No
re-encoding, no quality loss, seeking is instant, and your laptop barely does
any work. This is the real thing — the original picture and the original audio
track, surround included.

**1080p / 720p / 480p** runs the file through ffmpeg. Streams that are already
browser-safe get copied rather than re-encoded, so a typical `.mkv` holding
H.264 + AC3 only re-encodes the audio — the picture is untouched.

For 4K, "original" is usually a lie you can't afford. A 4K remux runs 40–80
Mbps; no home upload link carries that, and her connection can't receive it. So
when you pick a 4K file the room **starts at 1080p on purpose**. You can push it
back to Original if your upload is genuinely fast enough, but that is the honest
default.

Three things follow from that, and they're the difference between 4K looking
right and looking terrible:

- **Hardware encoding.** Re-encoding 4K with the CPU cannot keep up in real
  time — it will stutter. The server looks for `h264_nvenc` (NVIDIA),
  `h264_qsv` (Intel) or `h264_amf` (AMD) and uses whichever it finds, and tells
  you at startup which one it picked. If it says `libx264`, 4K will be rough.
- **HDR tone mapping.** Most 4K is HDR. Re-encoding HDR to SDR without tone
  mapping produces a washed-out grey picture — the single most common way
  transcoded 4K gets ruined. The server detects HDR from the colour transfer
  and applies a Hable tone map. This needs an ffmpeg built with `zimg`; the
  standard Windows builds have it.
- **Surround audio survives.** AC3/DTS has to become AAC for browsers, but the
  channel layout is kept rather than flattened to stereo, at 384 kbps for 5.1.
  Her device downmixes if it needs to.

Subtitles are found automatically: `Movie.srt`, `Movie.en.srt` and friends next
to the file, plus text tracks embedded in the `.mkv`. SRT and ASS/SSA are
converted to WebVTT on the fly. Bitmap subtitles (PGS, VOBSUB) are not supported
— they're images, and would have to be burned into the picture.

## What each side can do

| | Host (your passcode) | Guest (her passcode) |
|---|---|---|
| Watch, chat | yes | yes |
| Play, pause, seek | yes | yes, unless `--host-only` |
| **See the file list** | yes | **no**, unless `--shared-library` |
| Choose the movie | yes | no, unless `--shared-library` |
| Change quality | yes | yes |
| Rescan the folder | yes | no |
| See your folder paths | yes | no |

By default a guest never sees what's on your disk — only the film that's
playing right now. That isn't just a hidden button: the file list is left out
of everything sent to her, and the streaming routes refuse any id that isn't
the current film, so an id kept from an earlier evening stops working the
moment you change films. `--shared-library` lets her browse and pick if you
want that instead.

Keyboard: <kbd>space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> jump 10s ·
<kbd>esc</kbd> close the library.

## Known limits

- **Seeking in a transcoded file restarts ffmpeg** at the new position, so it
  takes a second or two to resume. Original-quality files seek instantly.
- **Your laptop has to stay awake** with the terminal open.
- **Cloudflare quick tunnels get a new address each run.** The passcode stays
  the same, but the domain changes. Use your own domain with a named tunnel
  (see above) for an address that never changes.
- **Upload speed is the real ceiling.** 1080p is roughly 8 Mbps, 720p about 4.
  If she keeps buffering, drop a step — that's what the selector is for.
- **This does not share your screen.** It plays files from the folders you
  chose. Anything that isn't a file on your disk is out of scope.

## Security

The passcode is the credential. Anyone who has the link *and* the passcode can
browse and watch the folders you shared.

- Passcodes are new for every session by default, so a code that leaks is only
  good until you restart.
- Passcodes are hashed with scrypt and compared in constant time.
- Wrong guesses are rate limited per address, with a global cap so the guessing
  can't just be spread across many addresses. Five wrong tries locks that
  address out for fifteen minutes.
- A correct passcode is exchanged for a signed, `HttpOnly` session cookie. The
  passcode itself is never in a URL, so it can't leak through browser history,
  referrer headers or a screenshot of the address bar.
- Files are addressed by an opaque id, never by a path from the request, so
  there's no way to walk out of the folders you chose.
- Only video files inside those folders are ever served.
- Behind a tunnel the real visitor is read from `CF-Connecting-IP`, so the rate
  limiter counts people rather than lumping everyone into one bucket.

There's no TLS of its own — the Cloudflare tunnel provides HTTPS. This is built
for two people who know each other, not for the open web.

## Development

```bash
npm test          # 107 unit and integration tests, no dependencies needed

# optional: two real browsers against a real video file, end to end
npm install --no-save playwright
npx playwright install chromium
node test/e2e/browser.mjs /path/to/a/folder/with/a/video
```

| File | Does |
|---|---|
| `start.cmd` / `start.sh` | double-clickable launchers that work from anywhere |
| `bin/stream.js` | CLI, passcode generation and persistence, tunnel startup |
| `src/roots.js` | turning command-line arguments into folders to serve |
| `bin/setup-tunnel.js` | one-time wiring of a permanent address on your domain |
| `src/cloudflare.js` | tunnel discovery and cloudflared config generation |
| `src/server.js` | HTTP routes, range streaming, WebSocket wiring |
| `src/auth.js` | passcode hashing, session cookies, brute-force limiting |
| `src/room.js` | the shared playback clock — where the movie *should* be |
| `src/ws.js` | a small RFC 6455 WebSocket server (keeps dependencies at zero) |
| `src/media.js` | folder scanning, ffprobe, HDR and bitrate detection |
| `src/transcode.js` | encoder selection, HDR tone mapping, ffmpeg arguments |
| `src/hls.js` | HLS segmenting, for Safari and anything else fussy |
| `src/subtitles.js` | SRT/ASS → WebVTT |
| `public/app.js` | the player, drift correction, chat |
