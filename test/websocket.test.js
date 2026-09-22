import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

import { createServer } from '../src/server.js';

const HOST_KEY = 'c'.repeat(32);
const GUEST_KEY = 'd'.repeat(32);

let server;
let wsBase;
let mediaRoot;

before(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-ws-'));
  await fs.writeFile(path.join(mediaRoot, 'Film.mp4'), Buffer.alloc(2048));
  server = await createServer({ roots: [mediaRoot], hostKey: HOST_KEY, guestKey: GUEST_KEY });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  wsBase = `ws://127.0.0.1:${server.address().port}/ws`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(mediaRoot, { recursive: true, force: true });
});

// A tiny client wrapper: collects messages and lets a test await one by type.
function connect(key) {
  const socket = new WebSocket(`${wsBase}?k=${key}`);
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

test('a valid key gets a welcome with the room state and library', async () => {
  const client = connect(GUEST_KEY);
  await client.opened();
  const welcome = await client.next('welcome');

  assert.equal(welcome.you.role, 'guest');
  assert.ok(welcome.you.id);
  assert.equal(welcome.state.type, 'state');
  assert.equal(welcome.state.paused, true);
  assert.equal(welcome.library.length, 1);
  client.close();
});

test('an invalid key is rejected at the handshake', async () => {
  const socket = new WebSocket(`${wsBase}?k=nope`);
  await assert.rejects(
    new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('rejected')));
      socket.addEventListener('close', () => reject(new Error('rejected')));
    })
  );
});

test('ping/pong carries a server timestamp for clock sync', async () => {
  const client = connect(GUEST_KEY);
  await client.opened();
  await client.next('welcome');

  const t0 = Date.now();
  client.send({ type: 'ping', t0 });
  const pong = await client.next('pong');

  assert.equal(pong.t0, t0);
  assert.ok(Math.abs(pong.serverTime - t0) < 5000);
  client.close();
});

test('one side pressing play moves the other side', async () => {
  const host = connect(HOST_KEY);
  const guest = connect(GUEST_KEY);
  await Promise.all([host.opened(), guest.opened()]);
  await Promise.all([host.next('welcome'), guest.next('welcome')]);

  host.send({ type: 'control', action: 'play', position: 42 });
  const state = await guest.next((m) => m.type === 'state' && !m.paused);

  assert.equal(state.paused, false);
  assert.ok(state.position >= 42 && state.position < 44);
  assert.ok(state.serverTime > 0);

  guest.send({ type: 'control', action: 'pause', position: 50 });
  const paused = await host.next((m) => m.type === 'state' && m.paused && m.position >= 50);
  assert.equal(paused.paused, true);

  host.close();
  guest.close();
});

test('selecting a file broadcasts the file description to everyone', async () => {
  const host = connect(HOST_KEY);
  const guest = connect(GUEST_KEY);
  await Promise.all([host.opened(), guest.opened()]);
  const welcome = await host.next('welcome');
  await guest.next('welcome');

  const id = welcome.library[0].id;
  host.send({ type: 'control', action: 'select', mediaId: id });

  const media = await guest.next('media');
  assert.equal(media.media.id, id);
  assert.equal(media.media.name, 'Film');

  const state = await guest.next((m) => m.type === 'state' && m.mediaId === id);
  assert.equal(state.paused, true);
  assert.equal(state.position, 0);

  host.close();
  guest.close();
});

test('chat reaches the other side with the sender name attached', async () => {
  const host = connect(HOST_KEY);
  const guest = connect(GUEST_KEY);
  await Promise.all([host.opened(), guest.opened()]);
  await Promise.all([host.next('welcome'), guest.next('welcome')]);

  host.send({ type: 'hello', name: 'Nikhil' });
  host.send({ type: 'chat', text: 'this bit is my favourite' });

  const chat = await guest.next('chat');
  assert.equal(chat.entry.text, 'this bit is my favourite');
  assert.equal(chat.entry.name, 'Nikhil');

  host.close();
  guest.close();
});

test('presence lists everyone in the room and updates when someone leaves', async () => {
  const host = connect(HOST_KEY);
  await host.opened();
  const hostWelcome = await host.next('welcome');

  const guest = connect(GUEST_KEY);
  await guest.opened();
  const guestWelcome = await guest.next('welcome');

  const has = (message, id) => message.viewers.some((viewer) => viewer.id === id);

  // Identities, not counts: sockets from earlier tests may still be closing.
  const both = await host.next(
    (m) => m.type === 'presence' && has(m, hostWelcome.you.id) && has(m, guestWelcome.you.id)
  );
  const me = both.viewers.find((viewer) => viewer.id === hostWelcome.you.id);
  assert.equal(me.role, 'host');
  assert.equal(both.viewers.find((viewer) => viewer.id === guestWelcome.you.id).role, 'guest');

  guest.close();
  const alone = await host.next(
    (m) => m.type === 'presence' && has(m, hostWelcome.you.id) && !has(m, guestWelcome.you.id)
  );
  assert.ok(alone, 'the departed guest should drop out of presence');
  host.close();
});

