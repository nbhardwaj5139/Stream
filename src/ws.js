// Minimal RFC 6455 WebSocket server. Zero dependencies so the whole app is
// `node bin/stream.js` with nothing to install on movie night.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20; // 1 MiB; we only ever send small JSON

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.open = true;
    // Tracked separately from `open`: sending a close frame clears `open`
    // immediately, and the teardown still has to run after that.
    this.closed = false;
    this.isAlive = true;
    this.data = {}; // room bookkeeping hangs off here

    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;
    this._fragmentSize = 0;

    // A browser tab that is killed resets the socket, and an unheard 'error'
    // on an EventEmitter throws. A dropped viewer must never take the server
    // down mid-movie, so guarantee there is always a listener.
    this.on('error', () => {});

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._teardown());
    socket.on('error', (err) => {
      this.emit('error', err);
      this._teardown();
    });
  }

  send(value) {
    if (!this.open) return false;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    try {
      this.socket.write(encodeFrame(OP.TEXT, Buffer.from(text, 'utf8')));
      return true;
    } catch {
      this._teardown();
      return false;
    }
  }

  ping() {
    if (!this.open) return;
    try {
      this.socket.write(encodeFrame(OP.PING, Buffer.alloc(0)));
    } catch {
      this._teardown();
    }
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(OP.CLOSE, body));
    } catch {
      /* socket already gone */
    }
    this.open = false;
    this.socket.end();
  }

  _teardown() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
  }

  _fail(code, message) {
    this.close(code, message);
    this.socket.destroy();
    this._teardown();
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (this.open) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  // Returns a parsed frame, or null when more bytes are needed.
  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const rsv = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      this._fail(1002, 'RSV bits must be zero');
      return null;
    }
    // Clients must mask; unmasked client frames are a protocol error.
    if (!masked) {
      this._fail(1002, 'client frames must be masked');
      return null;
    }

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE)) {
        this._fail(1009, 'message too large');
        return null;
      }
      len = Number(big);
      offset += 8;
    }

    const isControl = (opcode & 0x8) !== 0;
    if (isControl && (len > 125 || !fin)) {
      this._fail(1002, 'invalid control frame');
      return null;
    }
    if (len > MAX_MESSAGE) {
      this._fail(1009, 'message too large');
      return null;
    }

    if (buf.length < offset + 4 + len) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    offset += len;

    this._buf = buf.subarray(offset);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.PING:
        if (this.open) this.socket.write(encodeFrame(OP.PONG, payload));
        return;
      case OP.PONG:
        this.isAlive = true;
        return;
      case OP.CLOSE:
        this.close(1000, '');
        this._teardown();
        return;
      case OP.BINARY:
        // We never expect binary; drop it rather than buffering junk.
        return;
      case OP.TEXT:
      case OP.CONT:
        break;
      default:
        this._fail(1002, 'unknown opcode');
        return;
    }

    if (opcode === OP.TEXT) {
      if (this._fragmentOpcode !== null) {
        this._fail(1002, 'interleaved message');
        return;
      }
      if (fin) {
        this._deliver(payload);
        return;
      }
      this._fragmentOpcode = OP.TEXT;
      this._fragments = [payload];
      this._fragmentSize = payload.length;
      return;
    }

    // continuation
    if (this._fragmentOpcode === null) {
      this._fail(1002, 'continuation without start');
      return;
    }
    this._fragmentSize += payload.length;
    if (this._fragmentSize > MAX_MESSAGE) {
      this._fail(1009, 'message too large');
      return;
    }
    this._fragments.push(payload);
    if (!fin) return;

    const full = Buffer.concat(this._fragments, this._fragmentSize);
    this._fragments = [];
    this._fragmentOpcode = null;
    this._fragmentSize = 0;
    this._deliver(full);
  }

  _deliver(payload) {
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      return; // ignore malformed input rather than dropping the connection
    }
    this.emit('message', message);
  }
}

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// Attach to an http.Server. `authorize(req)` may return false to reject.
export function attachWebSocketServer(server, { path = '/ws', authorize } = {}) {
  const emitter = new EventEmitter();
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    let context = {};
    if (authorize) {
      const result = authorize(req, url);
      if (!result) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (typeof result === 'object') context = result;
    }

    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );

    const connection = new WebSocketConnection(socket, req);
    Object.assign(connection.data, context);
    if (head?.length) connection._onData(head);

    clients.add(connection);
    connection.on('close', () => clients.delete(connection));
    emitter.emit('connection', connection, url);
  });

  // Drop connections that stop answering pings (laptop lid closed, etc).
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.close(1001, 'timeout');
        client.socket.destroy();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  emitter.clients = clients;
  emitter.close = () => {
    clearInterval(heartbeat);
    for (const client of clients) client.close(1001, 'server shutting down');
  };
  return emitter;
}
