// Screen sharing over WebRTC.
//
// The picture never touches the server: each viewer gets a direct peer
// connection to the host. That matters because WebRTC measures the link
// continuously and drops quality to fit it, where an HTTP stream picks a
// bitrate and stalls when the link cannot keep up.

// STUN tells each side what its public address is, which is enough when both
// routers will accept an incoming connection. When one will not — some mobile
// carriers, some office networks — nothing connects without a TURN relay to
// pass the media through, which is what `extraIceServers` is for.
// Eight tries spans about a minute of backoff, which covers a router
// restarting without pestering a network that is genuinely gone.
const MAX_RECONNECT_ATTEMPTS = 8;

export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// Film, not a spreadsheet: keep every pixel and spend the bitrate on motion.
// displaySurface 'monitor' narrows the picker to whole screens — the only
// choice Chrome will carry audio with. Offering a window or a tab just leads
// people to a silent film.
// What each height costs to send. Above 1080p the numbers stop being domestic
// upload speeds, which is why 1080p is the default rather than the maximum.
export const SHARE_PROFILES = {
  720: { width: 1280, height: 720, bitrate: 4_000_000 },
  1080: { width: 1920, height: 1080, bitrate: 8_000_000 },
  1440: { width: 2560, height: 1440, bitrate: 16_000_000 },
  2160: { width: 3840, height: 2160, bitrate: 28_000_000 },
};

export function shareProfile(height = 1080) {
  return SHARE_PROFILES[height] ?? SHARE_PROFILES[1080];
}

function videoConstraints(profile) {
  return {
    displaySurface: 'monitor',
    frameRate: { ideal: 30, max: 60 },
    width: { ideal: profile.width },
    height: { ideal: profile.height },
  };
}

// Chrome-specific, and the reason the audio tick arrives already ticked.
const PICKER_OPTIONS = {
  systemAudio: 'include',
  // Never offer this very tab: sharing it shows the share, inside the share.
  selfBrowserSurface: 'exclude',
  // No "share something else instead" button mid-film.
  surfaceSwitching: 'exclude',
};

// Screen capture audio is music and dialogue, so switch off everything meant
// for speech — those would gate and squash a film's soundtrack.
const AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
  sampleRate: 48000,
};



// WebRTC negotiates Opus for speech by default: mono, low bitrate, with
// discontinuous transmission that clips quiet passages. None of that suits a
// film, and the only way to ask for better is in the SDP.
export function upgradeAudio(sdp) {
  const opus = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!opus) return sdp;
  const payload = opus[1];

  const wanted = 'stereo=1;sprop-stereo=1;maxaveragebitrate=256000;useinbandfec=1;usedtx=0';
  const existing = new RegExp(`a=fmtp:${payload} (.*)`);

  if (existing.test(sdp)) {
    return sdp.replace(existing, (line, params) => {
      // Keep whatever we are not overriding, drop the keys we are.
      const kept = params
        .split(';')
        .filter((pair) => !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx|useinbandfec)=/i.test(pair.trim()))
        .filter(Boolean);
      return `a=fmtp:${payload} ${[...kept, wanted].join(';')}`;
    });
  }
  return sdp.replace(new RegExp(`(a=rtpmap:${payload} opus/48000/2\r?\n)`), `$1a=fmtp:${payload} ${wanted}\r\n`);
}

export class ScreenShare {
  constructor({ send, onStream, onStateChange, onEnded, iceServers = [], shareHeight = 1080 }) {
    this.profile = shareProfile(shareHeight);
    this.config = {
      iceServers: [...DEFAULT_ICE_SERVERS, ...iceServers],
      bundlePolicy: 'max-bundle',
    };
    this.send = send;
    this.onStream = onStream;
    this.onStateChange = onStateChange ?? (() => {});
    this.onEnded = onEnded ?? (() => {});
    this.peers = new Map();
    this.stream = null;
    // Reconnection bookkeeping, per viewer.
    this.attempts = new Map();
    this.retries = new Map();
  }

  get sharing() {
    return Boolean(this.stream);
  }

  async start() {
    // Asking for audio and video together fails outright wherever audio
    // capture is unavailable — some Linux desktops, macOS without a loopback
    // device, a machine with the capture blocked. Losing the sound is a poor
    // evening; losing the picture as well is no evening at all, so fall back
    // to video rather than let the whole thing fail.
    // Best first, then give up one thing at a time. Losing the sound is a poor
    // evening; losing the picture as well is no evening at all.
    const wanted = videoConstraints(this.profile);
    const attempts = [
      { video: wanted, audio: AUDIO_CONSTRAINTS, ...PICKER_OPTIONS },
      { video: wanted, audio: true, ...PICKER_OPTIONS },
      { video: { displaySurface: 'monitor' }, audio: true },
      { video: true, audio: true },
      { video: true },
    ];

    let lastError;
    for (const constraints of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getDisplayMedia(constraints);
        break;
      } catch (error) {
        lastError = error;
        // Somebody closing the picker means no, and asking again is rude.
        if (error.name === 'NotAllowedError' && !/audio|surface/i.test(error.message ?? '')) throw error;
      }
    }
    if (!this.stream) throw lastError;

