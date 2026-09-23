import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';

import {
  ATTR,
  METHOD,
  buildMessage,
  checkRelay,
  describeRelay,
  longTermKey,
  parseMessage,
  parseTurnUrl,
  readAddress,
  readError,
} from '../src/turn.js';

const REALM = 'movie.night';

// A TURN server small enough to read: it challenges the first Allocate, then
// checks the integrity hash on the second one, exactly as a real one would.
function fakeRelay({ username = 'user', password = 'secret', nonce = 'n0nce' } = {}) {
  const socket = dgram.createSocket('udp4');
  const seen = [];

  socket.on('message', (data, from) => {
    const request = parseMessage(data);
    seen.push(request);
    const reply = (type, attributes, key) =>
      socket.send(
        buildMessage({ type, transactionId: request.transactionId, attributes, key }),
        from.port,
        from.address
      );

    if (request.type === METHOD.BINDING_REQUEST) {
      const value = Buffer.alloc(8);
      value[1] = 0x01;
      value.writeUInt16BE(40000 ^ 0x2112, 2);
      // 198.51.100.7, XOR-ed with the magic cookie.
      Buffer.from([198, 51, 100, 7]).forEach((byte, i) => {
        value[4 + i] = byte ^ [0x21, 0x12, 0xa4, 0x42][i];
      });
      reply(METHOD.BINDING_SUCCESS, [[ATTR.XOR_MAPPED_ADDRESS, value]]);
      return;
    }

    if (request.type !== METHOD.ALLOCATE_REQUEST) return;

    const offered = request.attributes.get(ATTR.USERNAME);
    if (!offered) {
      const error = Buffer.from([0, 0, 4, 1, ...Buffer.from('Unauthorized')]);
      reply(METHOD.ALLOCATE_ERROR, [
        [ATTR.ERROR_CODE, error],
        [ATTR.REALM, Buffer.from(REALM)],
        [ATTR.NONCE, Buffer.from(nonce)],
      ]);
      return;
    }

    // Recompute the integrity hash over the request as it was signed: the
    // header, with its stated length, and everything up to the attribute.
    const integrity = request.attributes.get(ATTR.MESSAGE_INTEGRITY);
    const signed = data.subarray(0, data.length - 24);
    const key = longTermKey(username, REALM, password);
    const expected = crypto.createHmac('sha1', key).update(signed).digest();

    if (!integrity || !integrity.equals(expected) || offered.toString() !== username) {
      const error = Buffer.from([0, 0, 4, 1, ...Buffer.from('Wrong credentials')]);
      reply(METHOD.ALLOCATE_ERROR, [[ATTR.ERROR_CODE, error]]);
      return;
    }

    const relayed = Buffer.alloc(8);
    relayed[1] = 0x01;
    relayed.writeUInt16BE(59000 ^ 0x2112, 2);
    Buffer.from([203, 0, 113, 9]).forEach((byte, i) => {
      relayed[4 + i] = byte ^ [0x21, 0x12, 0xa4, 0x42][i];
    });
    reply(METHOD.ALLOCATE_SUCCESS, [[ATTR.XOR_RELAYED_ADDRESS, relayed]], key);
  });

  return {
    seen,
    async listen() {
      await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
      return socket.address().port;
    },
    close() {
      socket.close();
    },
  };
}

