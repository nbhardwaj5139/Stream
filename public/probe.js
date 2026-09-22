// A dry run of the connection a screen share would need.
//
// Screen sharing is peer to peer, so it depends on two networks agreeing to
// talk directly. That is the one thing that cannot be checked from either end
// alone, and the worst time to discover it is when somebody is waiting to
// watch something. This opens the same kind of connection carrying nothing but
// a few bytes, and reports what happened.

const PROBE_TIMEOUT_MS = 15_000;

export class ConnectionProbe {
  constructor({ send, iceServers = [] }) {
    this.send = send;
    this.iceServers = iceServers;
    this.pending = new Map();
  }

  setIceServers(servers) {
    this.iceServers = servers;
  }

  _peer(id) {
    const peer = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    peer.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.send({ type: 'signal', to: id, data: { kind: 'probe', candidate: event.candidate } });
      }
    });
    return peer;
  }

  // Whether the two ends found each other directly or had to go through a
  // relay. "relayed" still works; it just means a direct route was refused.
  static async describe(peer) {
    const stats = await peer.getStats();
    for (const report of stats.values()) {
      if (report.type !== 'candidate-pair' || report.state !== 'succeeded') continue;
      const local = stats.get(report.localCandidateId);
      const remote = stats.get(report.remoteCandidateId);
      const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      return { kind: relayed ? 'relayed' : 'direct' };
    }
    return { kind: 'unknown' };
  }

  // Run the test against another viewer. Resolves with what happened rather
  // than throwing, because every outcome here is information.
  async test(id) {
    this.cancel(id);

    const peer = this._peer(id);
    const channel = peer.createDataChannel('probe');
    const started = performance.now();

    const outcome = new Promise((resolve) => {
      const finish = async (result) => {
        clearTimeout(timer);
        if (result.ok) Object.assign(result, await ConnectionProbe.describe(peer));
        peer.close();
        this.pending.delete(id);
        resolve(result);
      };

      const timer = setTimeout(
        () => finish({ ok: false, reason: 'timeout' }),
        PROBE_TIMEOUT_MS
      );

      channel.addEventListener('open', () => channel.send(String(performance.now())));
      channel.addEventListener('message', (event) => {
        const sent = Number(event.data);
        finish({ ok: true, rttMs: Math.round(performance.now() - sent), setupMs: Math.round(performance.now() - started) });
      });

      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed') finish({ ok: false, reason: 'no-route' });
      });
    });

    this.pending.set(id, { peer, role: 'caller' });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    this.send({ type: 'signal', to: id, data: { kind: 'probe', sdp: peer.localDescription } });

    return outcome;
  }

  // The other end of somebody else's test: answer it and echo one message.
  async handleSignal({ from, data }) {
    let entry = this.pending.get(from);

    if (data.sdp?.type === 'offer') {
      const peer = this._peer(from);
      entry = { peer, role: 'callee' };
      this.pending.set(from, entry);

      peer.addEventListener('datachannel', (event) => {
        const channel = event.channel;
        // Echo it straight back; the caller is timing the round trip.
        channel.addEventListener('message', (message) => channel.send(message.data));
      });

      // Nothing else will close this, so do not leave it open forever.
      setTimeout(() => this.cancel(from), PROBE_TIMEOUT_MS + 5000);

      await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.send({ type: 'signal', to: from, data: { kind: 'probe', sdp: peer.localDescription } });
      return;
    }

    if (!entry) return;

    if (data.sdp) {
      await entry.peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
      return;
    }

    if (data.candidate) {
      try {
        await entry.peer.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch {
        /* candidates can arrive before the description */
      }
    }
  }

  cancel(id) {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.peer.close();
    this.pending.delete(id);
  }

  cancelAll() {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }
}

// Turns a result into something worth reading.
export function describeProbeResult(result, { name = 'the other side' } = {}) {
  if (result.ok) {
    return result.kind === 'relayed'
      ? `Connected to ${name} through a relay — ${result.rttMs}ms. Screen sharing will work.`
      : `Connected directly to ${name} — ${result.rttMs}ms. Screen sharing will work.`;
  }
  if (result.reason === 'no-route') {
    return `Could not reach ${name}. The two networks will not connect directly, so screen sharing needs a TURN relay — see --turn in the README.`;
  }
  return `No answer from ${name} within 15 seconds. They may have closed the page, or the networks cannot connect.`;
}
