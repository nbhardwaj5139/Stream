# Stream

Share your screen, sound and all, with someone far away — to watch a film
together from opposite sides of the world.

You press one button on your laptop and get a link and a passcode. The other
person opens the link on a PC, an iPad, a phone — anything with a browser —
types the passcode, and sees your screen. Play the film in VLC, a browser, or
anything else, and it arrives on their side with its sound. Nothing to install
on their side, no account to create.

```
══════════════════════════════════════════════════════════════
  READY. Send them the link and passcode above.

  Then on THIS laptop open  https://movies.example.com
  sign in with  R3XB9T  and click "Share screen".

  Pick "Entire Screen" and tick "Share system audio" —
  that tickbox is the only way the sound travels.
══════════════════════════════════════════════════════════════
```

The picture goes straight from your browser to theirs. It never passes through
the server or through Cloudflare, which only carries the page and the
handshake.

## Setting a laptop up (Windows)

Once per laptop. Download **`Install-Stream.cmd`** from this repository (open
the file on GitHub, then *Download raw file*) and double-click it.

Windows will say *"Windows protected your PC"* the first time, because the file
came from the internet: click **More info → Run anyway**.

It then does everything, checking first whether each step is already done, so
running it again is always safe:

1. installs whichever of Git, Node.js and cloudflared are missing
2. downloads this project to your user folder
3. opens a browser to log in to Cloudflare — pick your domain
4. asks, in a normal Windows box, which address to use (e.g.
   `movies.example.com`), and sets up a tunnel for it named after this
   computer, so two laptops never share one
5. puts a **Start Stream** button on the desktop, and makes it start by itself,
   minimised, whenever you log in
6. asks whether to keep the laptop awake while it is on the charger — a
   sleeping laptop takes the site down with it

Your domain has to be on Cloudflare. Setting up a second laptop moves the
address to it; the first one stops answering.

## Every time

1. **Start Stream** — or nothing at all, if it starts with Windows.
2. Wait for **READY** in its window. It says so only once the link actually
   works; if it cannot connect it says **NOT READY** and why, and keeps trying
   by itself — handy when Windows starts before the Wi-Fi does.
3. Open the link, sign in with **your** passcode, press **Share screen**, pick
   **Entire Screen**, and tick **Share system audio**.
4. Send the other person the link and **their** passcode.

Leave that window open (minimised is fine) — closing it takes the site down.
Each time it starts it first pulls the latest version of the project, and
carries on with what it has if that fails.

## On the other side

