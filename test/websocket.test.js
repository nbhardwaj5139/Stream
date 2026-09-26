import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

import { createServer } from '../src/server.js';

const HOST_PASSCODE = 'HOSTWS';
const GUEST_PASSCODE = 'GUESTWS';

let server;
let wsBase;
let httpBase;
let hostCookie;
let guestCookie;

before(async () => {
  server = await createServer({ hostPasscode: HOST_PASSCODE, guestPasscode: GUEST_PASSCODE });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  httpBase = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/ws`;

  hostCookie = await joinFor(HOST_PASSCODE);
  guestCookie = await joinFor(GUEST_PASSCODE);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function joinFor(passcode, base = httpBase) {
  const response = await fetch(`${base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  assert.equal(response.status, 200, `join failed for ${passcode}`);
  return response.headers.get('set-cookie').split(';')[0];
}

// A tiny client wrapper: collects messages and lets a test await one by type.
function connect(cookie, url = wsBase) {
  const socket = new WebSocket(url, { headers: { cookie } });
  const received = [];
  const waiters = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    received.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(message)) {
        waiters[i].resolve(message);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    socket,
    received,
    send: (message) => socket.send(JSON.stringify(message)),
    opened: () =>
      new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('connection refused')), { once: true });
      }),
    next(match, timeoutMs = 4000) {
      const predicate = typeof match === 'string' ? (m) => m.type === match : match;
      const existing = received.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${match}`)), timeoutMs);
        waiters.push({
          match: predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    close: () => socket.close(),
  };
}

// A room of its own, for tests that change who is sharing: the shared server
// is used by everything else, and a share left running would leak into them.
async function freshRoom(options = {}) {
  const own = await createServer({ hostPasscode: HOST_PASSCODE, guestPasscode: GUEST_PASSCODE, ...options });
  await new Promise((resolve) => own.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${own.address().port}`;
  const ws = `${base.replace('http', 'ws')}/ws`;
  return {
    server: own,
    join: async (passcode) => {
      const client = connect(await joinFor(passcode, base), ws);
      await client.opened();
      return client;
    },
    close: () => new Promise((resolve) => own.close(resolve)),
  };
}

test('a session cookie gets a welcome saying who you are and what is showing', async () => {
  const client = connect(hostCookie);
  await client.opened();
  const welcome = await client.next('welcome');

  assert.equal(welcome.you.role, 'host');
  assert.ok(welcome.you.id);
  assert.equal(welcome.state.sharerId, null, 'nothing is being shared yet');
  assert.deepEqual(welcome.capabilities, { iceServers: [], shareHeight: 1080 });
  assert.equal(welcome.library, undefined, 'there is no file list any more');
  client.close();
});

test('a connection with no session is rejected at the handshake', async () => {
  const socket = new WebSocket(wsBase);
  await assert.rejects(
    new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', () => reject(new Error('rejected')));
      socket.addEventListener('close', () => reject(new Error('rejected')));
    })
  );
});

test('a configured relay reaches the browsers the way they actually read it', async () => {
  // Screen sharing is peer to peer, so a relay has to arrive in the page or it
  // may as well not be configured. The page reads it from the welcome.
  const relay = { urls: ['turn:relay.example.com:3478'], username: 'someone', credential: 'secret' };
  const room = await freshRoom({ iceServers: [relay], shareHeight: 720 });
  const guest = await room.join(GUEST_PASSCODE);
  const welcome = await guest.next('welcome');

  assert.deepEqual(welcome.capabilities.iceServers, [relay]);
  assert.equal(welcome.capabilities.iceServers[0].credential, 'secret', 'credentials travel with it');
  assert.equal(welcome.capabilities.shareHeight, 720);

  guest.close();
  await room.close();
});

test('the host sharing tells everyone whose screen to show, and stopping tells them too', async () => {
  const room = await freshRoom();
  const host = await room.join(HOST_PASSCODE);
  const guest = await room.join(GUEST_PASSCODE);
  const hostWelcome = await host.next('welcome');
  await guest.next('welcome');

  host.send({ type: 'share', on: true });
  const started = await guest.next((m) => m.type === 'state' && m.sharerId);
  assert.equal(started.sharerId, hostWelcome.you.id);

  host.send({ type: 'share', on: false });
  const stopped = await guest.next((m) => m.type === 'state' && m.sharerId === null);
  assert.ok(stopped.version > started.version);
  // Said on purpose, and by whom, so the other side can say so in words.
  assert.equal(stopped.reason, 'stopped');
  assert.equal(stopped.by, 'Host');

  host.close();
  guest.close();
  await room.close();
});

