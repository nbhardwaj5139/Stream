import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../src/room.js';
import {
  AttemptLimiter,
  clientAddress,
  generatePasscode,
  hashPasscode,
  parseCookies,
  safeEqual,
  shouldReusePasscodes,
  signSession,
  verifyPasscode,
  verifySession,
} from '../src/auth.js';
import { acceptKey } from '../src/ws.js';

// ------------------------------------------------------------------ room --

test('only the host can start sharing a screen', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host', name: 'Sam' });
  const guest = room.addViewer({ role: 'guest', name: 'Alex' });

  assert.deepEqual(room.setSharing(guest, true), { changed: false, reason: 'not-allowed' });
  assert.equal(room.sharerId, null);

  assert.deepEqual(room.setSharing(host, true), { changed: true });
  assert.equal(room.snapshot().sharerId, host.id);
  // Saying so twice changes nothing, so nobody is told twice.
  assert.deepEqual(room.setSharing(host, true), { changed: false });
});

test('a share ends when its sharer stops it, and nobody else can stop it', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });
  const other = room.addViewer({ role: 'host' });

  room.setSharing(host, true);
  // A second host cannot end the first one's share.
  assert.deepEqual(room.setSharing(other, false), { changed: false });
  assert.equal(room.sharerId, host.id);

  assert.deepEqual(room.setSharing(host, false), { changed: true });
  assert.equal(room.sharerId, null);
});

test('a share ends when the sharer leaves, so nobody waits on a screen that has gone', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });
  room.setSharing(host, true);
  const before = room.version;

  // The guest leaving changes nothing about the share.
  assert.equal(room.removeViewer(guest.id).endedShare, false);
  assert.equal(room.sharerId, host.id);

  const { viewer, endedShare } = room.removeViewer(host.id);
  assert.equal(viewer.id, host.id);
  assert.equal(endedShare, true);
  assert.equal(room.sharerId, null);
  assert.ok(room.version > before, 'a new version, so every client re-renders');
});

test('removing somebody who is not there is harmless', () => {
  const room = new Room();
  assert.deepEqual(room.removeViewer('nobody'), { viewer: null, endedShare: false });
});

test('names are tidied, capped, and never left empty', () => {
  const room = new Room();
  const guest = room.addViewer({ role: 'guest', name: '   ' });
  assert.equal(guest.name, 'Guest');
  assert.equal(room.addViewer({ role: 'host' }).name, 'Host');

  room.rename(guest.id, '  Alex   from   work  ');
  assert.equal(guest.name, 'Alex from work');
  room.rename(guest.id, 'x'.repeat(100));
  assert.equal(guest.name.length, 40);
  // Renaming to nothing keeps the old name rather than blanking it.
  room.rename(guest.id, '   ');
  assert.equal(guest.name, 'x'.repeat(40));
});

test('chat trims, caps and attributes messages', () => {
  const room = new Room({ clock: () => 1000 });
  const viewer = room.addViewer({ name: 'Sam' });

  assert.equal(room.addChat(viewer, '   '), null, 'nothing to say is not a message');
  const entry = room.addChat(viewer, '  hello   there  ');
  assert.equal(entry.text, 'hello there');
  assert.equal(entry.name, 'Sam');
  assert.equal(entry.at, 1000);
  assert.equal(room.addChat(viewer, 'y'.repeat(2000)).text.length, 800);

  for (let i = 0; i < 250; i++) room.addChat(viewer, `m${i}`);
  assert.equal(room.chat.length, 200, 'history is bounded');
  assert.equal(room.chat.at(-1).text, 'm249');
});

test('presence lists who is here and nothing private', () => {
  const room = new Room();
  room.addViewer({ id: 'a', role: 'host', name: 'Sam' });
  room.addViewer({ id: 'b', role: 'guest', name: 'Alex' });
  assert.deepEqual(room.presence(), {
    type: 'presence',
    viewers: [
      { id: 'a', name: 'Sam', role: 'host' },
      { id: 'b', name: 'Alex', role: 'guest' },
    ],
  });
});

