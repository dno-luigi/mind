const encoder = new TextEncoder();

export const has = (env, key) => Boolean(env && env[key]);

export function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...(init.headers || {}),
    },
  });
}

export function fail(status, code, message, extra = {}) {
  return json({ error: { code, message, ...extra } }, { status });
}

export function options() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400',
    },
  });
}

/** base64 without blowing the argument limit on multi-megabyte audio. */
export function b64FromBytes(bytes) {
  let binary = '';
  const SLICE = 0x8000;
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

export function bytesFromB64(b64) {
  const binary = atob(String(b64 || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'anon'
  );
}

export const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * Compare a presented key with the configured one without leaking where they
 * diverge. Length is compared up front, which only reveals a length.
 */
export function keyMatches(expected, provided) {
  const a = String(expected || '');
  const b = String(provided || '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