test('somebody joining mid-share is told straight away whose screen it is', async () => {
  const room = await freshRoom();
  const host = await room.join(HOST_PASSCODE);
  const hostWelcome = await host.next('welcome');
  host.send({ type: 'share', on: true });
  await host.next((m) => m.type === 'state' && m.sharerId);

  const late = await room.join(GUEST_PASSCODE);
  const welcome = await late.next('welcome');
  assert.equal(welcome.state.sharerId, hostWelcome.you.id);

  host.close();
  late.close();
  await room.close();
});

test('the share ends for everyone when the sharer leaves', async () => {
  // Otherwise the room goes on claiming a screen nobody is sharing, and the
  // guest waits for a picture that is never coming.
  const room = await freshRoom();
  const host = await room.join(HOST_PASSCODE);
  const guest = await room.join(GUEST_PASSCODE);
  await Promise.all([host.next('welcome'), guest.next('welcome')]);

  host.send({ type: 'share', on: true });
  await guest.next((m) => m.type === 'state' && m.sharerId);

  host.close();
  const lost = await guest.next((m) => m.type === 'state' && m.sharerId === null);
  assert.equal(room.server.room.sharerId, null);
  // Not "stopped": the viewer should wait for them rather than give up.
  assert.equal(lost.reason, 'left');
  assert.equal(lost.by, 'Host');

  guest.close();
  await room.close();
});

test('a host back from a dropped connection can take the share straight back', async () => {
  // The browser keeps its capture through a blip in the site's connection and
  // reclaims the share on reconnecting. The room must accept that from the
  // host's new connection, and tell the guest who is sharing now.
  const room = await freshRoom();
  const guest = await room.join(GUEST_PASSCODE);
  await guest.next('welcome');

  const first = await room.join(HOST_PASSCODE);
  await first.next('welcome');
  first.send({ type: 'share', on: true });
  await guest.next((m) => m.type === 'state' && m.sharerId);
  first.close();
  await guest.next((m) => m.type === 'state' && m.sharerId === null);

  const again = await room.join(HOST_PASSCODE);
  const welcome = await again.next('welcome');
  again.send({ type: 'share', on: true });
  const reclaimed = await guest.next((m) => m.type === 'state' && m.sharerId === welcome.you.id);
  assert.equal(reclaimed.sharerId, welcome.you.id);

  again.close();
  guest.close();
  await room.close();
});

test('a guest cannot share, and is told why', async () => {
  const room = await freshRoom();
  const guest = await room.join(GUEST_PASSCODE);
  await guest.next('welcome');

  guest.send({ type: 'share', on: true });
  const error = await guest.next('error');
  assert.match(error.error, /only the host/i);
  assert.equal(room.server.room.sharerId, null);

  guest.close();
  await room.close();
});

test('chat reaches the other side with the sender name attached', async () => {
  const host = connect(hostCookie);
  const guest = connect(guestCookie);
  await Promise.all([host.opened(), guest.opened()]);
  await Promise.all([host.next('welcome'), guest.next('welcome')]);

  host.send({ type: 'hello', name: 'Sam' });
  host.send({ type: 'chat', text: 'this bit is my favourite' });

  const chat = await guest.next((m) => m.type === 'chat' && m.entry.text === 'this bit is my favourite');
  assert.equal(chat.entry.name, 'Sam');

  host.close();
  guest.close();
});

test('presence lists everyone and updates when someone leaves', async () => {
  const host = connect(hostCookie);
  await host.opened();
  const hostWelcome = await host.next('welcome');

  const guest = connect(guestCookie);
  await guest.opened();
  const guestWelcome = await guest.next('welcome');

  const has = (message, id) => message.viewers.some((viewer) => viewer.id === id);

  // Identities, not counts: sockets from earlier tests may still be closing.
  const both = await host.next(
    (m) => m.type === 'presence' && has(m, hostWelcome.you.id) && has(m, guestWelcome.you.id)
  );
  assert.equal(both.viewers.find((v) => v.id === hostWelcome.you.id).role, 'host');
  assert.equal(both.viewers.find((v) => v.id === guestWelcome.you.id).role, 'guest');

  guest.close();
  await host.next(
    (m) => m.type === 'presence' && has(m, hostWelcome.you.id) && !has(m, guestWelcome.you.id)
  );
  host.close();
});