test('a relay address is read the way a browser reads it', () => {
  assert.deepEqual(parseTurnUrl('turn:relay.example.com:3478'), {
    scheme: 'turn', host: 'relay.example.com', port: 3478,
    transport: 'udp', secure: false, stunOnly: false,
  });

  // No port means the scheme's default, and turns: is TLS over TCP.
  assert.equal(parseTurnUrl('turn:relay.example.com').port, 3478);
  assert.equal(parseTurnUrl('turns:relay.example.com').port, 5349);
  assert.equal(parseTurnUrl('turns:relay.example.com').transport, 'tls');
  assert.equal(parseTurnUrl('turn:relay.example.com?transport=tcp').transport, 'tcp');

  // A bare host is a TURN address; stun: is recognised but needs no credentials.
  assert.equal(parseTurnUrl('relay.example.com').scheme, 'turn');
  assert.equal(parseTurnUrl('stun:stun.example.com:19302').stunOnly, true);

  // IPv6 literals keep their brackets out of the host.
  assert.deepEqual(
    { ...parseTurnUrl('turn:[2001:db8::1]:3478') },
    { scheme: 'turn', host: '2001:db8::1', port: 3478, transport: 'udp', secure: false, stunOnly: false }
  );

  assert.throws(() => parseTurnUrl('turn::3478'), /Not a relay address/);
  assert.throws(() => parseTurnUrl('turn:relay.example.com:0'), /Not a port number/);
});

test('a message survives a round trip through build and parse', () => {
  const transactionId = crypto.randomBytes(12);
  // A three-byte value forces a byte of padding, which the parser must skip.
  const message = buildMessage({
    type: METHOD.ALLOCATE_REQUEST,
    transactionId,
    attributes: [[ATTR.USERNAME, Buffer.from('abc')], [ATTR.REALM, Buffer.from('realm')]],
  });

  const parsed = parseMessage(message);
  assert.equal(parsed.type, METHOD.ALLOCATE_REQUEST);
  assert.ok(parsed.transactionId.equals(transactionId));
  assert.equal(parsed.attributes.get(ATTR.USERNAME).toString(), 'abc');
  assert.equal(parsed.attributes.get(ATTR.REALM).toString(), 'realm');
  assert.equal(parsed.total, message.length);
});

test('the integrity hash covers a length that counts itself', () => {
  const transactionId = crypto.randomBytes(12);
  const key = longTermKey('user', REALM, 'secret');
  const signed = buildMessage({
    type: METHOD.ALLOCATE_REQUEST,
    transactionId,
    key,
    attributes: [[ATTR.USERNAME, Buffer.from('user')]],
  });

  // The header's stated length includes the 24 bytes of MESSAGE-INTEGRITY,
  // so it matches the real message length once the attribute is appended.
  assert.equal(parseMessage(signed).length, signed.length - 20);

  const expected = crypto
    .createHmac('sha1', key)
    .update(signed.subarray(0, signed.length - 24))
    .digest();
  assert.ok(parseMessage(signed).attributes.get(ATTR.MESSAGE_INTEGRITY).equals(expected));
});

test('anything that is not a STUN message is rejected', () => {
  assert.equal(parseMessage(Buffer.alloc(4)), null, 'too short');
  assert.equal(parseMessage(Buffer.from('GET / HTTP/1.1\r\n\r\n....')), null, 'wrong cookie');

  // A truncated message is not half-parsed: it is refused until complete.
  const whole = buildMessage({
    type: METHOD.BINDING_REQUEST,
    transactionId: crypto.randomBytes(12),
    attributes: [[ATTR.SOFTWARE, Buffer.from('stream-room')]],
  });
  assert.equal(parseMessage(whole.subarray(0, whole.length - 2)), null);
  assert.ok(parseMessage(whole));
});

test('addresses are un-XOR-ed, and errors read as a code and a reason', () => {
  const value = Buffer.alloc(8);
  value[1] = 0x01;
  value.writeUInt16BE(40000 ^ 0x2112, 2);
  Buffer.from([198, 51, 100, 7]).forEach((byte, i) => {
    value[4 + i] = byte ^ [0x21, 0x12, 0xa4, 0x42][i];
  });
  assert.deepEqual(readAddress(value, Buffer.alloc(12)), {
    family: 'IPv4', address: '198.51.100.7', port: 40000,
  });

  // The plain MAPPED-ADDRESS form is not XOR-ed at all.
  const plain = Buffer.from([0, 1, 0x9c, 0x40, 10, 0, 0, 1]);
  assert.deepEqual(readAddress(plain, null, { xor: false }), {
    family: 'IPv4', address: '10.0.0.1', port: 40000,
  });

  assert.deepEqual(readError(Buffer.from([0, 0, 4, 1, ...Buffer.from('Unauthorized')])), {
    code: 401, reason: 'Unauthorized',
  });
});

