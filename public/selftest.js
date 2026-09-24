// A connection test one person can run alone.
//
// The peer-to-peer probe in probe.js is the better test, because it tests the
// real thing — but it needs both people on the page at once, which is exactly
// what you cannot arrange when one of you is deciding whether to bother.
//
// This asks a different question, and answers it from one side: will this
// network let a peer-to-peer connection happen at all? Each ICE server is
// asked separately, because the interesting answer is in the comparison. A
// router that gives the same public port whatever it is talking to can be
// connected back to. One that gives a different port per destination — a
// symmetric NAT, which is what mobile carriers do to everybody — cannot,
// because neither side can predict where to send the first packet. That is the
// case a relay exists for, and the reason "it works on my wifi" and "it works
// on my phone's data" are different claims.

export const SELFTEST_TIMEOUT_MS = 8000;

// candidate:1 1 UDP 2122317823 192.168.1.5 50000 typ host
// candidate:2 1 UDP 1686052607 203.0.113.9 50000 typ srflx raddr 192.168.1.5 ...
export function parseCandidate(line) {
  if (typeof line !== 'string') return null;
  const text = line.startsWith('candidate:') ? line.slice('candidate:'.length) : line;
  const parts = text.trim().split(/\s+/);
  if (parts.length < 8 || parts[6] !== 'typ') return null;

  const port = Number(parts[5]);
  if (!Number.isInteger(port)) return null;

  return {
    protocol: parts[2].toLowerCase(),
    address: parts[4],
    port,
    type: parts[7],
  };
}

// Ask one server on its own, so its answer can be told apart from the others'.
export async function gatherFrom(server, { timeoutMs = SELFTEST_TIMEOUT_MS, PeerConnection } = {}) {
  const Impl = PeerConnection ?? (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
  if (!Impl) return { server, candidates: [], error: 'this browser cannot make the connection at all' };

  let peer;
  try {
    peer = new Impl({ iceServers: [server], bundlePolicy: 'max-bundle' });
  } catch (error) {
    return { server, candidates: [], error: error.message };
  }

  const candidates = [];
  try {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, timeoutMs);

      peer.addEventListener('icecandidate', (event) => {
        // A null candidate means gathering has finished.
        if (!event.candidate) return done();
        const parsed = parseCandidate(event.candidate.candidate);
        if (parsed) candidates.push(parsed);
      });

      // A data channel is enough to make it gather; nothing is ever sent.
      peer.createDataChannel('selftest');
      peer
        .createOffer()
        .then((offer) => peer.setLocalDescription(offer))
        .catch(done);
    });
  } finally {
    peer.close();
  }

  return { server, candidates };
}

function labelFor(server) {
  const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
  return String(urls[0] ?? 'unknown');
}

/**
 * What the gathered candidates say about this network. Pure, so the awkward
 * cases can be written down as tests rather than waited for.
 */
export function classifySelfTest(results, { relayConfigured = false } = {}) {
  const reflexive = [];
  let relay = false;
  let anyCandidates = false;

  for (const result of results) {
    for (const candidate of result.candidates) {
      anyCandidates = true;
      if (candidate.type === 'srflx') {
        reflexive.push({ server: labelFor(result.server), ...candidate });
      }
      if (candidate.type === 'relay') relay = true;
    }
  }

  const addresses = [...new Set(reflexive.map((candidate) => candidate.address))];
  // One reflexive answer per server, so the ports can be compared.
  const byServer = new Map();
  for (const candidate of reflexive) {
    if (!byServer.has(candidate.server)) byServer.set(candidate.server, candidate.port);
  }
  const ports = [...byServer.values()];

  // Comparing needs two answers. With one, we simply do not know.
  const natType =
    ports.length < 2 ? (ports.length === 1 ? 'unknown' : 'none') : new Set(ports).size === 1 ? 'predictable' : 'symmetric';

  let verdict;
  if (!reflexive.length && !relay) verdict = anyCandidates ? 'blocked' : 'no-network';
  else if (relay && natType === 'symmetric') verdict = 'relayed';
  else if (!relay && natType === 'symmetric') verdict = 'needs-relay';
  else if (!reflexive.length && relay) verdict = 'relayed';
  else verdict = 'direct';

  return {
    verdict,
    natType,
    stun: reflexive.length > 0,
    relay,
    relayConfigured,
    addresses,
    ports,
    servers: results.length,
  };
}

// Run the whole thing. Every ICE server separately, then the verdict.
export async function selfTest(iceServers = [], options = {}) {
  const results = [];
  for (const server of iceServers) {
    results.push(await gatherFrom(server, options));
  }
  const relayConfigured = iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => /^turns?:/i.test(String(url ?? '')));
  });
  return { ...classifySelfTest(results, { relayConfigured }), results };
}

// Written for the person who ran it, who wants to know whether to bother.
export function describeSelfTest(result) {
  switch (result.verdict) {
    case 'direct':
      return (
        'This network looks fine. Your router gives out a predictable address, ' +
        'so the picture can come straight across.'
      );
    case 'relayed':
      return (
        'This network needs the relay, and the relay is working — so it will ' +
        'connect. Expect slightly more delay than on home wifi.'
      );
    case 'needs-relay':
      return (
        'This network will not take a direct connection — your address changes ' +
        'per destination, which is normal on mobile data. It needs a relay ' +
        'turned on at the other end to work from here. Try home wifi instead, ' +
        'or send this message on.'
      );
    case 'blocked':
      return (
        'This network is blocking the kind of connection the picture needs — no ' +
        'public address came back at all. A relay on port 443 is the usual fix. ' +
        'Try a different network if you can.'
      );
    case 'no-network':
      return 'Nothing came back at all. Check you are online, then try again.';
    default:
      return 'The test could not reach a conclusion. Try again in a moment.';
  }
}
