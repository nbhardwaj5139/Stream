import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Library, publicDescription, mimeForFile, detectFfmpeg, suggestedQuality } from './media.js';
import { readSubtitleAsVtt, extractEmbeddedSubtitle } from './subtitles.js';
import { startTranscode, detectCapabilities, pickEncoder } from './transcode.js';
import { HlsSessions, isSegmentName, parseSessionKey, sessionKey } from './hls.js';
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
import { parseRange } from './range.js';

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
  for (const name of ['app.js', 'styles.css']) {
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
    roots = [process.cwd()],
    hostPasscode,
    guestPasscode,
    sessionSecret = generateToken(32),
    controlMode = 'everyone',
    libraryMode = 'host',
    roomName = 'Tonight at the pictures',
    rememberDevices = false,
    resetWhenEmptyMs = 90_000,
    autoPauseOnBuffer = true,
    allowTranscode = true,
    preferSoftwareEncoder = false,
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

  const library = new Library(roots);
  await library.scan();

  const room = new Room({ controlMode, libraryMode, autoPauseOnBuffer });

  // A guest sees the film that is playing and nothing else on the disk. Even
  // holding an id from a previous film gets them nothing once it changes.
  function canReach(session, mediaId) {
    if (session.role === 'host' || room.libraryMode === 'shared') return true;
    return Boolean(room.mediaId) && mediaId === room.mediaId;
  }
  const ffmpeg = await detectFfmpeg();
  const encoding = ffmpeg.ffmpeg
    ? await detectCapabilities()
    : { encoders: [], canToneMap: false };
  const encoder = pickEncoder(encoding.encoders, { preferSoftware: preferSoftwareEncoder });

  const connections = new Map(); // viewerId -> WebSocketConnection
  let emptyRoomTimer = null;

  // Safari cannot play the fragmented-MP4 stream, so it gets HLS instead.
  const hls = new HlsSessions();
  const hlsSweeper = setInterval(() => hls.sweep(), 60_000);
  hlsSweeper.unref?.();

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

  async function serveDirect(req, res, item) {
    let stat;
    try {
      stat = await fsp.stat(item.path);
    } catch {
      sendText(res, 404, 'File is gone');
      return;
    }

    const contentType = mimeForFile(item.path);
    const rangeHeader = req.headers.range;

    if (!rangeHeader) {
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': stat.size,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(item.path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    const range = parseRange(rangeHeader, stat.size);
    if (!range || range.invalid) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}`, 'content-type': 'text/plain' });
      res.end('Range not satisfiable');
      return;
    }

    res.writeHead(206, {
      'content-type': contentType,
      'content-length': range.length,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(item.path, { start: range.start, end: range.end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  function serveTranscode(req, res, item, url, isHost = false) {
    if (!allowTranscode || !ffmpeg.ffmpeg) {
      sendText(res, 503, 'This file needs ffmpeg, which was not found on the host machine.');
      return;
    }

    const startSeconds = Math.max(0, Number(url.searchParams.get('start')) || 0);
    const audioTrack = Math.max(0, Number(url.searchParams.get('track')) || 0);
    const requested = url.searchParams.get('quality');
    const quality = ['low', 'medium', 'high', 'original'].includes(requested) ? requested : 'original';

    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'none' });
      res.end();
      return;
    }

    const job = startTranscode({
      filePath: item.path,
      startSeconds,
      info: item.info,
      audioTrack,
      quality,
      encoder,
      canToneMap: encoding.canToneMap,
    });

    // Hold the status line until ffmpeg actually produces a byte. Committing to
    // a 200 up front turns "ffmpeg could not decode this" into an empty video
    // and a useless error in the browser.
    let started = false;
    job.stdout.once('data', (chunk) => {
      started = true;
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'cache-control': 'no-store',
        // Length is unknown while ffmpeg is still running; no seeking by range.
        'accept-ranges': 'none',
        'x-stream-start': String(startSeconds),
        'x-stream-encoder': encoder,
      });
      res.write(chunk);
      job.stdout.pipe(res);
    });

    job.stdout.on('error', () => job.stop());

    job.process.on('close', (code) => {
      if (started) {
        if (code && code !== 0) {
          process.stderr.write(`\nffmpeg exited ${code} partway through:\n${job.getStderr()}\n`);
        }
        if (!res.writableEnded) res.end();
        return;
      }

      // Nothing ever came out: a real failure, and we can still say so properly.
      const detail = job.getStderr().trim();
      process.stderr.write(
        `\nffmpeg could not transcode ${item.relativePath} (exit ${code}):\n` +
          `  ${job.args.join(' ')}\n${detail || '  (no output)'}\n`
      );
      if (res.headersSent || res.writableEnded) return;
      // The host gets the real reason; a guest gets no filesystem detail.
      sendText(
        res,
        500,
        isHost
          ? `ffmpeg could not play this file (exit ${code}).\n\n${detail || 'No error output.'}`
          : 'The host machine could not decode this file.'
      );
    });

    // Browser closed the tab or seeked: stop burning the GPU immediately.
    res.on('close', () => job.stop());
  }

  async function serveSubtitle(res, item, subtitleId) {
    const [kind, rawIndex] = String(subtitleId).split(':');
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) {
      sendText(res, 400, 'Bad subtitle id');
      return;
    }

    try {
      let vtt;
      if (kind === 'file') {
        const sidecar = (item.subtitles ?? [])[index];
        if (!sidecar) {
          sendText(res, 404, 'No such subtitle');
          return;
        }
        vtt = await readSubtitleAsVtt(sidecar.file);
      } else if (kind === 'embedded') {
        if (!ffmpeg.ffmpeg) {
          sendText(res, 503, 'Embedded subtitles need ffmpeg on the host machine.');
          return;
        }
        const track = (item.info?.embeddedSubtitles ?? []).find((sub) => sub.index === index);
        if (!track || !track.textBased) {
          sendText(res, 404, 'No such subtitle');
          return;
        }
        vtt = await extractEmbeddedSubtitle(item.path, track.streamIndex);
      } else {
        sendText(res, 400, 'Bad subtitle id');
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/vtt; charset=utf-8',
        'content-length': Buffer.byteLength(vtt),
        'cache-control': 'no-store',
      });
      res.end(vtt);
    } catch (error) {
      sendText(res, 500, `Could not read subtitles: ${error.message}`);
    }
  }

  async function serveHls(req, res, key, file, session) {
    const parsed = parseSessionKey(key);
    if (!parsed) {
      sendText(res, 400, 'Bad stream id');
      return;
    }
    if (!canReach(session, parsed.mediaId)) {
      sendText(res, 403, 'Only what is playing right now.');
      return;
    }
    if (!allowTranscode || !ffmpeg.ffmpeg) {
      sendText(res, 503, 'This file needs ffmpeg, which was not found on the host machine.');
      return;
    }

    const item = await library.describe(parsed.mediaId);
    if (!item) {
      sendText(res, 404, 'Not found');
      return;
    }

    // Segments: plain file reads out of this session's directory.
    if (isSegmentName(file)) {
      const active = hls.touch(key);
      const target = path.join(hls.directoryFor(key), file);
      if (!active || !fs.existsSync(target)) {
        sendText(res, 404, 'No such segment');
        return;
      }
      const stat = await fsp.stat(target);
      res.writeHead(200, {
        'content-type': 'video/mp2t',
        'content-length': stat.size,
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(target);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    if (file !== 'playlist.m3u8') {
      sendText(res, 404, 'Not found');
      return;
    }

    const active = hls.start(key, {
      filePath: item.path,
      startSeconds: parsed.start,
      info: item.info,
      audioTrack: parsed.track,
      quality: parsed.quality,
      encoder,
      canToneMap: encoding.canToneMap,
    });

    const playlist = await hls.waitForPlaylist(active);
    if (!playlist) {
      process.stderr.write(
        `\nffmpeg could not produce HLS for ${item.relativePath}:\n` +
          `  ${active.args.join(' ')}\n${active.stderr || '  (no output)'}\n`
      );
      hls.stop(key);
      sendText(
        res,
        500,
        session.role === 'host'
          ? `ffmpeg could not play this file.\n\n${active.stderr || 'No error output.'}`
          : 'The host machine could not prepare this file.'
      );
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(playlist),
    });
    res.end(req.method === 'HEAD' ? undefined : playlist);
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
      sendJson(res, 200, { ok: true, files: library.items.size });
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
      sendJson(res, 200, {
        role: session.role,
        name: session.name ?? '',
        controlMode: room.controlMode,
        libraryMode: room.libraryMode,
        rememberDevices,
        ffmpeg: ffmpeg.ffmpeg,
        ffprobe: ffmpeg.ffprobe,
        encoder,
        assets,
        hardwareEncoding: encoder !== 'libx264',
        canToneMap: encoding.canToneMap,
        roots: session.role === 'host' ? library.roots : undefined,
      });
      return;
    }

    if (pathname === '/api/library') {
      if (session.role !== 'host' && room.libraryMode !== 'shared') {
        sendJson(res, 403, { error: 'The library is host only.' });
        return;
      }
      sendJson(res, 200, { items: library.list(), scannedAt: library.scannedAt });
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      sendJson(res, 200, { ok: true }, {
        'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
      });
      return;
    }

    if (pathname === '/api/rescan' && req.method === 'POST') {
      if (session.role !== 'host') {
        sendJson(res, 403, { error: 'host only' });
        return;
      }
      await library.scan();
      sendJson(res, 200, { items: library.list(), scannedAt: library.scannedAt });
      return;
    }

    const mediaMatch = /^\/api\/media\/([a-f0-9]{16})$/.exec(pathname);
    if (mediaMatch) {
      if (!canReach(session, mediaMatch[1])) {
        sendJson(res, 403, { error: 'Only what is playing right now.' });
        return;
      }
      const item = await library.describe(mediaMatch[1]);
      if (!item) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, publicDescription(item));
      return;
    }

    const streamMatch = /^\/stream\/([a-f0-9]{16})$/.exec(pathname);
    if (streamMatch) {
      if (!canReach(session, streamMatch[1])) {
        sendText(res, 403, 'Only what is playing right now.');
        return;
      }
      const item = await library.describe(streamMatch[1]);
      if (!item) {
        sendText(res, 404, 'Not found');
        return;
      }
      await serveDirect(req, res, item);
      return;
    }

    const transcodeMatch = /^\/transcode\/([a-f0-9]{16})$/.exec(pathname);
    if (transcodeMatch) {
      if (!canReach(session, transcodeMatch[1])) {
        sendText(res, 403, 'Only what is playing right now.');
        return;
      }
      const item = await library.describe(transcodeMatch[1]);
      if (!item) {
        sendText(res, 404, 'Not found');
        return;
      }
      serveTranscode(req, res, item, url, session.role === 'host');
      return;
    }

    const hlsMatch = /^\/hls\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (hlsMatch) {
      await serveHls(req, res, hlsMatch[1], hlsMatch[2], session);
      return;
    }

    const subtitleMatch = /^\/subtitles\/([a-f0-9]{16})\/([a-z]+:\d+)\.vtt$/.exec(pathname);
    if (subtitleMatch) {
      if (!canReach(session, subtitleMatch[1])) {
        sendText(res, 403, 'Only what is playing right now.');
        return;
      }
      const item = await library.describe(subtitleMatch[1]);
      if (!item) {
        sendText(res, 404, 'Not found');
        return;
      }
      await serveSubtitle(res, item, subtitleMatch[2]);
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
    clearTimeout(emptyRoomTimer);
    const viewer = room.addViewer({ role: connection.data.role, name: connection.data.name });
    connection.data.viewerId = viewer.id;
    connections.set(viewer.id, connection);

    connection.send({
      type: 'welcome',
      you: { id: viewer.id, name: viewer.name, role: viewer.role },
      state: room.snapshot(),
      chat: room.chat,
      library: room.canBrowse(viewer) ? library.list() : [],
      capabilities: {
        ffmpeg: ffmpeg.ffmpeg,
        ffprobe: ffmpeg.ffprobe,
        encoder,
        hardwareEncoding: encoder !== 'libx264',
      },
    });
    broadcastPresence();

    connection.on('message', async (message) => {
      if (!message || typeof message.type !== 'string') return;
      const self = room.viewers.get(viewer.id);
      if (!self) return;
      self.lastSeen = Date.now();

      switch (message.type) {
        case 'ping':
          // Round-trip clock sync: the client works out its offset from t0/t1.
          connection.send({ type: 'pong', t0: message.t0, serverTime: Date.now() });
          break;

        case 'hello':
          room.rename(self.id, message.name);
          broadcastPresence();
          break;

        case 'control': {
          const result = room.applyControl(self, message);
          if (result.changed) {
            if (result.reason === 'select') {
              const item = await library.describe(room.mediaId);
              // A 4K remux is "original quality" nobody can receive; start the
              // room at something the link can actually carry.
              room.quality = suggestedQuality(item?.info);
              broadcast({ type: 'media', media: publicDescription(item) });
            }
            broadcastState();
          } else if (result.reason === 'not-allowed') {
            connection.send({ type: 'error', error: 'Only the host can control playback in this room.' });
          } else if (result.reason === 'not-allowed-browse') {
            connection.send({ type: 'error', error: 'Only the host can choose what plays.' });
          }
          break;
        }

        case 'report': {
          const result = room.report(self, message);
          if (result.changed) broadcastState();
          broadcastPresence();
          break;
        }

        case 'browsing': {
          if (room.setBrowsing(self, message.value)) broadcastPresence();
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
      const removed = room.removeViewer(viewer.id);
      if (removed) {
        broadcastPresence();
        // If we paused waiting for someone who then left, let the movie resume.
        if (room.waitingFor === null && room.paused) broadcastState();
      }

      // Once everyone has gone, put the room back to nothing playing, so the
      // next visit starts at the library rather than halfway through last
      // night's film. The delay is so a dropped connection does not do it.
      if (connections.size === 0 && resetWhenEmptyMs > 0) {
        clearTimeout(emptyRoomTimer);
        emptyRoomTimer = setTimeout(() => {
          if (connections.size === 0) room.clearPlayback();
        }, resetWhenEmptyMs);
        emptyRoomTimer.unref?.();
      }
    });
  });

  // Nudge everyone back into sync periodically; cheap insurance against drift
  // on connections that dropped a state message.
  const resync = setInterval(() => {
    if (connections.size > 0) broadcastState();
  }, 10_000);
  resync.unref?.();

  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    clearInterval(resync);
    clearInterval(hlsSweeper);
    clearTimeout(emptyRoomTimer);
    hls.stopAll();
    wss.close();
    return originalClose(callback);
  };

  server.library = library;
  server.room = room;
  server.capabilities = { ...ffmpeg, ...encoding, encoder };
  server.hls = hls;
  server.hlsKeyFor = sessionKey;
  return server;
}