test('a working relay reports the address media would come from', async (t) => {
  const relay = fakeRelay();
  const port = await relay.listen();
  t.after(() => relay.close());

  const result = await checkRelay({
    url: `turn:127.0.0.1:${port}`,
    username: 'user',
    password: 'secret',
  });

  assert.equal(result.ok, true);
  assert.equal(result.stage, 'allocate');
  assert.equal(result.realm, REALM);
  assert.deepEqual(result.relayed, { family: 'IPv4', address: '203.0.113.9', port: 59000 });
  assert.equal(result.mapped.address, '198.51.100.7');
  assert.match(describeRelay(result), /working\. Media would come from 203\.0\.113\.9/);

  // It really did the two-step dance rather than guessing at the realm.
  const allocates = relay.seen.filter((m) => m.type === METHOD.ALLOCATE_REQUEST);
  assert.equal(allocates.length, 2);
  assert.equal(allocates[0].attributes.has(ATTR.USERNAME), false);
  assert.equal(allocates[1].attributes.get(ATTR.NONCE).toString(), 'n0nce');
});

test('a wrong password is reported as a wrong password, not a timeout', async (t) => {
  const relay = fakeRelay({ password: 'secret' });
  const port = await relay.listen();
  t.after(() => relay.close());

  const result = await checkRelay({
    url: `turn:127.0.0.1:${port}`,
    username: 'user',
    password: 'not-the-password',
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'allocate');
  assert.equal(result.code, 401);
  assert.match(describeRelay(result), /username or password was refused/);
});

test('a relay nothing is listening on times out rather than hanging', async () => {
  // Port 1 on loopback: reserved, and nothing will ever answer there.
  const result = await checkRelay({ url: 'turn:127.0.0.1:1', username: 'u', password: 'p', timeoutMs: 300 });

  assert.equal(result.ok, false);
  assert.match(describeRelay(result), /firewall or a wrong port/);
});

test('a relay given no credentials says so instead of trying anyway', async (t) => {
  const relay = fakeRelay();
  const port = await relay.listen();
  t.after(() => relay.close());

  const result = await checkRelay({ url: `turn:127.0.0.1:${port}` });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'credentials');
  assert.match(describeRelay(result), /--turn-user and --turn-pass/);

  // A STUN address needs none, so the same server passes when asked that way.
  const stun = await checkRelay({ url: `stun:127.0.0.1:${port}` });
  assert.equal(stun.ok, true);
  assert.equal(stun.stage, 'binding');
  assert.equal(stun.mapped.address, '198.51.100.7');
});

test('a STUN-only server is not mistaken for a firewall', () => {
  // A server that answers a Binding but never challenges an Allocate is
  // reachable — it simply cannot pass media. That is a different problem from
  // nothing answering at all, and a different fix, so it reads differently.
  const described = describeRelay({
    ok: false,
    stage: 'challenge',
    scheme: 'turn',
    host: 'stun.example.com',
    port: 3478,
    error: 'the relay did not ask for credentials',
  });

  assert.match(described, /not like a TURN relay/);
  assert.doesNotMatch(described, /firewall/, 'it answered, so a firewall is the wrong advice');
});

test('a relay that cannot be reached says why, in the words that lead to the fix', () => {
  const base = { ok: false, stage: 'exchange', scheme: 'turn', host: 'relay.example.com', port: 3478 };

  // Each of these sends somebody somewhere different, so none of them should
  // be described as the generic "a firewall, probably".
  assert.match(
    describeRelay({ ...base, error: 'getaddrinfo ENOTFOUND relay.example.com' }),
    /does not resolve/
  );
  assert.match(
    describeRelay({ ...base, error: 'connect ECONNREFUSED 203.0.113.9:3478' }),
    /nothing is listening on that port/
  );
  assert.match(describeRelay({ ...base, error: 'no answer from the relay' }), /firewall/);
});
