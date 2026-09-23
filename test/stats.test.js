import test from 'node:test';
import assert from 'node:assert/strict';

import { StatsSampler, describeStats, statsVerdict } from '../public/stats.js';

// A stand-in for RTCPeerConnection.getStats(), which returns a Map-like set of
// reports keyed by id.
function fakePeer(reports) {
  return { getStats: async () => new Map(reports.map((r) => [r.id, r])) };
}

test('a rate needs two samples, and says so until it has them', async () => {
  const sampler = new StatsSampler();
  const peer = (bytes, at) =>
    fakePeer([
      { id: 'v', type: 'outbound-rtp', kind: 'video', timestamp: at, bytesSent: bytes,
        packetsSent: bytes / 1000, packetsLost: 0, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30 },
    ]);

  const first = await sampler.sample('a', peer(0, 1000), { sending: true });
  assert.equal(first.kbps, null, 'nothing to subtract from yet');
  assert.equal(describeStats(first), '1080p 30fps');

  // 1,000,000 bytes over one second is 8 Mbps.
  const second = await sampler.sample('a', peer(1_000_000, 2000), { sending: true });
  assert.equal(second.kbps, 8000);
  assert.match(describeStats(second), /1080p 30fps · 8\.0 Mbps/);
});

test('it reads what is received when watching rather than sending', async () => {
  const sampler = new StatsSampler();
  const peer = fakePeer([
    { id: 'v', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 500,
      packetsReceived: 10, packetsLost: 0, frameWidth: 1280, frameHeight: 720 },
    { id: 'o', type: 'outbound-rtp', kind: 'video', timestamp: 1000, bytesSent: 999_999, frameHeight: 2160 },
  ]);

  const sample = await sampler.sample('a', peer, { sending: false });
  assert.equal(sample.height, 720, 'the inbound report, not the outbound one');
});

test('loss is measured over the interval, not since the beginning', async () => {
  const sampler = new StatsSampler();
  const at = (timestamp, packets, lost) =>
    fakePeer([
      { id: 'v', type: 'outbound-rtp', kind: 'video', timestamp, bytesSent: timestamp * 100,
        packetsSent: packets, packetsLost: lost, frameWidth: 1920, frameHeight: 1080 },
    ]);

  await sampler.sample('a', at(1000, 0, 0), { sending: true });
  // A bad patch: 90 delivered, 10 lost.
  const bad = await sampler.sample('a', at(2000, 90, 10), { sending: true });
  assert.equal(bad.lossPct, 10);

  // Now a clean interval. Cumulative loss is still 10, but nothing is wrong now.
  const good = await sampler.sample('a', at(3000, 190, 10), { sending: true });
  assert.equal(good.lossPct, 0, 'ten minutes ago should not colour what is happening now');
});

test('round-trip time comes from the succeeded candidate pair', async () => {
  const sampler = new StatsSampler();
  const peer = fakePeer([
    { id: 'v', type: 'outbound-rtp', kind: 'video', timestamp: 1000, bytesSent: 0, frameHeight: 1080 },
    { id: 'p1', type: 'candidate-pair', state: 'failed', currentRoundTripTime: 9 },
    { id: 'p2', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.042 },
  ]);
  const sample = await sampler.sample('a', peer, { sending: true });
  assert.equal(sample.rttMs, 42);
});

test('the verdict only complains when something is actually wrong', () => {
  assert.equal(statsVerdict({ kbps: 6000, lossPct: 0 }), 'good');
  assert.equal(statsVerdict({ kbps: 6000, lossPct: 2 }), 'fair');
  assert.equal(statsVerdict({ kbps: 1500, lossPct: 0 }), 'fair');
  assert.equal(statsVerdict({ kbps: 6000, lossPct: 7 }), 'poor');
  assert.equal(statsVerdict({ kbps: 400, lossPct: 0 }), 'poor');
  assert.equal(statsVerdict(null), null);

  // A connection that has not sent anything yet is not a bad one.
  assert.equal(statsVerdict({ kbps: 0, lossPct: null }), 'good');
});

test('a peer with no video report produces nothing rather than zeroes', async () => {
  const sampler = new StatsSampler();
  assert.equal(await sampler.sample('a', fakePeer([]), { sending: true }), null);
  assert.equal(await sampler.sample('a', null, { sending: true }), null);
  assert.equal(describeStats(null), 'Measuring…');
});
