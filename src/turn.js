// A small STUN/TURN client, used to check a relay from the command line.
//
// The browser will happily accept a TURN server that does not work: a wrong
// password, a blocked port and a perfectly good relay all look identical until
// the moment the picture is supposed to appear. So before the evening, ask the
// relay for an allocation the same way a browser would, and see what it says.
//
// RFC 5389 for the message format, RFC 5766 for Allocate and the long-term
// credentials.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';

const MAGIC_COOKIE = 0x2112a442;
const HEADER_BYTES = 20;

export const METHOD = {
  BINDING_REQUEST: 0x0001,
  BINDING_SUCCESS: 0x0101,
  BINDING_ERROR: 0x0111,
  ALLOCATE_REQUEST: 0x0003,
  ALLOCATE_SUCCESS: 0x0103,
  ALLOCATE_ERROR: 0x0113,
};

export const ATTR = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
  LIFETIME: 0x000d,
  SOFTWARE: 0x8022,
};

const UDP_TRANSPORT = 17;

// turn:relay.example.com:3478?transport=tcp, turns:relay.example.com:5349, or
// just a bare host. Default ports follow RFC 5766 s6.1: 3478 plain, 5349 TLS.
export function parseTurnUrl(url) {
  const text = String(url ?? '').trim();
  const match = /^(?:(turns?|stuns?):)?([^?]*)(?:\?(.*))?$/i.exec(text);
  if (!match) throw new Error(`Not a relay address: ${url}`);

  const scheme = (match[1] ?? 'turn').toLowerCase();
  const secure = scheme === 'turns' || scheme === 'stuns';
  const authority = match[2];

  // IPv6 literals are bracketed; everything else splits on the last colon.
  let host;
  let port;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] ? Number(bracketed[2]) : null;
  } else {
    const colon = authority.lastIndexOf(':');
    host = colon === -1 ? authority : authority.slice(0, colon);
    port = colon === -1 ? null : Number(authority.slice(colon + 1));
  }
  if (!host) throw new Error(`Not a relay address: ${url}`);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`Not a port number: ${url}`);
  }

  const params = new URLSearchParams(match[3] ?? '');
  const asked = (params.get('transport') ?? '').toLowerCase();
  // turns: is TLS over TCP; ?transport= only distinguishes the two plain ones.
  const transport = secure ? 'tls' : asked === 'tcp' ? 'tcp' : 'udp';

  return {
    scheme,
    host,
    port: port ?? (secure ? 5349 : 3478),
    transport,
    secure,
    stunOnly: scheme === 'stun' || scheme === 'stuns',
  };
}

function padding(length) {
  return (4 - (length % 4)) % 4;
}

export function buildMessage({ type, transactionId, attributes = [], key = null }) {
  const parts = [];
  for (const [attrType, rawValue] of attributes) {
    const value = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(String(rawValue), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt16BE(attrType, 0);
    head.writeUInt16BE(value.length, 2);
    parts.push(head, value, Buffer.alloc(padding(value.length)));
  }
  const body = Buffer.concat(parts);

  // The integrity hash covers a header whose length already counts the
  // 24 bytes the MESSAGE-INTEGRITY attribute is about to occupy.
  const declared = body.length + (key ? 24 : 0);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(declared, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);

  if (!key) return Buffer.concat([header, body]);

  const digest = crypto.createHmac('sha1', key).update(Buffer.concat([header, body])).digest();
  const attr = Buffer.alloc(4);
  attr.writeUInt16BE(ATTR.MESSAGE_INTEGRITY, 0);
  attr.writeUInt16BE(digest.length, 2);
  return Buffer.concat([header, body, attr, digest]);
}

export function parseMessage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES) return null;
  // The top two bits of a STUN message are always zero.
  if ((buffer[0] & 0xc0) !== 0) return null;
  if (buffer.readUInt32BE(4) !== MAGIC_COOKIE) return null;

  const length = buffer.readUInt16BE(2);
  if (buffer.length < HEADER_BYTES + length) return null;

  const attributes = new Map();
  let offset = HEADER_BYTES;
  const end = HEADER_BYTES + length;
  while (offset + 4 <= end) {
    const type = buffer.readUInt16BE(offset);
    const size = buffer.readUInt16BE(offset + 2);
    const start = offset + 4;
    if (start + size > end) break;
    // A repeated attribute means the first one, per RFC 5389 s15.
    if (!attributes.has(type)) attributes.set(type, buffer.subarray(start, start + size));
    offset = start + size + padding(size);
  }

  return {
    type: buffer.readUInt16BE(0),
    length,
    transactionId: buffer.subarray(8, 20),
    attributes,
    total: HEADER_BYTES + length,
  };
}

