/**
 * Cookies, kept tiny: one session cookie, HttpOnly, SameSite=Lax, Secure
 * whenever the request arrived over https (so a localhost preview still works).
 * `Secure` on an http origin would be silently dropped by the browser, which
 * looks exactly like a broken login.
 */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      out[name] = part.slice(at + 1).trim();
    }
  }
  return out;
}

export function cookieValue(request, name) {
  return parseCookies(request?.headers?.get?.('cookie'))[name] || '';
}

export function sessionCookie(name, value, { maxAge, secure = true } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge != null) bits.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie(name, { secure = true } = {}) {
  return sessionCookie(name, '', { maxAge: 0, secure });
}

/** Bearer first, then the cookie: the CLI needs no browser to prove a session. */
export function tokenFrom(request, cookieName) {
  const header = String(request?.headers?.get?.('authorization') || '');
  const bearer = header.replace(/^Bearer\s+/i, '').trim();
  if (bearer && bearer !== header) return bearer;
  return cookieValue(request, cookieName);
}
