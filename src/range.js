// RFC 7233 single-range parsing, enough for what <video> asks for.
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { invalid: true };

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { invalid: true };

  let start;
  let end;

  if (rawStart === '') {
    // Suffix range: last N bytes.
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    if (end >= size) end = size - 1;
  }

  if (size === 0) return { invalid: true };
  if (start > end || start >= size) return { invalid: true };
  return { start, end, length: end - start + 1 };
}