// ------------------------------------------------------------------ auth --

test('passcodes verify only against themselves', () => {
  const record = hashPasscode('POPCORN');
  assert.equal(verifyPasscode('POPCORN', record), true);
  assert.equal(verifyPasscode('POPCOR', record), false);
  assert.equal(verifyPasscode('POPCORNS', record), false);
  assert.equal(verifyPasscode('', record), false);
  assert.equal(verifyPasscode('POPCORN', null), false);
  // Case is deliberately not part of it; see the case-insensitivity test.
});

test('generated passcodes avoid letters people confuse', () => {
  for (let i = 0; i < 40; i++) {
    const code = generatePasscode();
    assert.equal(code.length, 6);
    assert.doesNotMatch(code, /[OIL01U]/, `ambiguous character in ${code}`);
  }
});

test('session tokens survive a round trip and reject tampering', () => {
  const secret = 'a-test-secret';
  const token = signSession(secret, { role: 'guest', name: 'Sam', expiresAt: Date.now() + 10_000 });

  const payload = verifySession(secret, token);
  assert.equal(payload.role, 'guest');
  assert.equal(payload.name, 'Sam');

  assert.equal(verifySession('another-secret', token), null, 'signed with a different key');
  assert.equal(verifySession(secret, token.slice(0, -2) + 'xx'), null, 'signature edited');
  assert.equal(verifySession(secret, 'nonsense'), null);
});

test('expired sessions and bogus roles are refused', () => {
  const secret = 'a-test-secret';
  assert.equal(
    verifySession(secret, signSession(secret, { role: 'guest', expiresAt: Date.now() - 1 })),
    null
  );
  assert.equal(
    verifySession(secret, signSession(secret, { role: 'admin', expiresAt: Date.now() + 10_000 })),
    null
  );
});

test('the attempt limiter locks out a client that keeps guessing', () => {
  let clock = 0;
  const limiter = new AttemptLimiter({ maxPerClient: 3, lockoutMs: 60_000, clock: () => clock });

  assert.equal(limiter.check('1.2.3.4').allowed, true);
  limiter.fail('1.2.3.4');
  limiter.fail('1.2.3.4');
  assert.equal(limiter.check('1.2.3.4').allowed, true, 'still under the limit');

  limiter.fail('1.2.3.4');
  const blocked = limiter.check('1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'client');

  // A different address is unaffected by this one's lockout.
  assert.equal(limiter.check('5.6.7.8').allowed, true);

  clock += 60_001;
  assert.equal(limiter.check('1.2.3.4').allowed, true, 'lockout expires');
});

test('the attempt limiter also caps guessing spread across many addresses', () => {
  let clock = 0;
  const limiter = new AttemptLimiter({ maxPerClient: 100, maxGlobal: 5, clock: () => clock });
  for (let i = 0; i < 5; i++) limiter.fail(`10.0.0.${i}`);
  const blocked = limiter.check('10.0.0.99');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'global');
});

test('a correct passcode clears that client’s failures', () => {
  const limiter = new AttemptLimiter({ maxPerClient: 3 });
  limiter.fail('1.2.3.4');
  limiter.fail('1.2.3.4');
  limiter.succeed('1.2.3.4');
  limiter.fail('1.2.3.4');
  assert.equal(limiter.check('1.2.3.4').allowed, true);
});

