// Serves the room: the page, the passcode check, and the WebSocket that passes
// screen-sharing handshakes between browsers. The picture itself never comes
// through here — it goes straight from one browser to the other.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Room } from './room.js';
import { attachWebSocketServer } from './ws.js';
import {
  AttemptLimiter,
  clientAddress,
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

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
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
    roomName = 'Tonight at the pictures',
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

  const assets = await assetVersion();
  const room = new Room();
  const connections = new Map(); // viewerId -> WebSocketConnection

  function broadcast(message, { except } = {}) {
    for (const [id, connection] of connections) {
      if (except && id === except) continue;
      connection.send(message);
    }
  }

  const broadcastState = () => broadcast(room.snapshot());
  const broadcastPresence = () => broadcast(room.presence());

  // ---------------------------------------------------------------- auth ---

  function identify(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    return verifySession(sessionSecret, token);
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
      return session ? { role: session.role, name: session.name } : false;
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
          const result = room.setSharing(self, Boolean(message.on));
          if (result.changed) broadcastState();
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

        default:
          break;
      }
    });

    connection.on('close', () => {
      connections.delete(viewer.id);
      const { viewer: removed, endedShare } = room.removeViewer(viewer.id);
      if (!removed) return;
      broadcastPresence();
      // Their screen left with them.
      if (endedShare) broadcastState();
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
