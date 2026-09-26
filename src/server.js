// Serves the room: the page, the passcode check, and the WebSocket that passes
// screen-sharing handshakes between browsers. The picture itself never comes
// through here — it goes straight from one browser to the other.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Room, trimToLength } from './room.js';
import { attachWebSocketServer } from './ws.js';
import {
  AttemptLimiter,
  clientAddress,
  generatePasscode,
  generateToken,
  hashPasscode,
  parseCookies,
  signSession,
  verifyPasscode,
  verifySession,
} from './auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE_NAME = 'stream_session';
// Long enough to sit through a film and a break, short enough that a borrowed
// or forgotten browser does not stay in the room.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4096;
const DEFAULT_ROOM_NAME = 'Tonight at the pictures';
// The heading on the passcode page. Long enough for a sentence with feeling in
// it; short enough to sit on one or two lines of a phone.
const ROOM_NAME_MAX = 80;

export function cleanRoomName(value) {
  if (typeof value !== 'string') return DEFAULT_ROOM_NAME;
  const cleaned = trimToLength(value.replace(/\s+/g, ' ').trim(), ROOM_NAME_MAX);
  return cleaned || DEFAULT_ROOM_NAME;
}

// How the room looks. Classic is the plain one; cozy is warm, for an evening
// with somebody in particular — so it is chosen, not assumed.
export const THEMES = { classic: '#08090d', cozy: '#170d12' };

export function cleanTheme(value) {
  return Object.hasOwn(THEMES, value) ? value : 'classic';
}

// A message the host leaves for whoever signs in with the guest passcode,
// revealed the moment they do. Line breaks are kept: it is a note, not a
// heading. Empty means there is none.
const SURPRISE_MAX = 500;