test('cookie parsing and constant-time comparison', () => {
  assert.deepEqual(parseCookies('a=1; stream_session=abc%20def'), { a: '1', stream_session: 'abc def' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', undefined), false);
});

test('the websocket handshake matches the RFC 6455 worked example', () => {
  // Getting the magic GUID wrong makes every browser refuse the connection,
  // so pin it to the published vector.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('the real visitor is identified behind a Cloudflare tunnel', () => {
  // Without this every request looks like 127.0.0.1 and the per-client rate
  // limit collapses into one shared bucket for everybody.
  const cf = clientAddress({
    headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9, 10.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(cf, '203.0.113.7');

  const forwarded = clientAddress({
    headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(forwarded, '198.51.100.9', 'the client is the first entry, not the proxy');

  const lan = clientAddress({ headers: {}, socket: { remoteAddress: '192.168.1.40' } });
  assert.equal(lan, '192.168.1.40');

  assert.equal(clientAddress({ headers: {}, socket: {} }), 'unknown');
});

test('two visitors behind the same tunnel are rate limited separately', () => {
  const limiter = new AttemptLimiter({ maxPerClient: 3, lockoutMs: 60_000 });
  const her = { headers: { 'cf-connecting-ip': '203.0.113.7' }, socket: {} };
  const stranger = { headers: { 'cf-connecting-ip': '198.51.100.4' }, socket: {} };

  for (let i = 0; i < 3; i++) limiter.fail(clientAddress(stranger));
  assert.equal(limiter.check(clientAddress(stranger)).allowed, false);
  assert.equal(limiter.check(clientAddress(her)).allowed, true, 'she is not locked out by a stranger');
});

test('a passcode is accepted whatever case it is typed in', () => {
  // The field renders uppercase but holds what was typed, phone keyboards
  // capitalise and laptop ones do not — so case cannot be part of the secret.
  const record = hashPasscode('K7M4PQ');
  assert.equal(verifyPasscode('K7M4PQ', record), true);
  assert.equal(verifyPasscode('k7m4pq', record), true);
  assert.equal(verifyPasscode('K7m4Pq', record), true);
  assert.equal(verifyPasscode('  k7m4pq  ', record), true, 'and surrounding space is ignored');

  // A different code is still a different code.
  assert.equal(verifyPasscode('K7M4PR', record), false);
  assert.equal(verifyPasscode('', record), false);

  // A passcode set in lower case works either way round too.
  const chosen = hashPasscode('popcorn');
  assert.equal(verifyPasscode('POPCORN', chosen), true);
  assert.equal(verifyPasscode('popcorn', chosen), true);
});

test('a restart minutes after the last one keeps the passcodes', () => {
  const now = Date.now();
  // Somebody in another country is holding a code that was right ten minutes
  // ago. Rotating here would lock them out of a film already in progress.
  assert.equal(shouldReusePasscodes({ startedAt: now - 10 * 60_000, now }), true);
  assert.equal(shouldReusePasscodes({ startedAt: now - 3.9 * 60 * 60_000, now }), true);
});

test('but a new evening gets new passcodes', () => {
  const now = Date.now();
  assert.equal(shouldReusePasscodes({ startedAt: now - 5 * 60 * 60_000, now }), false);
  assert.equal(shouldReusePasscodes({ startedAt: now - 30 * 24 * 60 * 60_000, now }), false);
  // Never run before: there is nothing to reuse.
  assert.equal(shouldReusePasscodes({ startedAt: null, now }), false);
  assert.equal(shouldReusePasscodes({ startedAt: undefined, now }), false);
  assert.equal(shouldReusePasscodes({ startedAt: 'yesterday', now }), false);
});

test('what was asked for beats what was inferred', () => {
  const now = Date.now();
  const old = now - 48 * 60 * 60_000;
  const recent = now - 60_000;

  assert.equal(shouldReusePasscodes({ startedAt: old, now, keepPasscodes: true }), true);
  assert.equal(shouldReusePasscodes({ startedAt: recent, now, newPasscodes: true }), false);
  // Both at once is contradictory; the destructive one wins, because it is
  // the one that cannot be arrived at by accident.
  assert.equal(
    shouldReusePasscodes({ startedAt: recent, now, keepPasscodes: true, newPasscodes: true }),
    false
  );
});

test('a clock that went backwards does not rotate the passcodes', () => {
  const now = Date.now();
  // A laptop resuming from sleep can correct its clock forwards, leaving a
  // timestamp in the future. That is a restart, not a month-old session.
  assert.equal(shouldReusePasscodes({ startedAt: now + 60_000, now }), false);
  assert.equal(shouldReusePasscodes({ startedAt: now, now }), true);
});
