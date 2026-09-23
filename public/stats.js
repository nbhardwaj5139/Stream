// What a connection is actually doing, in numbers.
//
// "It looks blurry" is not something you can act on. Resolution, frame rate,
// bitrate and loss are.

const BITS_PER_BYTE = 8;

// getStats reports totals, so a rate needs two samples to subtract.
export class StatsSampler {
  constructor() {
    this.previous = new Map();
  }

  forget(id) {
    this.previous.delete(id);
  }

  // `sending` picks outbound figures for the host and inbound for a viewer.
  async sample(id, peer, { sending }) {
    if (!peer) return null;

    let report;
    let remote;
    try {
      const stats = await peer.getStats();
      for (const entry of stats.values()) {
        if (entry.type === (sending ? 'outbound-rtp' : 'inbound-rtp') && entry.kind === 'video') {
          report = entry;
        }
        if (entry.type === 'candidate-pair' && entry.state === 'succeeded') remote = entry;
      }
    } catch {
      return null;
    }
    if (!report) return null;

    const now = report.timestamp;
    const bytes = sending ? report.bytesSent : report.bytesReceived;
    const last = this.previous.get(id);
    this.previous.set(id, { at: now, bytes, lost: report.packetsLost, packets: sending ? report.packetsSent : report.packetsReceived });

    const result = {
      width: report.frameWidth ?? null,
      height: report.frameHeight ?? null,
      fps: report.framesPerSecond != null ? Math.round(report.framesPerSecond) : null,
      kbps: null,
      lossPct: null,
      rttMs: remote?.currentRoundTripTime != null ? Math.round(remote.currentRoundTripTime * 1000) : null,
    };

    if (last && now > last.at && bytes != null && last.bytes != null) {
      const seconds = (now - last.at) / 1000;
      result.kbps = Math.round(((bytes - last.bytes) * BITS_PER_BYTE) / seconds / 1000);
    }

    // Loss over the interval, not since the beginning — a bad patch ten
    // minutes ago should not colour what is happening now.
    if (last && report.packetsLost != null && last.lost != null) {
      const lost = report.packetsLost - last.lost;
      const packets = (sending ? report.packetsSent : report.packetsReceived) - (last.packets ?? 0);
      const total = lost + packets;
      if (total > 0) result.lossPct = Math.round((lost / total) * 1000) / 10;
    }

    return result;
  }
}

export function describeStats(stats) {
  if (!stats) return 'Measuring…';

  const parts = [];
  if (stats.width && stats.height) {
    parts.push(stats.fps ? `${stats.height}p ${stats.fps}fps` : `${stats.height}p`);
  }
  if (stats.kbps != null) {
    parts.push(stats.kbps >= 1000 ? `${(stats.kbps / 1000).toFixed(1)} Mbps` : `${stats.kbps} kbps`);
  }
  if (stats.rttMs != null) parts.push(`${stats.rttMs}ms`);
  if (stats.lossPct) parts.push(`${stats.lossPct}% lost`);
  return parts.length ? parts.join(' · ') : 'Measuring…';
}

// Worth saying out loud only when something is actually wrong.
export function statsVerdict(stats) {
  if (!stats) return null;
  if (stats.lossPct != null && stats.lossPct >= 5) return 'poor';
  if (stats.kbps != null && stats.kbps > 0 && stats.kbps < 800) return 'poor';
  if (stats.lossPct != null && stats.lossPct >= 1.5) return 'fair';
  if (stats.kbps != null && stats.kbps > 0 && stats.kbps < 2000) return 'fair';
  return 'good';
}