Open the link, type the passcode (capitals don't matter), and wait. The screen
appears by itself when it is shared.

**If the picture arrives without sound on an iPhone or iPad**, check the
ring/silent switch on the side first: iOS mutes video when it is set to silent,
whatever the page does. Beyond that, no browser will start a video with sound
until someone touches the page, so it starts muted and says *"Tap anywhere for
sound"* until it is tapped.

## When it will not connect

**A link that works is not the same as a picture that works.** The link is
ordinary HTTPS through the tunnel and will load on any connection, anywhere. The
picture is peer to peer, which is why it can fail while everything else looks
fine. Home broadband is usually happy; mobile data usually is not, because
carriers put everyone behind a shared address that cannot be connected back to.
That is the case a TURN relay exists for:

```bash
node bin/stream.js --turn turn:relay.example.com:3478 --turn-user someone --turn-pass secret
```

Any TURN service works; several have a free tier that is ample for two people.
It is remembered after the first run. If you would rather the password never
touched the disk, set `STREAM_TURN_URL`, `STREAM_TURN_USER` and
`STREAM_TURN_PASS` in the environment instead; `--no-turn` ignores a remembered
one. A relay on TCP port 443 (`turns:relay.example.com:443`) gets through
networks that block everything else — the one to reach for when a hotel or an
office is involved.

Three ways to find out before anybody is waiting:

- **`node bin/stream.js --check`** asks the relay for an allocation exactly as a
  browser would, so a wrong password or a blocked port is a line of output
  rather than a silent black screen. It also checks the port, that cloudflared
  serves the address you think it does, and that DNS points at Cloudflare — and
  separates what would stop the evening from what is merely worth knowing.
- **Test link**, in the chat panel, with both of you on the page, opens the same
  kind of connection a share would and says what happened: connected directly,
  through a relay, or not at all.
- **Test link pressed alone** tests what one side can answer by itself — most
  of it. It asks each STUN server separately and compares the public port each
  reports. A router that answers every destination from one port can be
  connected back to; one that gives a different port per destination cannot,
  and that is what mobile carriers do. So send the link, have them press the
  button wherever they are — on Wi-Fi, then on mobile data — and you know days
  early whether a relay is optional or essential.

## When the connection drops

Films are long and networks are not perfect, so nothing here gives up.

- **The picture.** A dropped peer connection is offered again with backoff — a
  second, two, four, out to about half a minute — then every thirty seconds
  for as long as the share lasts. A network that is out for ten minutes should
  not end the evening, and nobody should have to go to the laptop to restart it.
- **A viewer can ask for the picture again.** The host cannot tell a viewer
  watching happily from one staring at nothing, so a viewer with no picture asks
  after ten seconds — which covers a reloaded tab, or a peer that went away
  without saying so. The host honours one such request per viewer every five
  seconds, so a viewer stuck in a loop cannot make it renegotiate continuously.
- **The host's connection to the site.** If it blinks, the capture and the
  picture carry on, and the host's browser takes the share back by itself on
  reconnecting. Nobody presses Share again.
- **The tunnel.** If cloudflared drops — the laptop slept, the network changed
  — it is restarted by itself, and the window says so.

A shared screen is live, so there is nothing to pause or rewind: what played
while a connection was down is gone. If one of you drops, pause the film in the
player on the host machine.

## The connection, in numbers

Open the chat panel during a share and there is a line like
`1080p 30fps · 6.2 Mbps · 84ms`, with a dot that turns amber and then red as it
degrades. The host sees what it is sending to whoever is having the worst time;
a viewer sees what they are receiving. "It looks blurry" becomes a number, and
usually the answer is a lower `--share-quality`.

The picture goes out at 1080p by default, whatever the monitor shows.
`--share-quality 1440` or `2160` sends more, but the ceiling is your upload, not
the setting: 1080p wants about 8 Mbps sustained and 4K about 28. Ask for more
than the connection carries and WebRTC simply drops back down, having spent the
CPU for nothing. It is a live re-encode of the screen, so it is softer than the
original file and dark scenes can band.

Both ends hold a screen wake lock while a screen is being shown: a host screen
going dark stops the capture, and a tablet dimming mid-scene is its own small
misery.

## Passcodes

There are two: **yours** makes you the host, **theirs** makes them a guest. Only
the host can share a screen.

New passcodes are made for each session, so last week's stops working when the
evening ends. A restart within four hours counts as the same session and keeps
them: a crash or a laptop that slept should not lock out somebody holding a code
that was right ten minutes ago — particularly as the passcode is asked for every
time the page is opened, so a phone discarding a backgrounded tab is enough to
need it again. `--keep-passcodes` always reuses the saved pair, `--new-passcodes`
always makes a fresh one, and `--passcode` / `--host-passcode` pin your own.

## Options

```
-p, --port <number>       Port to listen on (default 8420)
    --passcode <code>     Set the guest passcode instead of generating one
    --host-passcode <code>  Set your own passcode
    --keep-passcodes      Always reuse the saved passcodes
    --new-passcodes       Force a fresh pair, even just after a restart
    --room-name <text>    Heading on the passcode screen
    --share-quality <n>   720, 1080 (default), 1440 or 2160
    --hostname <domain>   Your own domain, e.g. movies.example.com
    --tunnel-name <name>  Run this named Cloudflare tunnel (pairs with --hostname)
    --turn <url>          TURN relay (repeatable; remembered)
    --turn-user <name>    Username for the TURN relay
    --turn-pass <secret>  Password for the TURN relay
    --no-turn             Ignore the remembered relay for this run
    --check               Check everything the evening needs, then exit
    --no-tunnel           Don't create a public link (same Wi-Fi only)
```

With no options it repeats last time's address, port and relay; on a laptop set
up by the installer it reads the tunnel and address from cloudflared's own
config, so the first start works as well as the hundredth.

## Your own domain, by hand

The installer does this for you. To do it without the installer, on macOS,
Linux or Windows:

```bash
node bin/setup-tunnel.js movies.example.com --name movies
node bin/stream.js
```

It logs you in (a browser opens; pick your domain), creates the tunnel, points
the DNS record at it — repointing it if it already belonged to one of your
tunnels — and writes cloudflared's config, backing up any you already had.
`node bin/setup-tunnel.js --check movies.example.com` diagnoses DNS that will
not resolve.

Without a domain, `node bin/stream.js` makes a free throwaway address instead,
different each time.

### What a domain does and doesn't protect

It gives you real HTTPS on your own domain, no open ports and no exposed home
address — the tunnel dials out, and nothing on the router is forwarded inward —
and DDoS filtering at Cloudflare's edge.

It does not keep anyone out by itself. The passcode is still the lock, and a
permanent domain is *more* discoverable than a throwaway one: every certificate
issued for it is published in public Certificate Transparency logs, which people
scan. Expect strangers to find the door; the rate limiter is what makes that
boring rather than dangerous. For a second lock, put **Cloudflare Access** in
front of the hostname (Zero Trust → Access → Applications): free for a few
users, and an unauthorised visitor never reaches the laptop at all — at the cost
of a login page before the passcode.

## Known limits

- **The laptop has to be on, awake and logged in**, with the Start Stream window
  open. Cloudflare is a front door, not a host.
- **Sound travels only with "Entire Screen".** On Windows, Chrome offers audio
  for Entire Screen and for a Chrome tab, never for a single window — which is
  the option people reach for first, because it names the app. The room says so
  if a share arrives silent.
- **Some network pairs need a relay** (see above), and without one those
  networks will not connect at all.
- **Upload speed is the ceiling.** 1080p wants about 8 Mbps sustained.
- **Sharing needs a desktop browser.** Phones and tablets can watch but not
  share: iOS and Android browsers do not offer screen capture.

## Security

The passcode is the credential. Anyone with the link *and* the guest passcode
sees whatever you share while you share it.

- Passcodes are hashed with scrypt and compared in constant time. Case is not
  part of a passcode: a code read off a screen has to work whether a phone
  capitalised it or a laptop did not.
- Wrong guesses are rate limited per address, with a global cap so guessing
  cannot be spread across many addresses. Five wrong tries locks that address
  out for fifteen minutes. Behind the tunnel the real visitor is read from
  `CF-Connecting-IP`, so this counts people rather than lumping everyone
  together.
- A correct passcode is exchanged for a signed, `HttpOnly` session cookie. The
  passcode is never in a URL, so it cannot leak through browser history,
  referrer headers, or a screenshot of the address bar.
- Nothing on your disk is served. The server holds the page, the passcode check
  and the handshake — the picture goes browser to browser.

There is no TLS of its own; the Cloudflare tunnel provides HTTPS. This is built
for people who know each other, not for the open web.

## Development

```bash
npm test          # unit and integration tests, no dependencies needed

# optional: two real browsers, end to end
npm install --no-save playwright
npx playwright install chromium
node test/e2e/screen.mjs    # a share, its recovery, and a host reconnecting
```

| File | Does |
|---|---|
| `Install-Stream.cmd` / `install.ps1` | one-double-click set-up of a Windows laptop |
| `start.cmd` / `start.sh` | the Start Stream button: update, then start |
| `bin/stream.js` | passcodes, the tunnel, the READY banner |
| `bin/setup-tunnel.js` | one-time wiring of a permanent address on your domain |
| `src/server.js` | the page, the passcode check, WebSocket signalling |
| `src/room.js` | who is here, whose screen is showing, the chat |
| `src/auth.js` | passcode hashing, session cookies, brute-force limiting |
| `src/ws.js` | a small RFC 6455 WebSocket server (keeps dependencies at zero) |
| `src/tunnel.js` | running cloudflared, and keeping it running |
| `src/cloudflare.js` | tunnel discovery, DNS diagnosis, cloudflared config |
| `src/preflight.js` | the `--check` run: what has to be true before the evening |
| `src/turn.js` | a STUN/TURN client, to prove a relay works before it is needed |
| `public/app.js` | the page: joining, sharing, watching, chat |
| `public/screen.js` | WebRTC screen sharing, audio negotiation, reconnection |
| `public/probe.js` | the two-sided connection test |
| `public/selftest.js` | the one-sided one: what this network alone can answer |
| `public/stats.js` | live bitrate, resolution and loss from a peer connection |
| `public/wakelock.js` | keeping the screen awake while a screen is showing |
