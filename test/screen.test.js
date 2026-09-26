import test from 'node:test';
import assert from 'node:assert/strict';

import { upgradeAudio } from '../public/screen.js';

const SDP_WITH_FMTP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  '',
].join('\r\n');

const SDP_WITHOUT_FMTP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  '',
].join('\r\n');

test('the audio is negotiated for music rather than speech', () => {
  // Left alone, WebRTC picks mono Opus at a speech bitrate with discontinuous
  // transmission, which gates the quiet parts of a film.
  const sdp = upgradeAudio(SDP_WITH_FMTP);

  assert.match(sdp, /stereo=1/);
  assert.match(sdp, /sprop-stereo=1/);
  assert.match(sdp, /maxaveragebitrate=256000/);
  assert.match(sdp, /usedtx=0/);
  // Anything we are not overriding survives.
  assert.match(sdp, /minptime=10/);
  // And nothing is set twice.
  assert.equal((sdp.match(/stereo=1/g) ?? []).length, 2, 'stereo and sprop-stereo, once each');
});

test('the audio settings are added when there were none', () => {
  const sdp = upgradeAudio(SDP_WITHOUT_FMTP);
  assert.match(sdp, /a=fmtp:111 .*stereo=1/);
  assert.match(sdp, /a=rtpmap:111 opus\/48000\/2/);
});

test('an SDP with no Opus is left exactly as it was', () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
  assert.equal(upgradeAudio(sdp), sdp);
});

test('the share profile matches resolution to a sendable bitrate', async () => {
  const { SHARE_PROFILES, shareProfile } = await import('../public/screen.js');

  assert.equal(shareProfile(1080).height, 1080);
  assert.equal(shareProfile(2160).width, 3840);
  // Anything unrecognised lands on the default rather than breaking the share.
  assert.equal(shareProfile(999).height, 1080);
  assert.equal(shareProfile(undefined).height, 1080);

  // Bitrate has to climb with resolution or the extra pixels are wasted on
  // compression artefacts.
  const heights = Object.keys(SHARE_PROFILES).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < heights.length; i++) {
    assert.ok(
      SHARE_PROFILES[heights[i]].bitrate > SHARE_PROFILES[heights[i - 1]].bitrate,
      `${heights[i]} must ask for more than ${heights[i - 1]}`
    );
  }
});