// Both address forms, XOR-ed and not. The XOR exists so that a NAT rewriting
// payloads cannot recognise — and helpfully mangle — an address in flight.
export function readAddress(value, transactionId, { xor = true } = {}) {
  if (!value || value.length < 8) return null;
  const family = value[1];
  let port = value.readUInt16BE(2);
  const raw = Buffer.from(value.subarray(4));

  if (xor) {
    port ^= MAGIC_COOKIE >>> 16;
    const mask = Buffer.alloc(16);
    mask.writeUInt32BE(MAGIC_COOKIE, 0);
    if (transactionId) transactionId.copy(mask, 4);
    for (let i = 0; i < raw.length; i++) raw[i] ^= mask[i];
  }

  if (family === 0x01 && raw.length >= 4) {
    return { family: 'IPv4', address: Array.from(raw.subarray(0, 4)).join('.'), port };
  }
  if (family === 0x02 && raw.length >= 16) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(raw.readUInt16BE(i).toString(16));
    return { family: 'IPv6', address: groups.join(':'), port };
  }
  return null;
}

export function readError(value) {
  if (!value || value.length < 4) return null;
  const code = (value[2] & 0x07) * 100 + value[3];
  return { code, reason: value.subarray(4).toString('utf8') };
}

// RFC 5766 s4: MD5 of the credentials, not because MD5 is a good choice in
// 2026 but because it is the one every TURN server implements.
export function longTermKey(username, realm, password) {
  return crypto.createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
}

function udpTransport({ host, port, timeoutMs }) {
  const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
  let pending = null;

  socket.on('message', (data) => {
    const parsed = parseMessage(data);
    if (parsed) pending?.settle(null, parsed);
  });
  socket.on('error', (error) => pending?.settle(error));

  return {
    async request(message) {
      return new Promise((resolve, reject) => {
        // UDP loses packets, so the RFC says retransmit. Every timer is
        // cancelled the moment the exchange settles: one that outlived the
        // socket would fire into a closed handle.
        const timers = [0, 500, 1500].map((delay) =>
          setTimeout(() => socket.send(message, port, host, (error) => error && settle(error)), delay)
        );
        timers.push(setTimeout(() => settle(new Error('no answer from the relay')), timeoutMs));

        function settle(error, value) {
          if (!pending) return;
          pending = null;
          for (const timer of timers) clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        }

        pending = { settle };
      });
    },
    close() {
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}

function streamTransport({ host, port, timeoutMs, secure }) {
  let buffer = Buffer.alloc(0);
  let pending = null;
  let failure = null;

  const socket = secure
    ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
    : net.connect({ host, port });
  socket.setTimeout(timeoutMs);

  const fail = (error) => {
    failure = error;
    pending?.reject(error);
    pending = null;
  };
  socket.on('error', fail);
  socket.on('timeout', () => fail(new Error('no answer from the relay')));
  socket.on('close', () => fail(new Error('the relay closed the connection')));
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const parsed = parseMessage(buffer);
    if (!parsed) return;
    buffer = buffer.subarray(parsed.total);
    const waiter = pending;
    pending = null;
    waiter?.resolve(parsed);
  });

  const ready = new Promise((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });
  // request() awaits this, but if the caller never gets that far a connection
  // error would reject with nobody listening, which takes the process down.
  ready.catch(() => {});

  return {
    async request(message) {
      if (failure) throw failure;
      await ready;
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        socket.write(message);
      });
    },
    close() {
      socket.destroy();
    },
  };
}

function openTransport(target, timeoutMs) {
  if (target.transport === 'udp') return udpTransport({ ...target, timeoutMs });
  return streamTransport({ ...target, timeoutMs, secure: target.transport === 'tls' });
}

/**
 * Ask a relay for an allocation, exactly as a browser would before it can pass
 * media through it. Resolves with what happened rather than throwing, because
 * every outcome here is a result worth printing.
 */
