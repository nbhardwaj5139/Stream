import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Library, publicDescription, mimeForFile, detectFfmpeg } from './media.js';
import { readSubtitleAsVtt, extractEmbeddedSubtitle } from './subtitles.js';
import { startTranscode } from './transcode.js';
import { Room } from './room.js';
import { attachWebSocketServer } from './ws.js';
import { createAuthenticator, generateToken } from './auth.js';
import { parseRange } from './range.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE_NAME = 'stream_key';

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
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

export async function createServer(options = {}) {
  const {
    roots = [process.cwd()],
    hostKey = generateToken(),
    guestKey = generateToken(),
    controlMode = 'everyone',
    autoPauseOnBuffer = true,
    allowTranscode = true,
  } = options;

  const library = new Library(roots);
  await library.scan();

  const room = new Room({ controlMode, autoPauseOnBuffer });
  const authenticate = createAuthenticator({ hostKey, guestKey, cookieName: COOKIE_NAME });
  const ffmpeg = await detectFfmpeg();

  const connections = new Map(); // viewerId -> WebSocketConnection

  function broadcast(message, { except } = {}) {
    for (const [id, connection] of connections) {
      if (except && id === except) continue;
      connection.send(message);
    }
  }

  function broadcastState() {
    broadcast(room.snapshot());
  }

  function broadcastPresence() {
    broadcast(room.presence());
  }

  // ---------------------------------------------------------------- HTTP ---

  async function serveStatic(req, res, name) {
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
    res.writeHead(200, {
      'content-type': STATIC_TYPES[path.extname(safeName).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
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
      res.writeHead(416, {
        'content-range': `bytes */${stat.size}`,
        'content-type': 'text/plain',
      });
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

  function serveTranscode(req, res, item, url) {
    if (!allowTranscode || !ffmpeg.ffmpeg) {
      sendText(res, 503, 'This file needs ffmpeg, which was not found on the host machine.');
      return;
    }

    const startSeconds = Math.max(0, Number(url.searchParams.get('start')) || 0);
    const audioTrack = Math.max(0, Number(url.searchParams.get('track')) || 0);
    const quality = url.searchParams.get('quality') ?? 'medium';
    const maxHeightParam = Number(url.searchParams.get('maxHeight'));
    const maxHeight = Number.isFinite(maxHeightParam) && maxHeightParam > 0 ? maxHeightParam : null;

    res.writeHead(200, {
      'content-type': 'video/mp4',
      'cache-control': 'no-store',
      // Length is unknown while ffmpeg is still running; no seeking by range.
      'accept-ranges': 'none',
      'x-stream-start': String(startSeconds),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const job = startTranscode({
      filePath: item.path,
      startSeconds,
      info: item.info,
      audioTrack,
      quality: quality === 'original' ? 'high' : quality,
      maxHeight,
    });

    job.stdout.pipe(res);
    job.stdout.on('error', () => job.stop());
    job.process.on('close', (code) => {
      if (code && code !== 0 && !res.writableEnded) {
        process.stderr.write(`ffmpeg exited ${code}: ${job.getStderr()}\n`);
      }
      if (!res.writableEnded) res.end();
    });
    // Browser closed the tab or seeked: stop burning CPU immediately.
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

    // Static assets carry no secrets and the sign-in page needs them.
    if (pathname.startsWith('/static/')) {
      await serveStatic(req, res, pathname.slice('/static/'.length));
      return;
    }
    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, files: library.items.size });
      return;
    }

    const identity = authenticate(req, url);

    if (pathname === '/' || pathname === '/index.html') {
      if (!identity) {
        await serveStatic(req, res, 'locked.html');
        return;
      }
      // Remember the key so <video src> and reloads don't need it in the URL.
      res.setHeader(
        'set-cookie',
        `${COOKIE_NAME}=${encodeURIComponent(identity.key)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`
      );
      await serveStatic(req, res, 'index.html');
      return;
    }

    if (!identity) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (pathname === '/api/session') {
      sendJson(res, 200, {
        role: identity.role,
        controlMode: room.controlMode,
        ffmpeg: ffmpeg.ffmpeg,
        ffprobe: ffmpeg.ffprobe,
        roots: identity.role === 'host' ? library.roots : undefined,
        guestLinkKey: identity.role === 'host' ? guestKey : undefined,
      });
      return;
    }

    if (pathname === '/api/library') {
      sendJson(res, 200, { items: library.list(), scannedAt: library.scannedAt });
      return;
    }

    if (pathname === '/api/rescan' && req.method === 'POST') {
      if (identity.role !== 'host') {
        sendJson(res, 403, { error: 'host only' });
        return;
      }
      await library.scan();
      sendJson(res, 200, { items: library.list(), scannedAt: library.scannedAt });
      return;
    }

    const mediaMatch = /^\/api\/media\/([a-f0-9]{16})$/.exec(pathname);
    if (mediaMatch) {
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
      const item = await library.describe(transcodeMatch[1]);
      if (!item) {
        sendText(res, 404, 'Not found');
        return;
      }
      serveTranscode(req, res, item, url);
      return;
    }

    const subtitleMatch = /^\/subtitles\/([a-f0-9]{16})\/([a-z]+:\d+)\.vtt$/.exec(pathname);
    if (subtitleMatch) {
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
    authorize: (req, url) => {
      const identity = authenticate(req, url);
      return identity ? { role: identity.role } : false;
    },
  });

  wss.on('connection', (connection) => {
    const viewer = room.addViewer({ role: connection.data.role });
    connection.data.viewerId = viewer.id;
    connections.set(viewer.id, connection);

    connection.send({
      type: 'welcome',
      you: { id: viewer.id, name: viewer.name, role: viewer.role },
      state: room.snapshot(),
      chat: room.chat,
      library: library.list(),
      capabilities: { ffmpeg: ffmpeg.ffmpeg, ffprobe: ffmpeg.ffprobe },
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
            broadcastState();
            if (result.reason === 'select') {
              const item = await library.describe(room.mediaId);
              broadcast({ type: 'media', media: publicDescription(item) });
            }
          } else if (result.reason === 'not-allowed') {
            connection.send({ type: 'error', error: 'Only the host can control playback in this room.' });
          }
          break;
        }

        case 'report': {
          const result = room.report(self, message);
          if (result.changed) broadcastState();
          broadcastPresence();
          break;
        }

        case 'chat': {
          const entry = room.addChat(self, message.text);
          if (entry) broadcast({ type: 'chat', entry });
          break;
        }

        case 'signal': {
          // WebRTC offer/answer/ICE relay for screen-share mode.
          const target = connections.get(message.to);
          if (target) {
            target.send({ type: 'signal', from: self.id, data: message.data });
          }
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
    wss.close();
    return originalClose(callback);
  };

  server.library = library;
  server.room = room;
  server.keys = { hostKey, guestKey };
  server.capabilities = ffmpeg;
  return server;
}
