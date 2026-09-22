// Screen sharing over WebRTC.
//
// The picture never touches the server: each viewer gets a direct peer
// connection to the host. That matters because WebRTC measures the link
// continuously and drops quality to fit it, where an HTTP stream picks a
// bitrate and stalls when the link cannot keep up.

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  bundlePolicy: 'max-bundle',
};

// Film, not a spreadsheet: keep every pixel and spend the bitrate on motion.
const VIDEO_CONSTRAINTS = {
  frameRate: { ideal: 30, max: 60 },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
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

const TARGET_BITRATE = 8_000_000;

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
  constructor({ send, onStream, onStateChange, onEnded }) {
    this.send = send;
    this.onStream = onStream;
    this.onStateChange = onStateChange ?? (() => {});
    this.onEnded = onEnded ?? (() => {});
    this.peers = new Map();
    this.stream = null;
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
    let withoutAudio = false;
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: VIDEO_CONSTRAINTS,
        audio: AUDIO_CONSTRAINTS,
      });
    } catch (error) {
      // A refusal is the person saying no; anything else is worth retrying.
      if (error.name === 'NotAllowedError' && !/audio/i.test(error.message ?? '')) throw error;
      this.stream = await navigator.mediaDevices.getDisplayMedia({ video: VIDEO_CONSTRAINTS });
      withoutAudio = true;
    }

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
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
  }

  close(id) {
    this.peers.get(id)?.close();
    this.peers.delete(id);
  }

  _peer(id) {
    const peer = new RTCPeerConnection(RTC_CONFIG);
    this.peers.set(id, peer);

    peer.addEventListener('icecandidate', (event) => {
      if (event.candidate) this.send({ type: 'signal', to: id, data: { candidate: event.candidate } });
    });

    peer.addEventListener('connectionstatechange', () => {
      this.onStateChange(id, peer.connectionState);
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        this.peers.delete(id);
      }
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
      parameters.encodings = [{ ...(parameters.encodings?.[0] ?? {}), maxBitrate: TARGET_BITRATE }];
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