test('a buffering report pauses the room for both sides', async () => {
  const host = connect(HOST_KEY);
  const guest = connect(GUEST_KEY);
  await Promise.all([host.opened(), guest.opened()]);
  const welcome = await host.next('welcome');
  await guest.next('welcome');

  host.send({ type: 'control', action: 'select', mediaId: welcome.library[0].id });
  await guest.next('media');
  host.send({ type: 'control', action: 'play', position: 0 });
  await guest.next((m) => m.type === 'state' && !m.paused);

  guest.send({ type: 'report', position: 1, paused: false, buffering: true });
  const held = await host.next((m) => m.type === 'state' && m.paused && m.waitingFor);
  assert.ok(held.waitingFor);

  guest.send({ type: 'report', position: 1, paused: false, buffering: false });
  const resumed = await host.next((m) => m.type === 'state' && !m.paused);
  assert.equal(resumed.waitingFor, null);

  host.close();
  guest.close();
});

test('host-only rooms tell guests why their tap did nothing', async () => {
  const strict = await createServer({
    roots: [mediaRoot],
    hostKey: HOST_KEY,
    guestKey: GUEST_KEY,
    controlMode: 'host',
  });
  await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${strict.address().port}/ws?k=${GUEST_KEY}`;

  const socket = new WebSocket(url);
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 4000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'control', action: 'play' })));
    socket.addEventListener('message', (event) => {
      const parsed = JSON.parse(event.data);
      if (parsed.type === 'error') {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
  });

  assert.match(message.error, /only the host/i);
  socket.close();
  await new Promise((resolve) => strict.close(resolve));
});

test('WebRTC signalling is relayed to the named peer only', async () => {
  const host = connect(HOST_KEY);
  const guest = connect(GUEST_KEY);
  await Promise.all([host.opened(), guest.opened()]);
  const hostWelcome = await host.next('welcome');
  const guestWelcome = await guest.next('welcome');

  host.send({ type: 'signal', to: guestWelcome.you.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  const signal = await guest.next('signal');

  assert.equal(signal.from, hostWelcome.you.id);
  assert.equal(signal.data.sdp.type, 'offer');
  assert.ok(!host.received.some((m) => m.type === 'signal'), 'the sender should not see its own signal');

  host.close();
  guest.close();
});

test('the frame parser handles payloads past the 16- and 64-bit length markers', async () => {
  const client = connect(GUEST_KEY);
  await client.opened();
  await client.next('welcome');

  // 200 KB message: exercises the 64-bit length path in the frame decoder.
  client.send({ type: 'chat', text: 'x'.repeat(200_000) });
  const chat = await client.next('chat');
  assert.equal(chat.entry.text.length, 800, 'long messages are accepted, then trimmed');

  // 300 byte message: exercises the 16-bit length path.
  client.send({ type: 'chat', text: 'y'.repeat(300) });
  const second = await client.next((m) => m.type === 'chat' && m.entry.text.startsWith('y'));
  assert.equal(second.entry.text.length, 300);

  client.close();
});

test('malformed JSON does not take the connection down', async () => {
  const client = connect(GUEST_KEY);
  await client.opened();
  await client.next('welcome');

  client.socket.send('{not json at all');
  client.send({ type: 'ping', t0: 1 });
  const pong = await client.next('pong');
  assert.equal(pong.t0, 1);
  client.close();
});

test('a viewer whose connection is reset does not take the server down', async () => {
  const survivor = connect(HOST_KEY);
  await survivor.opened();
  await survivor.next('welcome');

  // Handshake by hand so we can yank the socket out with an RST, the way a
  // killed browser tab or a dropped phone connection does.
  const { port } = server.address();
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    `GET /ws?k=${GUEST_KEY} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n'
  );
  await new Promise((resolve) => socket.once('data', resolve));
  socket.resetAndDestroy();

  // The surviving client must still be served.
  survivor.send({ type: 'ping', t0: 99 });
  const pong = await survivor.next((m) => m.type === 'pong' && m.t0 === 99);
  assert.equal(pong.t0, 99);
  survivor.close();
});