export async function checkRelay({
  url,
  username = null,
  password = null,
  timeoutMs = 5000,
  lifetime = 600,
  now = () => Date.now(),
} = {}) {
  let target;
  try {
    target = parseTurnUrl(url);
  } catch (error) {
    return { ok: false, url, stage: 'address', error: error.message };
  }

  const started = now();
  const outcome = (fields) => ({ url, ...target, roundTripMs: now() - started, ...fields });

  let transport;
  try {
    transport = openTransport(target, timeoutMs);
  } catch (error) {
    return outcome({ ok: false, stage: 'connect', error: error.message });
  }

  try {
    const transactionId = crypto.randomBytes(12);
    const software = ['stream-room', 'utf8'];

    // A bare Binding first: it proves the host resolves and the port answers,
    // and separates "unreachable" from "reachable but refused you".
    const binding = await transport.request(
      buildMessage({
        type: METHOD.BINDING_REQUEST,
        transactionId,
        attributes: [[ATTR.SOFTWARE, Buffer.from(software[0], software[1])]],
      })
    );
    const mapped =
      readAddress(binding.attributes.get(ATTR.XOR_MAPPED_ADDRESS), binding.transactionId) ??
      readAddress(binding.attributes.get(ATTR.MAPPED_ADDRESS), null, { xor: false });

    if (target.stunOnly) {
      return outcome({ ok: true, stage: 'binding', mapped, relayed: null });
    }
    if (!username || !password) {
      return outcome({
        ok: false,
        stage: 'credentials',
        mapped,
        error: 'a relay needs a username and password',
      });
    }

    // Unauthenticated Allocate, purely to be told the realm and nonce.
    const probeId = crypto.randomBytes(12);
    const challenge = await transport.request(
      buildMessage({
        type: METHOD.ALLOCATE_REQUEST,
        transactionId: probeId,
        attributes: [[ATTR.REQUESTED_TRANSPORT, Buffer.from([UDP_TRANSPORT, 0, 0, 0])]],
      })
    );

    const realm = challenge.attributes.get(ATTR.REALM);
    const nonce = challenge.attributes.get(ATTR.NONCE);
    if (!realm || !nonce) {
      const failed = readError(challenge.attributes.get(ATTR.ERROR_CODE));
      return outcome({
        ok: false,
        stage: 'challenge',
        mapped,
        code: failed?.code ?? null,
        error: failed?.reason ?? 'the relay did not ask for credentials',
      });
    }

    const lifetimeValue = Buffer.alloc(4);
    lifetimeValue.writeUInt32BE(lifetime, 0);
    const key = longTermKey(username, realm.toString('utf8'), password);
    const allocateId = crypto.randomBytes(12);
    const allocated = await transport.request(
      buildMessage({
        type: METHOD.ALLOCATE_REQUEST,
        transactionId: allocateId,
        key,
        attributes: [
          [ATTR.REQUESTED_TRANSPORT, Buffer.from([UDP_TRANSPORT, 0, 0, 0])],
          [ATTR.LIFETIME, lifetimeValue],
          [ATTR.USERNAME, Buffer.from(username, 'utf8')],
          [ATTR.REALM, realm],
          [ATTR.NONCE, nonce],
        ],
      })
    );

    if (allocated.type === METHOD.ALLOCATE_ERROR) {
      const failed = readError(allocated.attributes.get(ATTR.ERROR_CODE));
      return outcome({
        ok: false,
        stage: 'allocate',
        mapped,
        realm: realm.toString('utf8'),
        code: failed?.code ?? null,
        error: failed?.reason ?? 'the relay refused the allocation',
      });
    }

    return outcome({
      ok: true,
      stage: 'allocate',
      mapped,
      realm: realm.toString('utf8'),
      relayed: readAddress(
        allocated.attributes.get(ATTR.XOR_RELAYED_ADDRESS),
        allocated.transactionId
      ),
    });
  } catch (error) {
    return outcome({ ok: false, stage: 'exchange', error: error.message });
  } finally {
    transport.close();
  }
}

// One line per relay, written for somebody deciding whether to trust it.
export function describeRelay(result) {
  const where = `${result.scheme ?? 'turn'}:${result.host ?? '?'}:${result.port ?? '?'}` +
    (result.transport && result.transport !== 'udp' ? ` (${result.transport})` : '');

  if (result.ok && result.stage === 'allocate') {
    return `${where} — working. Media would come from ${result.relayed?.address ?? 'the relay'}` +
      ` (${result.roundTripMs}ms away).`;
  }
  if (result.ok) return `${where} — reachable, ${result.roundTripMs}ms away.`;

  switch (result.stage) {
    case 'address':
      return `${where} — ${result.error}`;
    case 'credentials':
      return `${where} — ${result.error}. Pass --turn-user and --turn-pass.`;
    case 'allocate':
      return result.code === 401 || result.code === 403
        ? `${where} — the username or password was refused (${result.code}).`
        : `${where} — refused the allocation: ${result.error}` +
          (result.code ? ` (${result.code})` : '');
    case 'challenge':
      // It answered, so it is reachable; it just did not behave like a relay.
      return `${where} — answered, but not like a TURN relay: ${result.error}.` +
        ' A STUN-only server cannot pass media through.';
    default:
      return `${where} — ${result.error}. Nothing answered, so a firewall or a` +
        ' wrong port is the usual cause.';
  }
}
