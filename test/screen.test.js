import test from 'node:test';
import assert from 'node:assert/strict';

import { upgradeAudio } from '../public/screen.js';
import { Room } from '../src/room.js';

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

test('switching to the screen is the host’s to make', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  assert.equal(room.applyControl(guest, { action: 'source', source: 'screen' }).reason, 'not-allowed');
  assert.equal(room.source, 'file');

  assert.equal(room.applyControl(host, { action: 'source', source: 'screen' }).changed, true);
  assert.equal(room.source, 'screen');
  assert.equal(room.snapshot().source, 'screen');

  // Asking for what is already true is not a change to broadcast.
  assert.equal(room.applyControl(host, { action: 'source', source: 'screen' }).changed, false);
  assert.equal(room.applyControl(host, { action: 'source', source: 'sideways' }).reason, 'bad-source');
});

test('picking a film comes back off the screen by itself', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });

  room.applyControl(host, { action: 'source', source: 'screen' });
  room.applyControl(host, { action: 'select', mediaId: 'abc' });

  assert.equal(room.source, 'file', 'choosing something to watch means watching it');
  assert.equal(room.mediaId, 'abc');
});

test('a live screen is never held for somebody’s buffer', () => {
  const room = new Room({ autoPauseOnBuffer: true });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  room.applyControl(host, { action: 'play', position: 0 });
  room.applyControl(host, { action: 'source', source: 'screen' });

  // Nothing to wait for: there is no buffer to catch up to on a live stream.
  assert.equal(room.report(guest, { buffering: true }).changed, false);
  assert.equal(room.waitingFor, null);
});

test('an emptied room forgets the screen too', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });
  room.applyControl(host, { action: 'source', source: 'screen' });
  room.clearPlayback();
  assert.equal(room.source, 'file');
});

test('the room leaves screen mode when the person sharing goes', () => {
  // Otherwise the next person to join is told they are watching a screen that
  // nobody is sharing — including the host, on their own machine.
  const room = new Room();
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  room.applyControl(host, { action: 'source', source: 'screen' });
  assert.equal(room.source, 'screen');
  assert.equal(room.sharerId, host.id);

  // Somebody else leaving changes nothing.
  room.removeViewer(guest.id);
  assert.equal(room.source, 'screen');

  room.removeViewer(host.id);
  assert.equal(room.source, 'file', 'their screen left with them');
  assert.equal(room.sharerId, null);
  assert.equal(room.snapshot().source, 'file');
});

test('stopping a share by hand clears who was sharing', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });

  room.applyControl(host, { action: 'source', source: 'screen' });
  room.applyControl(host, { action: 'source', source: 'file' });
  assert.equal(room.sharerId, null);

  // And picking a film does too, since that ends the share.
  room.applyControl(host, { action: 'source', source: 'screen' });
  room.applyControl(host, { action: 'select', mediaId: 'abc' });
  assert.equal(room.source, 'file');
  assert.equal(room.sharerId, null);
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

test('reconnection gives up rather than retrying forever', async (t) => {
  const { ScreenShare } = await import('../public/screen.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const states = [];
  const share = new ScreenShare({
    send: () => {},
    onStream: () => {},
    onStateChange: (id, value) => states.push(value),
  });
  share.stream = { getTracks: () => [] };
  share.offerTo = async () => {};

  // Well past the cap.
  for (let i = 0; i < 12; i++) {
    share._scheduleReconnect('viewer-1', 0);
    t.mock.timers.tick(20_000);
  }

  assert.ok(states.includes('gave-up'), 'it says so instead of trying silently');
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