test('the frame parser handles payloads past the 16- and 64-bit length markers', async () => {
  const client = connect(guestCookie);
  await client.opened();
  await client.next('welcome');

  // 200 KB message: exercises the 64-bit length path in the frame decoder.
  client.send({ type: 'chat', text: 'x'.repeat(200_000) });
  const chat = await client.next('chat');
  assert.equal(chat.entry.text.length, 800, 'long messages are accepted, then trimmed');

  // 300 bytes: exercises the 16-bit length path.
  client.send({ type: 'chat', text: 'y'.repeat(300) });
  const second = await client.next((m) => m.type === 'chat' && m.entry.text.startsWith('y'));
  assert.equal(second.entry.text.length, 300);

  client.close();
});

test('malformed JSON does not take the connection down', async () => {
  const client = connect(guestCookie);
  await client.opened();
  await client.next('welcome');

  client.socket.send('{not json at all');
  client.send({ type: 'chat', text: 'still here' });
  assert.equal((await client.next((m) => m.type === 'chat' && m.entry.text === 'still here')).entry.text, 'still here');
  client.close();
});

test('a viewer whose connection is reset does not take the server down', async () => {
  const survivor = connect(hostCookie);
  await survivor.opened();
  await survivor.next('welcome');

  // Handshake by hand so we can yank the socket out with an RST, the way a
  // killed browser tab or a dropped phone connection does.
  const { port } = server.address();
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    'GET /ws HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      `Cookie: ${guestCookie}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n'
  );
  await new Promise((resolve) => socket.once('data', resolve));
  socket.resetAndDestroy();

  survivor.send({ type: 'chat', text: 'still standing' });
  await survivor.next((m) => m.type === 'chat' && m.entry.text === 'still standing');
  survivor.close();
});

test('a browser closing its tab actually removes the viewer', async () => {
  // A graceful close frame used to leave the viewer behind: the teardown
  // checked a flag that sending the close frame had already cleared. Ghosts
  // then sat in presence forever, and one stuck mid-buffer could hold the
  // whole room paused.
  const watcher = connect(hostCookie);
  await watcher.opened();
  const mine = await watcher.next('welcome');

  const leaving = connect(guestCookie);
  await leaving.opened();
  const theirs = await leaving.next('welcome');

  await watcher.next(
    (m) => m.type === 'presence' && m.viewers.some((v) => v.id === theirs.you.id)
  );

  leaving.close(); // a clean close, the way a tab closing does it
  const gone = await watcher.next(
    (m) => m.type === 'presence' && !m.viewers.some((v) => v.id === theirs.you.id)
  );
  assert.ok(gone.viewers.some((v) => v.id === mine.you.id), 'we are still here');
  watcher.close();
});

test('WebRTC signalling reaches the named peer and nobody else', async () => {
  const host = connect(hostCookie);
  const guest = connect(guestCookie);
  await Promise.all([host.opened(), guest.opened()]);
  const hostWelcome = await host.next('welcome');
  const guestWelcome = await guest.next('welcome');

  host.send({
    type: 'signal',
    to: guestWelcome.you.id,
    data: { sdp: { type: 'offer', sdp: 'v=0' } },
  });

  const signal = await guest.next('signal');
  assert.equal(signal.from, hostWelcome.you.id);
  assert.equal(signal.data.sdp.type, 'offer');
  assert.ok(!host.received.some((m) => m.type === 'signal'), 'the sender does not see its own');

  // Answering goes back the other way.
  guest.send({ type: 'signal', to: hostWelcome.you.id, data: { sdp: { type: 'answer', sdp: 'v=0' } } });
  const answer = await host.next('signal');
  assert.equal(answer.data.sdp.type, 'answer');

  host.close();
  guest.close();
});


// ------------------------------------------------------------ the surprise --

