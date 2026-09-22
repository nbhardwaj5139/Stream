// Room access: a passcode she types, exchanged for a signed session cookie.
// No secrets in the URL, so the link is safe to paste anywhere.
import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
// Crockford-ish alphabet: no O/0, I/1/L, U. Easy to text, easy to type on a tablet.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export function generateToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function generatePasscode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  // Rejection-free because the alphabet divides evenly enough for our purposes;
  // the tiny modulo bias here is irrelevant against a rate-limited endpoint.
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// Passcodes are short by design, so hash them slowly and rate limit hard.
export function hashPasscode(passcode, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(passcode.normalize('NFKC'), salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return { salt, hash: derived };
}

export function verifyPasscode(passcode, record) {
  if (!record || typeof passcode !== 'string' || passcode.length === 0) return false;
  if (passcode.length > 256) return false;
  const derived = crypto.scryptSync(
    passcode.normalize('NFKC'),
    record.salt,
    SCRYPT_PARAMS.keylen,
    SCRYPT_PARAMS
  );
  return crypto.timingSafeEqual(derived, record.hash);
}

export function parseCookies(header) {
  const jar = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      jar[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      jar[key] = part.slice(index + 1).trim();
    }
  }
  return jar;
}

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function signSession(secret, payload) {
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${signature}`;
}

export function verifySession(secret, token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  if (!safeEqual(signature, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) return null;
  if (payload.role !== 'host' && payload.role !== 'guest') return null;
  return payload;
}

// Slows down anyone who found the tunnel URL and is guessing at the passcode.
// Tracked per client address, with a global ceiling so a botnet can't spread
// the guessing across many addresses either.
export class AttemptLimiter {
  constructor({
    maxPerClient = 5,
    maxGlobal = 40,
    windowMs = 10 * 60_000,
    lockoutMs = 15 * 60_000,
    clock = () => Date.now(),
  } = {}) {
    this.maxPerClient = maxPerClient;
    this.maxGlobal = maxGlobal;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;
    this.clock = clock;
    this.clients = new Map();
    this.global = [];
  }

  _prune(now) {
    const cutoff = now - this.windowMs;
    this.global = this.global.filter((at) => at > cutoff);
    for (const [key, record] of this.clients) {
      if (record.lockedUntil > now) continue;
      record.failures = record.failures.filter((at) => at > cutoff);
      if (record.failures.length === 0) this.clients.delete(key);
    }
  }

  check(key) {
    const now = this.clock();
    this._prune(now);

    const record = this.clients.get(key);
    if (record?.lockedUntil > now) {
      return { allowed: false, retryAfterMs: record.lockedUntil - now, scope: 'client' };
    }
    if (this.global.length >= this.maxGlobal) {
      return { allowed: false, retryAfterMs: this.windowMs, scope: 'global' };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  fail(key) {
    const now = this.clock();
    this._prune(now);

    const record = this.clients.get(key) ?? { failures: [], lockedUntil: 0 };
    record.failures.push(now);
    if (record.failures.length >= this.maxPerClient) {
      record.lockedUntil = now + this.lockoutMs;
      record.failures = [];
    }
    this.clients.set(key, record);
    this.global.push(now);
  }

  succeed(key) {
    this.clients.delete(key);
  }
}

// Behind a tunnel every request arrives from 127.0.0.1, which would collapse
// the per-client rate limit into a single shared bucket. Cloudflare puts the
// real visitor in CF-Connecting-IP; fall back to X-Forwarded-For, then to the
// socket for a plain LAN connection.
export function clientAddress(req) {
  const cloudflare = req.headers['cf-connecting-ip'];
  if (typeof cloudflare === 'string' && cloudflare.length) return cloudflare.trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