    const withoutAudio = this.stream.getAudioTracks().length === 0;

    const [video] = this.stream.getVideoTracks();
    if (video) {
      // Tells the encoder to protect smoothness over sharpness on movement.
      video.contentHint = 'motion';
      video.addEventListener('ended', () => this.stop());
    }
    const [audio] = this.stream.getAudioTracks();
    if (audio) audio.contentHint = 'music';

    return {
      stream: this.stream,
      hasAudio: this.stream.getAudioTracks().length > 0,
      audioUnavailable: withoutAudio,
    };
  }

  stop() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.closeAll();
    this.onEnded();
  }

  closeAll() {
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    this.attempts.clear();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
  }

  // A film runs for two hours; a connection that drops once in that time is
  // ordinary. Offer again rather than ending the evening, backing off so a
  // network that is properly down is not hammered.
  _scheduleReconnect(id, delay) {
    if (!this.stream) return; // only the side with the picture can re-offer
    if (this.retries.has(id)) return;

    const attempt = (this.attempts.get(id) ?? 0) + 1;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      this.onStateChange(id, 'gave-up');
      return;
    }
    this.attempts.set(id, attempt);

    const wait = delay || Math.min(1000 * 2 ** (attempt - 1), 15_000);
    this.onStateChange(id, 'reconnecting');

    this.retries.set(
      id,
      setTimeout(() => {
        this.retries.delete(id);
        const peer = this.peers.get(id);
        // It may have mended itself while we waited.
        if (peer?.connectionState === 'connected') {
          this.attempts.delete(id);
          return;
        }
        this.offerTo(id).catch(() => this._scheduleReconnect(id, 0));
      }, wait)
    );
  }

  close(id) {
    clearTimeout(this.retries.get(id));
    this.retries.delete(id);
    this.peers.get(id)?.close();
    this.peers.delete(id);
  }

  setIceServers(extra = []) {
    this.config.iceServers = [...DEFAULT_ICE_SERVERS, ...extra];
  }

  setShareHeight(height) {
    this.profile = shareProfile(height);
  }

  _peer(id) {
    const peer = new RTCPeerConnection(this.config);
    this.peers.set(id, peer);

    peer.addEventListener('icecandidate', (event) => {
      if (event.candidate) this.send({ type: 'signal', to: id, data: { candidate: event.candidate } });
    });

    peer.addEventListener('connectionstatechange', () => {
      this.onStateChange(id, peer.connectionState);

      if (peer.connectionState === 'connected') {
        this.attempts.delete(id);
        clearTimeout(this.retries.get(id));
        this.retries.delete(id);
        return;
      }

      // 'disconnected' often mends itself within a few seconds — a phone
      // changing tower, a router pausing for breath. 'failed' will not.
      if (peer.connectionState === 'failed') this._scheduleReconnect(id, 0);
      else if (peer.connectionState === 'disconnected') this._scheduleReconnect(id, 5000);
      else if (peer.connectionState === 'closed') this.peers.delete(id);
    });

    peer.addEventListener('track', (event) => {
      if (event.streams[0]) this.onStream(event.streams[0]);
    });

    return peer;
  }

  // Host side: offer the screen to one viewer.
  async offerTo(id) {
    if (!this.stream) return;
    this.close(id);
    const peer = this._peer(id);

    for (const track of this.stream.getTracks()) peer.addTrack(track, this.stream);

    // Hold the resolution and let the frame rate give way instead. Dropping to
    // a blurry 30fps is worse to watch than a sharp 20fps.
    for (const sender of peer.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const parameters = sender.getParameters();
      parameters.degradationPreference = 'maintain-resolution';
      parameters.encodings = [
        { ...(parameters.encodings?.[0] ?? {}), maxBitrate: this.profile.bitrate },
      ];
      try {
        await sender.setParameters(parameters);
      } catch {
        /* older browsers reject some of this; the defaults still work */
      }
    }

    const offer = await peer.createOffer();
    offer.sdp = upgradeAudio(offer.sdp);
    await peer.setLocalDescription(offer);
    this.send({ type: 'signal', to: id, data: { sdp: peer.localDescription } });
  }

  // Either side: handle something the other one sent.
  async handleSignal({ from, data }) {
    if (data.kind === 'probe') return; // handled by ConnectionProbe
    let peer = this.peers.get(from);

    if (data.sdp) {
      if (!peer) peer = this._peer(from);
      await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type !== 'offer') return;

      const answer = await peer.createAnswer();
      answer.sdp = upgradeAudio(answer.sdp);
      await peer.setLocalDescription(answer);
      this.send({ type: 'signal', to: from, data: { sdp: peer.localDescription } });
      return;
    }

    if (data.candidate && peer) {
      try {
        await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch {
        /* candidates can arrive before the description; safe to drop */
      }
    }
  }
}