async function post(base, cookie, body) {
  const response = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test('the surprise is revealed to the guest on arrival, and only to the guest', async () => {
  const saved = [];
  const room = await freshRoom({ onSettingsChange: (settings) => saved.push(settings) });
  const base = `http://127.0.0.1:${room.server.address().port}`;
  const hostCookie = await joinFor(HOST_PASSCODE, base);

  const set = await post(base, hostCookie, { surprise: 'A little note for tonight ❤️' });
  assert.equal(set.status, 200);
  assert.equal(saved.at(-1).surprise, 'A little note for tonight ❤️', 'kept for next time');

  const guest = await room.join(GUEST_PASSCODE);
  assert.equal((await guest.next('welcome')).surprise, 'A little note for tonight ❤️');

  // The host wrote it; it is not sprung on them.
  const host = await room.join(HOST_PASSCODE);
  assert.equal((await host.next('welcome')).surprise, undefined);

  // Never in the page itself, which anybody with the link can load.
  const page = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(page, /little note/);

  guest.close();
  host.close();
  await room.close();
});

test('a new surprise is revealed to a guest who is already here', async () => {
  const room = await freshRoom();
  const base = `http://127.0.0.1:${room.server.address().port}`;
  const hostCookie = await joinFor(HOST_PASSCODE, base);
  const guest = await room.join(GUEST_PASSCODE);
  const host = await room.join(HOST_PASSCODE);
  await Promise.all([guest.next('welcome'), host.next('welcome')]);

  await post(base, hostCookie, { surprise: 'Look up 🙂' });
  assert.equal((await guest.next('surprise')).text, 'Look up 🙂');

  // Saving the same words again is not a new surprise.
  await post(base, hostCookie, { surprise: 'Look up 🙂' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(guest.received.filter((m) => m.type === 'surprise').length, 1);
  assert.ok(!host.received.some((m) => m.type === 'surprise'), 'not to the host');

  guest.close();
  host.close();
  await room.close();
});

test('only the host can write the heading or the surprise, or read them back', async () => {
  const room = await freshRoom();
  const base = `http://127.0.0.1:${room.server.address().port}`;
  const guestCookie = await joinFor(GUEST_PASSCODE, base);

  assert.equal((await post(base, guestCookie, { surprise: 'hijacked' })).status, 403);
  assert.equal((await post(base, guestCookie, { roomName: 'hijacked' })).status, 403);
  const read = await fetch(`${base}/api/settings`, { headers: { cookie: guestCookie } });
  assert.equal(read.status, 403);
  assert.equal((await fetch(`${base}/api/settings`)).status, 401, 'and nobody signed out at all');

  await room.close();
});

test('the heading is changed from the page, escaped, and shown to everyone', async () => {
  const room = await freshRoom();
  const base = `http://127.0.0.1:${room.server.address().port}`;
  const hostCookie = await joinFor(HOST_PASSCODE, base);
  const guest = await room.join(GUEST_PASSCODE);
  await guest.next('welcome');

  const set = await post(base, hostCookie, { roomName: 'Movie night <3 & popcorn' });
  assert.equal(set.body.roomName, 'Movie night <3 & popcorn');
  assert.equal((await guest.next('room-name')).name, 'Movie night <3 & popcorn');

  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /Movie night &lt;3 &amp; popcorn/);
  assert.doesNotMatch(page, /<3 &/, 'never injected raw');

  // Emptied, it goes back to the default rather than a blank heading.
  assert.equal((await post(base, hostCookie, { roomName: '   ' })).body.roomName, 'Tonight at the pictures');

  guest.close();
  await room.close();
});

test('the surprise keeps its line breaks and is held to a length', async () => {
  const room = await freshRoom();
  const base = `http://127.0.0.1:${room.server.address().port}`;
  const hostCookie = await joinFor(HOST_PASSCODE, base);

  const kept = await post(base, hostCookie, { surprise: '  Line one\r\n\r\n\r\n\r\nLine two  ' });
  assert.equal(kept.body.surprise, 'Line one\n\nLine two', 'a note keeps its shape, without runs of blank lines');
  const long = await post(base, hostCookie, { surprise: '❤️'.repeat(400) });
  assert.ok(long.body.surprise.length <= 500);
  assert.doesNotMatch(long.body.surprise, /[\uD800-\uDBFF]$/, 'and never ends in half an emoji');

  await room.close();
});

test('the room is classic until the host chooses otherwise, and then for everyone', async () => {
  const saved = [];
  const room = await freshRoom({ onSettingsChange: (settings) => saved.push(settings) });
  const base = `http://127.0.0.1:${room.server.address().port}`;

  // Classic by default, and set in the page itself, so there is no flash of
  // the other look before the script runs.
  let page = await (await fetch(`${base}/`)).text();
  assert.match(page, /<html lang="en" data-theme="classic">/);
  assert.match(page, /name="theme-color" content="#08090d"/);

  const hostCookie = await joinFor(HOST_PASSCODE, base);
  const guest = await room.join(GUEST_PASSCODE);
  assert.equal((await guest.next('welcome')).theme, 'classic');

  assert.equal((await post(base, hostCookie, { theme: 'cozy' })).body.theme, 'cozy');
  assert.equal((await guest.next('theme')).theme, 'cozy', 'she sees it change without reloading');
  assert.equal(saved.at(-1).theme, 'cozy', 'and it is kept for next time');

  page = await (await fetch(`${base}/`)).text();
  assert.match(page, /data-theme="cozy"/, 'the passcode page opens in it too');
  assert.match(page, /content="#170d12"/);

  // Saving again without changing it tells nobody anything.
  await post(base, hostCookie, { theme: 'cozy' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(guest.received.filter((m) => m.type === 'theme').length, 1);

  // Anything unexpected is classic, never injected into the page.
  assert.equal((await post(base, hostCookie, { theme: '"><script>' })).body.theme, 'classic');
  page = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(page, /<script>"/);

  guest.close();
  await room.close();
});

test('a guest cannot change the look of the room', async () => {
  const room = await freshRoom();
  const base = `http://127.0.0.1:${room.server.address().port}`;
  const guestCookie = await joinFor(GUEST_PASSCODE, base);
  assert.equal((await post(base, guestCookie, { theme: 'cozy' })).status, 403);
  assert.match(await (await fetch(`${base}/`)).text(), /data-theme="classic"/);
  await room.close();
});

test('clearing the surprise takes it off a guest who is already here', async () => {
  const room = await freshRoom();
  const base = `http://127.0.0.1:${room.server.address().port}`;
  const hostCookie = await joinFor(HOST_PASSCODE, base);
  const guest = await room.join(GUEST_PASSCODE);
  await guest.next('welcome');

  await post(base, hostCookie, { surprise: 'Soon 🙂' });
  await guest.next((m) => m.type === 'surprise' && m.text === 'Soon 🙂');
  await post(base, hostCookie, { surprise: '   ' });
  const cleared = await guest.next((m) => m.type === 'surprise' && m.text === '');
  assert.equal(cleared.text, '', 'told, so their screen goes back to the ordinary one');

  // And someone arriving now gets no surprise at all.
  const late = await room.join(GUEST_PASSCODE);
  assert.equal((await late.next('welcome')).surprise, undefined);

  guest.close();
  late.close();
  await room.close();
});

// The host shows a guest out.
async function removalRoom(options = {}) {
  const room = await freshRoom(options);
  const base = `http://127.0.0.1:${room.server.address().port}`;
  const ws = `${base.replace('http', 'ws')}/ws`;
  const hostCookie = await joinFor(HOST_PASSCODE, base);
  const host = connect(hostCookie, ws);
  await host.opened();
  const guestCookie = await joinFor(GUEST_PASSCODE, base);
  const guest = connect(guestCookie, ws);
  await guest.opened();
  const other = await room.join(GUEST_PASSCODE);
  const guestId = (await guest.next('welcome')).you.id;
  return { room, base, ws, host, guest, other, guestCookie, guestId, hostCookie };
}

const closed = (client) =>
  new Promise((resolve) => {
    if (client.socket.readyState === WebSocket.CLOSED) resolve();
    else client.socket.addEventListener('close', resolve, { once: true });
  });

test('the host can remove a guest, who is told, disconnected, and gone from the room', async () => {
  const { room, host, guest, other, guestId } = await removalRoom();
  host.send({ type: 'remove', id: guestId });

  assert.equal((await guest.next('removed')).type, 'removed', 'told why, so their page does not just reconnect');
  await closed(guest);
  const ok = await host.next('removed-ok');
  assert.ok(ok.name, 'the host hears it worked');
  await other.next((m) => m.type === 'presence' && !m.viewers.some((v) => v.id === guestId));
  assert.equal(room.server.room.viewers.has(guestId), false);
  assert.equal(other.socket.readyState, WebSocket.OPEN, 'everyone else stays');

  host.close();
  other.close();
  await room.close();
});

test('a removed sign-in stops working: no reconnecting, and no session', async () => {
  const { room, base, ws, host, guest, other, guestCookie, guestId } = await removalRoom();
  host.send({ type: 'remove', id: guestId });
  await closed(guest);

  const again = connect(guestCookie, ws);
  await assert.rejects(again.opened(), /refused/, 'the old cookie cannot reconnect');
  const session = await fetch(`${base}/api/session`, { headers: { cookie: guestCookie } });
  assert.equal(session.status, 401);

  host.close();
  other.close();
  await room.close();
});

test('removals survive a restart of the room', async () => {
  const sessionSecret = 'a-fixed-secret-for-this-test-only-000000';
  let saved = [];
  const first = await removalRoom({ sessionSecret, onRevokedChange: (list) => { saved = list; } });
  first.host.send({ type: 'remove', id: first.guestId });
  await closed(first.guest);
  assert.equal(saved.length, 1, 'handed over to be kept');
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(first.guestCookie.split('=')[1].slice(0, 20)), 'not the cookie itself');
  first.host.close();
  first.other.close();
  await first.room.close();

  const second = await freshRoom({ sessionSecret, revokedSessions: saved });
  const base = `http://127.0.0.1:${second.server.address().port}`;
  const session = await fetch(`${base}/api/session`, { headers: { cookie: first.guestCookie } });
  assert.equal(session.status, 401, 'still out after the restart');
  await second.close();
});

test('only the host can remove anyone, and only guests can be removed', async () => {
  const { room, host, guest, other, guestId } = await removalRoom();
  const hostId = (await host.next('welcome')).you.id;

  guest.send({ type: 'remove', id: (await other.next('welcome')).you.id });
  assert.match((await guest.next('error')).error, /Only the host/);
  host.send({ type: 'remove', id: hostId });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(room.server.room.viewers.size, 3, 'nobody went anywhere');
  assert.equal(room.server.room.viewers.has(guestId), true);

  host.close();
  guest.close();
  other.close();
  await room.close();
});

test('the host can change the guest passcode; the old one stops working, and nobody here is thrown out', async () => {
  let told = null;
  const { room, base, host, guest, other, hostCookie, guestCookie } = await removalRoom({
    onPasscodeChange: ({ guestPasscode }) => { told = guestPasscode; },
  });

  const before = await fetch(`${base}/api/settings`, { headers: { cookie: hostCookie } }).then((r) => r.json());
  assert.equal(before.guestPasscode, GUEST_PASSCODE, 'the host can see it on their page');

  const denied = await fetch(`${base}/api/passcode`, { method: 'POST', headers: { cookie: guestCookie } });
  assert.equal(denied.status, 403, 'a guest cannot change it');

  const changed = await fetch(`${base}/api/passcode`, { method: 'POST', headers: { cookie: hostCookie } }).then((r) => r.json());
  assert.match(changed.guestPasscode, /^\S{4,}$/);
  assert.notEqual(changed.guestPasscode, GUEST_PASSCODE);
  assert.notEqual(changed.guestPasscode, HOST_PASSCODE);
  assert.equal(told, changed.guestPasscode, 'handed over to be kept');

  const old = await fetch(`${base}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: GUEST_PASSCODE }),
  });
  assert.equal(old.status, 401, 'the old passcode no longer works');
  await joinFor(changed.guestPasscode, base);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(guest.socket.readyState, WebSocket.OPEN, 'people already here stay');
  assert.equal(other.socket.readyState, WebSocket.OPEN);
  const stillIn = await fetch(`${base}/api/session`, { headers: { cookie: guestCookie } });
  assert.equal(stillIn.status, 200, 'and can reconnect if their connection blinks');

  host.close();
  guest.close();
  other.close();
  await room.close();
});
