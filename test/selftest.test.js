import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySelfTest,
  describeSelfTest,
  gatherFrom,
  parseCandidate,
  selfTest,
} from '../public/selftest.js';

const srflx = (address, port) =>
  `candidate:2 1 UDP 1686052607 ${address} ${port} typ srflx raddr 192.168.1.5 rport 50000`;
const host = 'candidate:1 1 UDP 2122317823 192.168.1.5 50000 typ host';
const relay =
  'candidate:3 1 UDP 41886207 198.51.100.7 60000 typ relay raddr 203.0.113.9 rport 50000';

// A stand-in for RTCPeerConnection that emits the candidate lines it is given.
function fakePeerConnection(byServer) {
  return class {
    constructor(config) {
      this.lines = byServer[config.iceServers[0].urls] ?? [];
      this.listeners = [];
    }
    addEventListener(type, handler) {
      if (type === 'icecandidate') this.listeners.push(handler);
    }
    createDataChannel() {}
    async createOffer() { return { type: 'offer', sdp: '' }; }
    async setLocalDescription() {
      // Candidates arrive after the description is set, as in a browser.
      for (const line of this.lines) {
        for (const handler of this.listeners) handler({ candidate: { candidate: line } });
      }
      for (const handler of this.listeners) handler({ candidate: null });
    }
    close() { this.closed = true; }
  };
}

test('a candidate line is read into its parts', () => {
  assert.deepEqual(parseCandidate(host), {
    protocol: 'udp', address: '192.168.1.5', port: 50000, type: 'host',
  });
  assert.deepEqual(parseCandidate(srflx('203.0.113.9', 44444)), {
    protocol: 'udp', address: '203.0.113.9', port: 44444, type: 'srflx',
  });
  assert.equal(parseCandidate(relay).type, 'relay');

  // The prefix is optional, and TCP candidates read the same way.
  assert.equal(parseCandidate('1 1 TCP 2122317823 192.168.1.5 9 typ host').protocol, 'tcp');
});

test('anything that is not a candidate line is refused', () => {
  assert.equal(parseCandidate(''), null);
  assert.equal(parseCandidate(null), null);
  assert.equal(parseCandidate('candidate:1 1 UDP 2122317823 192.168.1.5'), null, 'truncated');
  // 'typ' must be where the format says it is, or the fields are not what we think.
  assert.equal(parseCandidate('candidate:1 1 UDP 212231 192.168.1.5 50000 xyz host'), null);
  assert.equal(parseCandidate('candidate:1 1 UDP 212231 1.2.3.4 notaport typ host'), null);
});

test('the same public port from two servers means a direct connection is likely', () => {
  // A router that answers every destination from one port can be connected
  // back to: both sides can predict where to send the first packet.
  const result = classifySelfTest([
    { server: { urls: 'stun:a' }, candidates: [parseCandidate(host), parseCandidate(srflx('203.0.113.9', 44444))] },
    { server: { urls: 'stun:b' }, candidates: [parseCandidate(srflx('203.0.113.9', 44444))] },
  ]);

  assert.equal(result.natType, 'predictable');
  assert.equal(result.verdict, 'direct');
  assert.deepEqual(result.addresses, ['203.0.113.9']);
  assert.match(describeSelfTest(result), /straight across/);
});

test('a different port per server is the carrier-grade NAT everyone is behind on mobile', () => {
  const candidates = [
    { server: { urls: 'stun:a' }, candidates: [parseCandidate(srflx('203.0.113.9', 44444))] },
    { server: { urls: 'stun:b' }, candidates: [parseCandidate(srflx('203.0.113.9', 55555))] },
  ];

  // Without a relay this is the bad news, and it should say so plainly.
  const alone = classifySelfTest(candidates);
  assert.equal(alone.natType, 'symmetric');
  assert.equal(alone.verdict, 'needs-relay');
  assert.match(describeSelfTest(alone), /normal on mobile data/);

  // With one, the same network is fine — it just goes the long way round.
  const withRelay = classifySelfTest([
    ...candidates,
    { server: { urls: 'turn:r' }, candidates: [parseCandidate(relay)] },
  ]);
  assert.equal(withRelay.verdict, 'relayed');
  assert.equal(withRelay.relay, true);
  assert.match(describeSelfTest(withRelay), /it will connect/);
});

test('one server answering is not enough to judge the router', () => {
  // Comparing is the whole method, so one answer means one unknown, not a pass.
  const result = classifySelfTest([
    { server: { urls: 'stun:a' }, candidates: [parseCandidate(srflx('203.0.113.9', 44444))] },
    { server: { urls: 'stun:b' }, candidates: [] },
  ]);

  assert.equal(result.natType, 'unknown');
  assert.equal(result.verdict, 'direct', 'reachable, so do not frighten anyone off');
  assert.equal(result.ports.length, 1);
});

test('only local candidates means the network is blocking it', () => {
  const result = classifySelfTest([
    { server: { urls: 'stun:a' }, candidates: [parseCandidate(host)] },
    { server: { urls: 'stun:b' }, candidates: [parseCandidate(host)] },
  ]);

  assert.equal(result.verdict, 'blocked');
  assert.equal(result.stun, false);
  assert.match(describeSelfTest(result), /port 443/);
});

test('nothing at all is a different problem from being blocked', () => {
  const result = classifySelfTest([{ server: { urls: 'stun:a' }, candidates: [] }]);
  assert.equal(result.verdict, 'no-network');
  assert.match(describeSelfTest(result), /Check you are online/);
});

test('a relay that works carries the verdict even with no reflexive address', () => {
  // Some networks refuse STUN but permit the relay, usually because it is on 443.
  const result = classifySelfTest([
    { server: { urls: 'turns:r:443' }, candidates: [parseCandidate(relay)] },
  ]);
  assert.equal(result.verdict, 'relayed');
});

test('each server is asked on its own, so its answer can be told apart', async () => {
  const PeerConnection = fakePeerConnection({
    'stun:a': [host, srflx('203.0.113.9', 44444)],
    'stun:b': [srflx('203.0.113.9', 55555)],
  });

  const gathered = await gatherFrom({ urls: 'stun:a' }, { PeerConnection, timeoutMs: 500 });
  assert.equal(gathered.candidates.length, 2);

  // Run end to end: two servers disagreeing about the port is symmetric NAT.
  const result = await selfTest([{ urls: 'stun:a' }, { urls: 'stun:b' }], {
    PeerConnection,
    timeoutMs: 500,
  });
  assert.equal(result.natType, 'symmetric');
  assert.equal(result.verdict, 'needs-relay');
  assert.equal(result.relayConfigured, false);
});

test('a configured relay is noticed however the servers are written', async () => {
  const PeerConnection = fakePeerConnection({});
  const result = await selfTest(
    [{ urls: 'stun:a' }, { urls: ['turn:r:3478', 'turns:r:443'] }],
    { PeerConnection, timeoutMs: 100 }
  );
  assert.equal(result.relayConfigured, true);
});

test('a browser that cannot do any of this says so instead of throwing', async () => {
  const result = await gatherFrom({ urls: 'stun:a' }, { PeerConnection: null, timeoutMs: 100 });
  assert.deepEqual(result.candidates, []);
  assert.match(result.error, /cannot make the connection/);
});

test('a peer connection that will not even be built is not fatal', async () => {
  class Broken {
    constructor() { throw new Error('nope'); }
  }
  const result = await gatherFrom({ urls: 'stun:a' }, { PeerConnection: Broken, timeoutMs: 100 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.error, 'nope');
});
