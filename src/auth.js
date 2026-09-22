import crypto from 'node:crypto';

export function generateToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
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

// Works out whether a request is the host, a guest, or nobody.
export function createAuthenticator({ hostKey, guestKey, cookieName = 'stream_key' }) {
  return function authenticate(req, url) {
    const fromQuery = url?.searchParams?.get('k');
    const fromHeader = req.headers['x-stream-key'];
    const fromCookie = parseCookies(req.headers.cookie)[cookieName];

    for (const candidate of [fromQuery, fromHeader, fromCookie]) {
      if (typeof candidate !== 'string' || !candidate) continue;
      if (safeEqual(candidate, hostKey)) return { role: 'host', key: candidate };
      if (safeEqual(candidate, guestKey)) return { role: 'guest', key: candidate };
    }
    return null;
  };
}
