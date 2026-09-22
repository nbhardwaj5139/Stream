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