export function cleanSurprise(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return trimToLength(cleaned, SURPRISE_MAX);
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// A version stamp for the page's own scripts. Without it a browser can keep
// running yesterday's app.js against today's server — which is how a stale
// client ended up in a reload loop against a server that had started clearing
// sessions on every page load.
async function assetVersion() {
  const hash = crypto.createHash('sha1');
  for (const name of ['app.js', 'screen.js', 'probe.js', 'selftest.js', 'stats.js', 'wakelock.js', 'styles.css']) {
    try {
      hash.update(await fsp.readFile(path.join(PUBLIC_DIR, name)));
    } catch {
      hash.update(name);
    }
  }
  return hash.digest('hex').slice(0, 12);
}

export async function createServer(options = {}) {
  const {
    hostPasscode,
    guestPasscode,
    sessionSecret = generateToken(32),
    roomName: initialRoomName = DEFAULT_ROOM_NAME,
    surprise: initialSurprise = '',
    theme: initialTheme = 'classic',
    // Told when the host changes either, so they can be kept for next time.
    onSettingsChange = () => {},
    // Sign-ins the host has thrown out, kept across restarts so a removed
    // browser cannot simply reconnect: [{ id, expiresAt }].
    revokedSessions = [],
    onRevokedChange = () => {},
    // Told when the host changes the guest passcode from the page.
    onPasscodeChange = () => {},
    // Extra ICE servers for screen sharing. Public STUN is enough for most
    // connections; a TURN relay is what gets through the ones it is not.
    iceServers = [],
    // How tall a shared screen is sent. Higher needs upload nobody at home has.
    shareHeight = 1080,
    rememberDevices = false,
    limiter = new AttemptLimiter(),
  } = options;

  if (!hostPasscode || !guestPasscode) {
    throw new Error('hostPasscode and guestPasscode are required');
  }
  if (hostPasscode === guestPasscode) {
    throw new Error('the host and guest passcodes must be different');
  }

  const passcodes = {
    host: hashPasscode(hostPasscode),
    guest: hashPasscode(guestPasscode),
  };
  // Shown on the host's own page, so they can send it without the console.
  let currentGuestPasscode = guestPasscode;

  // A sign-in is known by a digest of its cookie: enough to recognise it, and
  // nothing that could be used to sign in if the file were read.
  const sessionId = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
  const revoked = new Map(
    revokedSessions
      .filter((entry) => entry && typeof entry.id === 'string' && entry.expiresAt > Date.now())
      .map((entry) => [entry.id, entry.expiresAt])
  );

  const assets = await assetVersion();
  const room = new Room();
  // The host can change these from the page, so they live here.
  let roomName = cleanRoomName(initialRoomName);
  let surprise = cleanSurprise(initialSurprise);
  let theme = cleanTheme(initialTheme);
  const connections = new Map(); // viewerId -> WebSocketConnection

  function broadcast(message, { except } = {}) {
    for (const [id, connection] of connections) {
      if (except && id === except) continue;
      connection.send(message);
    }
  }

  // Only to people who came in with the guest passcode.
  function broadcastToGuests(message) {
    for (const [id, connection] of connections) {
      if (room.viewers.get(id)?.role === 'guest') connection.send(message);
    }
  }

  const broadcastState = () => broadcast(room.snapshot());
  const broadcastPresence = () => broadcast(room.presence());

  // ---------------------------------------------------------------- auth ---

  function identify(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = verifySession(sessionSecret, token);
    if (!session) return null;
    const id = sessionId(token);
    if (revoked.has(id)) return null;
    return { ...session, id };
  }

  // Throw a guest out: every connection on their sign-in closes, and the
  // sign-in stops working, here and after a restart.
  function removeGuest(viewerId) {
    const target = connections.get(viewerId);
    const viewer = room.viewers.get(viewerId);
    if (!target || viewer?.role !== 'guest') return null;
    const { sessionId: id, expiresAt } = target.data;
    const now = Date.now();
    for (const [key, until] of revoked) if (until <= now) revoked.delete(key);
    revoked.set(id, expiresAt ?? now + REMEMBERED_TTL_MS);
    onRevokedChange([...revoked].map(([key, until]) => ({ id: key, expiresAt: until })));
    for (const [otherId, connection] of connections) {
      if (connection.data.sessionId !== id) continue;
      connection.send({ type: 'removed' });
      connection.close(4001, 'removed');
      // Gone from the room now, not when the close handshake finishes.
      connections.delete(otherId);
      const { viewer: removed, endedShare } = room.removeViewer(otherId);
      if (removed && endedShare) broadcast({ ...room.snapshot(), reason: 'left', by: removed.name });
    }
    broadcastPresence();
    return viewer;
  }

  function sessionCookie(req, payload) {
    const token = signSession(sessionSecret, payload);
    // The tunnel terminates TLS and tells us so; mark the cookie Secure there.
    const secure = req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : '';
    // No Max-Age means the cookie dies with the browser, so closing it and
    // coming back asks for the passcode again. --remember-devices opts out.
    const lifetime = rememberDevices
      ? ` Max-Age=${Math.floor(REMEMBERED_TTL_MS / 1000)};`
      : '';
    return `${COOKIE_NAME}=${token}; Path=/;${lifetime} SameSite=Lax; HttpOnly;${secure}`;
  }

  async function handleJoin(req, res) {
    const address = clientAddress(req);
    const gate = limiter.check(address);
    if (!gate.allowed) {
      const seconds = Math.ceil(gate.retryAfterMs / 1000);
      sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minutes.` }, {
        'retry-after': String(seconds),
      });
      return;
    }

    const body = await readJsonBody(req);
    const submitted = typeof body?.passcode === 'string' ? body.passcode.trim() : '';
    const name = typeof body?.name === 'string' ? body.name : '';

    // Check both, in a fixed order, so timing doesn't reveal which one matched.
    const isHost = verifyPasscode(submitted, passcodes.host);
    const isGuest = verifyPasscode(submitted, passcodes.guest);

    if (!isHost && !isGuest) {
      limiter.fail(address);
      sendJson(res, 401, { error: 'That passcode is not right.' });
      return;
    }

    limiter.succeed(address);
    const payload = {
      role: isHost ? 'host' : 'guest',
      name: name.slice(0, 40),
      expiresAt: Date.now() + (rememberDevices ? REMEMBERED_TTL_MS : SESSION_TTL_MS),
    };
    sendJson(res, 200, { role: payload.role }, { 'set-cookie': sessionCookie(req, payload) });
  }

  // ---------------------------------------------------------------- HTTP ---

  async function serveStatic(req, res, name, extraHeaders = {}) {
    const safeName = path.basename(name);
    const filePath = path.join(PUBLIC_DIR, safeName);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      sendText(res, 404, 'Not found');
      return;
    }
    if (!stat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }
    const extension = path.extname(safeName).toLowerCase();
    const type = STATIC_TYPES[extension] ?? 'application/octet-stream';

    if (extension === '.html') {
      const html = (await fsp.readFile(filePath, 'utf8'))
        .replaceAll('{{ROOM_NAME}}', escapeHtml(roomName))
        // Set in the page itself, so the passcode page is already in the
        // chosen look rather than flashing the other one first.
        .replaceAll('{{THEME}}', theme)
        .replaceAll('{{THEME_COLOR}}', THEMES[theme])
        .replaceAll('{{ASSETS}}', assets);
      res.writeHead(200, {
        'content-type': type,
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
        ...extraHeaders,
      });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }

    const versioned = (req.url ?? '').includes('v=');
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...extraHeaders,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }

    const { pathname } = url;

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      sendText(res, 405, 'Method not allowed');
      return;
    }

    if (pathname.startsWith('/static/')) {
      await serveStatic(req, res, pathname.slice('/static/'.length));
      return;
    }
    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/join' && req.method === 'POST') {
      await handleJoin(req, res);
      return;
    }

    const session = identify(req);

    // Loading the page drops any session, so the passcode is asked for every
    // time it is opened. The gate is part of the page, so joining does not
    // navigate and does not clear itself.
    if (pathname === '/' || pathname === '/index.html') {
      await serveStatic(req, res, 'index.html', {
        'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
      });
      return;
    }

    if (!session) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (pathname === '/api/session') {
      sendJson(res, 200, { role: session.role, name: session.name ?? '', assets });
      return;
    }

    if (pathname === '/api/settings') {
      // The heading is the first thing anybody sees and the surprise is
      // personal, so both are the host's alone — to change, and to read back.
      if (session.role !== 'host') {
        sendJson(res, 403, { error: 'Only the host can change these.' });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof body?.roomName === 'string') roomName = cleanRoomName(body.roomName);
        const surpriseChanged = typeof body?.surprise === 'string' && cleanSurprise(body.surprise) !== surprise;
        if (typeof body?.surprise === 'string') surprise = cleanSurprise(body.surprise);
        const themeChanged = typeof body?.theme === 'string' && cleanTheme(body.theme) !== theme;
        if (typeof body?.theme === 'string') theme = cleanTheme(body.theme);
        onSettingsChange({ roomName, surprise, theme });
        broadcast({ type: 'room-name', name: roomName });
        if (themeChanged) broadcast({ type: 'theme', theme });
        // A new message is revealed to whoever is already here, too — and a
        // cleared one leaves their screen, back to the ordinary waiting one.
        if (surpriseChanged) broadcastToGuests({ type: 'surprise', text: surprise });
      }
      sendJson(res, 200, { roomName, surprise, theme, guestPasscode: currentGuestPasscode });
      return;
    }

    // A new guest passcode, so somebody who was removed cannot walk back in.
    // Whoever is in the room stays; only new sign-ins need the new one.
    if (pathname === '/api/passcode' && req.method === 'POST') {
      if (session.role !== 'host') {
        sendJson(res, 403, { error: 'Only the host can change the passcode.' });
        return;
      }
      let next = generatePasscode();
      while (next === hostPasscode || next === currentGuestPasscode) next = generatePasscode();
      currentGuestPasscode = next;
      passcodes.guest = hashPasscode(next);
      onPasscodeChange({ guestPasscode: next });
      sendJson(res, 200, { guestPasscode: next });
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      sendJson(res, 200, { ok: true }, {
        'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
      });
      return;
    }

    sendText(res, 404, 'Not found');
  });

  // ------------------------------------------------------------ WebSocket ---

  const wss = attachWebSocketServer(server, {
    path: '/ws',
    authorize: (req) => {
      const session = identify(req);
      return session
        ? { role: session.role, name: session.name, sessionId: session.id, expiresAt: session.expiresAt }
        : false;
    },
  });

  wss.on('connection', (connection) => {
    const viewer = room.addViewer({ role: connection.data.role, name: connection.data.name });
    connection.data.viewerId = viewer.id;
    connections.set(viewer.id, connection);

    connection.send({
      type: 'welcome',
      you: { id: viewer.id, name: viewer.name, role: viewer.role },
      state: room.snapshot(),
      chat: room.chat,
      roomName,
      theme,
      // Revealed the moment they sign in. Never in the page itself, so nobody
      // who merely finds the link can read it.
      ...(viewer.role === 'guest' && surprise ? { surprise } : {}),
      capabilities: { iceServers, shareHeight },
    });
    broadcastPresence();

    connection.on('message', (message) => {
      if (!message || typeof message.type !== 'string') return;
      const self = room.viewers.get(viewer.id);
      if (!self) return;

      switch (message.type) {
        case 'hello':
          room.rename(self.id, message.name);
          broadcastPresence();
          break;

        case 'share': {
          const on = Boolean(message.on);
          const result = room.setSharing(self, on);
          // Say why a share ended, so the other side can tell "they stopped"
          // from "their connection blinked" — the second is worth waiting out.
          if (result.changed) broadcast({ ...room.snapshot(), ...(on ? {} : { reason: 'stopped', by: self.name }) });
          else if (result.reason === 'not-allowed') {
            connection.send({ type: 'error', error: 'Only the host can share a screen.' });
          }
          break;
        }

        case 'signal': {
          // WebRTC offer/answer/ICE, passed between two viewers in this room.
          // The server never inspects it; the media never touches the server.
          const target = connections.get(message.to);
          if (target) target.send({ type: 'signal', from: self.id, data: message.data });
          break;
        }

        case 'chat': {
          const entry = room.addChat(self, message.text);
          if (entry) broadcast({ type: 'chat', entry });
          break;
        }

        case 'remove': {
          if (self.role !== 'host') {
            connection.send({ type: 'error', error: 'Only the host can remove people.' });
            break;
          }
          const removed = removeGuest(message.id);
          if (removed) connection.send({ type: 'removed-ok', name: removed.name });
          break;
        }

        default:
          break;
      }
    });

    connection.on('close', () => {
      connections.delete(viewer.id);
      const { viewer: removed, endedShare } = room.removeViewer(viewer.id);
      if (!removed) return;
      broadcastPresence();
      // Their screen left with them — or their connection to the site did,
      // with the picture still running. The viewers cannot tell which yet, so
      // they are told it was lost rather than stopped.
      if (endedShare) broadcast({ ...room.snapshot(), reason: 'left', by: removed.name });
    });
  });

  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    wss.close();
    return originalClose(callback);
  };

  server.room = room;
  // The live connections, so a test can cut one the way a network would.
  server.wss = wss;
  return server;
}