test('a dropped viewer is offered the stream again, with backoff', async (t) => {
  const { ScreenShare } = await import('../public/screen.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const offered = [];
  const states = [];
  const share = new ScreenShare({
    send: () => {},
    onStream: () => {},
    onStateChange: (id, value) => states.push(value),
  });
  share.stream = { getTracks: () => [] }; // stand in for a live capture
  share.offerTo = async (id) => { offered.push(id); };

  share._scheduleReconnect('viewer-1', 0);
  assert.deepEqual(offered, [], 'not immediately — the network needs a moment');
  assert.ok(states.includes('reconnecting'), 'and the room is told');

  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(offered, ['viewer-1'], 'first retry after a second');

  // Each further failure waits longer: 2s, then 4s.
  share._scheduleReconnect('viewer-1', 0);
  t.mock.timers.tick(1999);
  await Promise.resolve();
  assert.equal(offered.length, 1, 'still waiting');
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(offered.length, 2);

  t.mock.timers.reset();
});

test('reconnection slows down but never stops', async (t) => {
  const { ScreenShare } = await import('../public/screen.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const states = [];
  let offers = 0;
  const share = new ScreenShare({
    send: () => {},
    onStream: () => {},
    onStateChange: (id, value) => states.push(value),
  });
  share.stream = { getTracks: () => [] };
  share.offerTo = async () => { offers += 1; };

  // Six quick attempts, spanning about half a minute of backoff.
  for (let i = 0; i < 6; i++) {
    share._scheduleReconnect('viewer-1', 0);
    t.mock.timers.tick(20_000);
    await Promise.resolve();
  }
  assert.equal(offers, 6);
  assert.equal(states.filter((value) => value === 'reconnecting').length, 6);
  assert.equal(states.includes('still-trying'), false, 'not yet — these were the quick ones');

  // Past that it keeps going on a slow beat rather than giving up: a network
  // that is down for ten minutes of a film should not end the evening.
  share._scheduleReconnect('viewer-1', 0);
  assert.equal(states.at(-1), 'still-trying', 'and it says so');
  assert.equal(states.filter((value) => value === 'still-trying').length, 1);
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(offers, 6, 'waiting the longer interval');
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(offers, 7);

  // Still trying an hour in.
  for (let i = 0; i < 100; i++) {
    share._scheduleReconnect('viewer-1', 0);
    t.mock.timers.tick(30_000);
    await Promise.resolve();
  }
  assert.equal(offers, 107, 'never gives up while the capture is live');
  // But it does not keep announcing itself: a notice every thirty seconds
  // over somebody's film is worse than silence.
  assert.equal(
    states.filter((value) => value === 'still-trying').length,
    1,
    'said once at the changeover, not on every slow retry'
  );

  t.mock.timers.reset();
});

test('only the side holding the picture tries to reconnect', async (t) => {
  const { ScreenShare } = await import('../public/screen.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const states = [];
  const viewer = new ScreenShare({
    send: () => {},
    onStream: () => {},
    onStateChange: (id, value) => states.push(value),
  });
  // No stream: this is somebody watching, not sharing.
  viewer._scheduleReconnect('host-1', 0);
  t.mock.timers.tick(30_000);

  assert.deepEqual(states, [], 'a viewer waits to be re-offered rather than offering');
  t.mock.timers.reset();
});

test('a recovered connection stops the retrying and forgets the attempts', async (t) => {
  const { ScreenShare } = await import('../public/screen.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const offered = [];
  const share = new ScreenShare({ send: () => {}, onStream: () => {}, onStateChange: () => {} });
  share.stream = { getTracks: () => [] };
  share.offerTo = async (id) => { offered.push(id); };
  share.peers.set('viewer-1', { connectionState: 'connected', close: () => {} });

  share._scheduleReconnect('viewer-1', 0);
  t.mock.timers.tick(5000);
  await Promise.resolve();

  assert.deepEqual(offered, [], 'it mended itself while we waited');
  t.mock.timers.reset();
});

test('the connection test uses the same servers the share would', async () => {
  const { DEFAULT_ICE_SERVERS } = await import('../public/screen.js');
  const { ConnectionProbe } = await import('../public/probe.js');

  // A test down a different path is not a test of anything, so the list has to
  // have one definition rather than a copy in each file.
  assert.ok(Array.isArray(DEFAULT_ICE_SERVERS) && DEFAULT_ICE_SERVERS.length > 0);

  const relay = { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'p' };
  const probe = new ConnectionProbe({ send: () => {} });
  probe.setIceServers([...DEFAULT_ICE_SERVERS, relay]);

  assert.deepEqual(probe.iceServers.slice(0, DEFAULT_ICE_SERVERS.length), DEFAULT_ICE_SERVERS);
  assert.deepEqual(probe.iceServers.at(-1), relay, 'a configured relay is tested too');
});

test('a share offers the default servers plus whatever relay is configured', async () => {
  const { ScreenShare, DEFAULT_ICE_SERVERS } = await import('../public/screen.js');
  const relay = { urls: 'turn:relay.example.com:3478', username: 'someone', credential: 'secret' };

  const share = new ScreenShare({ send: () => {}, onStream: () => {}, iceServers: [relay] });
  assert.deepEqual(share.config.iceServers, [...DEFAULT_ICE_SERVERS, relay]);

  // And it can be changed after the fact, when the server says so on connect.
  share.setIceServers([]);
  assert.deepEqual(share.config.iceServers, DEFAULT_ICE_SERVERS);
  share.setIceServers([relay]);
  assert.equal(share.config.iceServers.at(-1).credential, 'secret');
});

test('a viewer can ask the host to send the picture again', async () => {
  const { ScreenShare } = await import('../public/screen.js');

  const sent = [];
  const viewer = new ScreenShare({ send: (message) => sent.push(message), onStream: () => {} });

  assert.equal(viewer.requestOffer('host-1'), true);
  assert.deepEqual(sent, [{ type: 'signal', to: 'host-1', data: { kind: 'reoffer' } }]);

  // The host holds the capture, so it has nobody to ask.
  viewer.stream = { getTracks: () => [] };
  assert.equal(viewer.requestOffer('host-1'), false);
  assert.equal(sent.length, 1);
});

test('the host answers a re-offer, but not on a loop', async () => {
  const { ScreenShare } = await import('../public/screen.js');

  const offered = [];
  const host = new ScreenShare({ send: () => {}, onStream: () => {} });
  host.stream = { getTracks: () => [] };
  host.offerTo = async (id) => { offered.push(id); };

  await host.handleSignal({ from: 'viewer-1', data: { kind: 'reoffer' } });
  assert.deepEqual(offered, ['viewer-1'], 'the viewer knows something the host does not');

  // A viewer stuck in a retry loop must not make the host renegotiate
  // continuously — that would break the connection it is trying to recover.
  await host.handleSignal({ from: 'viewer-1', data: { kind: 'reoffer' } });
  await host.handleSignal({ from: 'viewer-1', data: { kind: 'reoffer' } });
  assert.equal(offered.length, 1, 'rate limited');

  // A different viewer has its own budget.
  await host.handleSignal({ from: 'viewer-2', data: { kind: 'reoffer' } });
  assert.deepEqual(offered, ['viewer-1', 'viewer-2']);

  // Once the interval passes, the first viewer may ask again.
  host.lastOffer.set('viewer-1', Date.now() - 6000);
  await host.handleSignal({ from: 'viewer-1', data: { kind: 'reoffer' } });
  assert.equal(offered.length, 3);
});

test('a viewer that is not sharing ignores a re-offer asked of it', async () => {
  const { ScreenShare } = await import('../public/screen.js');

  const sent = [];
  const viewer = new ScreenShare({ send: (message) => sent.push(message), onStream: () => {} });
  // No capture, so there is nothing to offer and nothing should be negotiated.
  await viewer.handleSignal({ from: 'someone', data: { kind: 'reoffer' } });
  assert.deepEqual(sent, []);
  assert.equal(viewer.peers.size, 0);
});

test('forgetting a viewer cancels the retry that outlives them', async (t) => {
  const { ScreenShare } = await import('../public/screen.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let offers = 0;
  const share = new ScreenShare({ send: () => {}, onStream: () => {} });
  share.stream = { getTracks: () => [] };
  share.offerTo = async () => { offers += 1; };

  share._scheduleReconnect('viewer-1', 0);
  share.forget('viewer-1');
  t.mock.timers.tick(60_000);
  await Promise.resolve();

  assert.equal(offers, 0, 'somebody who left is not chased');
  assert.equal(share.attempts.has('viewer-1'), false, 'and their backoff is not kept either');

  t.mock.timers.reset();
});

// Node has no WebRTC types; the code only ever wraps a plain description in
// one, so a pass-through stands in for it.
function stubWebRTC(t) {
  globalThis.RTCSessionDescription = class { constructor(init) { Object.assign(this, init); } };
  t.after(() => { delete globalThis.RTCSessionDescription; });
}

test('a second offer replaces the connection rather than renegotiating it', async (t) => {
  const { ScreenShare } = await import('../public/screen.js');
  stubWebRTC(t);

  const closed = [];
  const viewer = new ScreenShare({ send: () => {}, onStream: () => {} });
  // A stand-in peer: enough surface for the offer path, and it records when
  // it is closed so we can prove the stale one is discarded.
  viewer._peer = (id) => {
    const peer = {
      id,
      remote: null,
      local: null,
      setRemoteDescription: async (sdp) => { peer.remote = sdp; },
      createAnswer: async () => ({ type: 'answer', sdp: 'a=rtpmap:111 opus/48000/2\r\n' }),
      setLocalDescription: async (sdp) => { peer.local = sdp; },
      close: () => closed.push(peer),
      addEventListener: () => {},
    };
    viewer.peers.set(id, peer);
    return peer;
  };

  const offer = { type: 'offer', sdp: 'a=rtpmap:111 opus/48000/2\r\n' };
  await viewer.handleSignal({ from: 'host', data: { sdp: offer } });
  const first = viewer.peers.get('host');
  assert.ok(first, 'the first offer builds a connection');
  assert.deepEqual(closed, []);

  // The host tore its side down and offered again — a whole new connection,
  // with a new fingerprint. Reusing this side's peer would fail in a browser.
  await viewer.handleSignal({ from: 'host', data: { sdp: offer } });
  assert.deepEqual(closed, [first], 'the stale peer is closed');
  assert.notEqual(viewer.peers.get('host'), first, 'and replaced');
});

test('an answer for a connection that is gone is dropped, not re-created', async (t) => {
  const { ScreenShare } = await import('../public/screen.js');
  stubWebRTC(t);

  let built = 0;
  const host = new ScreenShare({ send: () => {}, onStream: () => {} });
  host._peer = () => { built += 1; return {}; };

  await host.handleSignal({ from: 'viewer-1', data: { sdp: { type: 'answer', sdp: '' } } });
  assert.equal(built, 0, 'a late answer must not resurrect a closed connection');
});
