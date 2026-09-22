import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

import { createServer } from '../src/server.js';

const HOST_PASSCODE = 'HOSTWS';
const GUEST_PASSCODE = 'GUESTWS';

let server;
let wsBase;
let httpBase;
let mediaRoot;
let hostCookie;
let guestCookie;

before(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-ws-'));
  await fs.writeFile(path.join(mediaRoot, 'Film.mp4'), Buffer.alloc(2048));
  server = await createServer({
    roots: [mediaRoot],
    hostPasscode: HOST_PASSCODE,
    guestPasscode: GUEST_PASSCODE,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  httpBase = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/ws`;

  hostCookie = await joinFor(HOST_PASSCODE);
  guestCookie = await joinFor(GUEST_PASSCODE);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(mediaRoot, { recursive: true, force: true });
});

async function joinFor(passcode) {
  const response = await fetch(`${httpBase}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  assert.equal(response.status, 200, `join failed for ${passcode}`);
  return response.headers.get('set-cookie').split(';')[0];
}

// A tiny client wrapper: collects messages and lets a test await one by type.
function connect(cookie) {
  const socket = new WebSocket(wsBase, { headers: { cookie } });
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

test('a session cookie gets a welcome with the room state and library', async () => {
  const client = connect(hostCookie);
  await client.opened();
  const welcome = await client.next('welcome');

  assert.equal(welcome.you.role, 'host');
  assert.ok(welcome.you.id);
  assert.equal(welcome.state.paused, true);
  assert.equal(welcome.library.length, 1);
  client.close();
});

test('the host is recognised as the host', async () => {
  const client = connect(hostCookie);
  await client.opened();
  assert.equal((await client.next('welcome')).you.role, 'host');
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

test('ping/pong carries a server timestamp for clock sync', async () => {
  const client = connect(guestCookie);
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
  const host = connect(hostCookie);
  const guest = connect(guestCookie);
  await Promise.all([host.opened(), guest.opened()]);
  await Promise.all([host.next('welcome'), guest.next('welcome')]);

  host.send({ type: 'control', action: 'play', position: 42 });
  const state = await guest.next((m) => m.type === 'state' && !m.paused);
  assert.ok(state.position >= 42 && state.position < 44);

  guest.send({ type: 'control', action: 'pause', position: 50 });
  const paused = await host.next((m) => m.type === 'state' && m.paused && m.position >= 50);
  assert.equal(paused.paused, true);

  host.close();
  guest.close();
});

test('selecting a file broadcasts the file description to everyone', async () => {
  const host = connect(hostCookie);
  const guest = connect(guestCookie);
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
  const host = connect(hostCookie);
  const guest = connect(guestCookie);
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

test('a buffering report pauses the room for both sides', async () => {
  const host = connect(hostCookie);
  const guest = connect(guestCookie);
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
    hostPasscode: HOST_PASSCODE,
    guestPasscode: GUEST_PASSCODE,
    controlMode: 'host',
  });
  await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${strict.address().port}`;

  const response = await fetch(`${url}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: GUEST_PASSCODE }),
  });
  const cookie = response.headers.get('set-cookie').split(';')[0];

  const socket = new WebSocket(`${url.replace('http', 'ws')}/ws`, { headers: { cookie } });
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
  client.send({ type: 'ping', t0: 1 });
  assert.equal((await client.next('pong')).t0, 1);
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

  survivor.send({ type: 'ping', t0: 99 });
  assert.equal((await survivor.next((m) => m.type === 'pong' && m.t0 === 99)).t0, 99);
  survivor.close();
});

test('a guest gets no file list in the welcome message', async () => {
  const guest = connect(guestCookie);
  await guest.opened();
  const welcome = await guest.next('welcome');
  assert.deepEqual(welcome.library, [], 'the disk contents must not be broadcast');
  assert.equal(welcome.state.libraryMode, 'host');
  guest.close();

  const host = connect(hostCookie);
  await host.opened();
  assert.ok((await host.next('welcome')).library.length > 0, 'the host still sees it');
  host.close();
});

test('a guest cannot choose what plays', async () => {
  const host = connect(hostCookie);
  const guest = connect(guestCookie);
  await Promise.all([host.opened(), guest.opened()]);
  const welcome = await host.next('welcome');
  await guest.next('welcome');

  guest.send({ type: 'control', action: 'select', mediaId: welcome.library[0].id });
  const error = await guest.next('error');
  assert.match(error.error, /only the host can choose/i);

  // But she can still start and stop it, because that is a different
  // privilege. Pause first: earlier tests may have left the room playing,
  // and an unchanged room broadcasts nothing to wait on.
  guest.send({ type: 'control', action: 'pause', position: 0 });
  await guest.next((m) => m.type === 'state' && m.paused);
  guest.send({ type: 'control', action: 'play', position: 5 });
  await guest.next((m) => m.type === 'state' && !m.paused);

  host.close();
  guest.close();
});
