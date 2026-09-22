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
    --auto-pause          Pause everyone while one side buffers (off by default)
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

### Giving someone a subdomain of yours

A friend can run their own room on your domain without touching your Cloudflare
account:

```bash
node bin/setup-tunnel.js friend.example.com --for-someone-else
```

That creates the tunnel and the DNS record on your account, then writes a
folder holding the tunnel's credentials, a matching config, and instructions.
Send them the folder.

The credentials authorise **that one tunnel** and nothing else — they cannot
reach your other records, your other tunnels, or your account, and
`cloudflared tunnel delete friend` revokes it. They can point it at anything on
their own machine, though, so the hostname is theirs to use as they like: a
question of trust rather than of permissions.

Their room is entirely separate from yours — own server, own passcodes, own
guests. If they would rather not depend on your domain at all, running
`node bin/stream.js` with no tunnel options gives them a free throwaway address
and needs nothing from you.

**Watch on the host machine using `http://localhost:8420`, not your domain.**
Going through the tunnel sends the film out to Cloudflare and straight back,
so your upload carries it twice and both of you stutter. The local address
plays it off the disk and leaves the whole connection for her. The startup
banner prints both.

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

`--auto-pause` will pause the room for everyone while one side buffers and
resume when they recover, so nobody has to say "wait, go back". It is **off by
default**, because on a connection that is marginal rather than fine it
oscillates: pause, resume, stall, pause again, which is worse to watch than a
bit of drift. When it is on, the wait is capped at 30 seconds so a viewer who
never becomes playable cannot hold the film indefinitely.

## Sharing your screen instead

**Share screen** is the main button, host only, and the one to reach for first:
it carries anything your machine can play, at any resolution, to any browser. It switches
the room from playing a file to sending whatever is on your screen, over a
direct connection to each viewer. The picture never passes through the server.

Use it when the file route is fighting you. It has one decisive advantage: it
measures the link continuously and drops quality to fit. An HTTP stream picks a
bitrate and stalls when the connection cannot keep up; a screen share goes soft
for a second and carries on. On a connection that is merely adequate, that is
the difference between watching a film and managing one.

It also sidesteps formats entirely. Nothing is transcoded, no container is
negotiated, and a browser that struggles with your files will show a shared
screen without complaint.

What it costs:

- **Quality.** The picture is captured and re-encoded live, so it is softer than
  the file, and dark scenes band. It goes out at 1080p by default, whatever the
  monitor is showing. `--share-quality 1440` or `2160` will send more, but the
  ceiling is your upload, not the setting: 1080p wants about 8 Mbps sustained
  and 4K about 28. Ask for more than the connection carries and WebRTC simply
  drops back down, having spent the CPU for nothing.
- **Your laptop encodes continuously** while it runs.
- **Sound needs the right option in the picker.** On Windows, Chrome offers
  audio for **Entire Screen** and for a **Chrome Tab**, and never for a single
  window — which is the option most people try first, because it is the one
  that names the app they are playing. To share a film from VLC you want
  *Entire Screen* with "Share system audio" ticked. The room says so before the
  picker opens and again if nothing came through, and if the machine refuses
  audio entirely the share continues without it rather than failing.
- **It needs a connection the two networks will allow.** Public STUN is used by
  default, which is enough when both routers accept an incoming connection.
  Some mobile carriers and locked-down networks will not, and then nothing
  connects without a relay to pass the media through:

  ```bash
  node bin/stream.js --turn turn:relay.example.com:3478 \
                     --turn-user someone --turn-pass secret
  ```

  Any TURN service works; several offer a free tier that is ample for two
  people. File streaming is plain HTTPS through the tunnel and never has this
  problem — which is the main reason to keep it.

  **Find out before it matters.** Open the chat panel and press **Test link**.
  It opens the same kind of connection a share would need, carrying a few bytes
  instead of a film, and says what happened: connected directly, connected
  through a relay, or could not connect — in which case a relay is what you
  need. Both sides have the button, and it takes a few seconds. Far better on a
  Tuesday than with someone waiting.

- **A connection that drops is offered again.** Films are long and networks are
  not perfect. A failed peer connection is re-offered with backoff — a second,
  then two, then four, up to about a minute of trying — and the room says
  "Connection dropped — reconnecting…" while it does. Only the side holding the
  picture retries; the other waits to be offered. After eight attempts it stops
  and says so rather than retrying into the void.

Playback controls do nothing during a share, because a live stream has nothing
to seek. Picking a film from the library ends the share by itself, and the room
comes out of screen mode by itself if whoever was sharing closes their tab.

**If the picture arrives without sound on an iPhone or iPad**, check the
ring/silent switch on the side of the device first. iOS mutes inline video when
that switch is set to silent, no matter what the page does. Beyond that, a
browser will not start a video with sound until someone touches the page, so
the picture starts muted and the room says *"Tap anywhere for sound"* until it
is tapped.

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
  If she keeps buffering, drop a step — that's what the selector is for. And
  watch locally yourself, or your upload is carrying the film twice.
- **Two browsers needing different formats means two encodes.** Chrome takes
  fragmented MP4 and Safari takes HLS, so a laptop and an iPhone watching the
  same converted film run ffmpeg twice. A GPU encoder shrugs at that; software
  x264 will not.
- **A shared screen is capped at 1080p and is not the original picture.** It is
  a live re-encode of what your monitor shows. For the file route, 4K is capped
  by your upload rather than by the code.

## Security

The passcode is the credential. Anyone who has the link *and* the passcode can
browse and watch the folders you shared.

- Passcodes are new for every session by default, so a code that leaks is only
  good until you restart.
- Case is not part of a passcode. The field renders uppercase, phone keyboards
  capitalise and laptop keyboards do not, so a code read off a screen and typed
  back has to work either way.
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
npm test          # 135 unit and integration tests, no dependencies needed

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
| `public/screen.js` | WebRTC screen sharing, audio negotiation, reconnection |
| `public/probe.js` | the connection test, and what it means |
