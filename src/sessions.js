/**
 * Login state, in a Durable Object.
 *
 * A Durable Object is the piece a Worker cannot do alone: one single-threaded
 * home per user, with storage that survives isolates and reads-after-writes.
 * One object per user name, so a session can be revoked for one account without
 * touching anybody else's, and two logins for the same name cannot race.
 *
 * The password is not per-user — it is the deployment's shared LOGIN_PASSWORD
 * secret, compared in constant time in `index.js`. The name is what the object
 * namespaces; adding real per-user passwords later means adding a member record
 * here and changing only the check, not the session plumbing.
 */

export const SESSION_COOKIE = 'mind_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const sessionsBinding = (env) => env?.SESSIONS || null;

export function sessionsFor(env, user) {
  const namespace = sessionsBinding(env);
  if (!namespace || typeof namespace.idFromName !== 'function') return null;
  return namespace.get(namespace.idFromName(String(user || '').trim().toLowerCase()));
}

/** base64url of the user name, then the random part: the token names its home. */
export function makeToken(user) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const random = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const name = btoa(encodeURIComponent(String(user || '').trim().toLowerCase()))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${name}.${random}`;
}

export function tokenUser(token) {
  const encoded = String(token || '').split('.')[0];
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return decodeURIComponent(atob(padded));
  } catch {
    return null;
  }
}

async function call(stub, path, body) {
  const init =
    body === undefined
      ? { method: 'GET' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  const res = await stub.fetch(`https://sessions${path}`, init);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function openSession(env, user, { ttl = SESSION_TTL_MS } = {}) {
  const stub = sessionsFor(env, user);
  if (!stub) return null;
  const token = makeToken(user);
  const out = await call(stub, '/login', { token, ttl });
  return out.ok ? out.data : null;
}

export async function readSession(env, token) {
  const user = tokenUser(token);
  if (!user) return null;
  const stub = sessionsFor(env, user);
  if (!stub) return null;
  const out = await call(stub, '/read', { token });
  return out.ok ? out.data : null;
}

export async function closeSession(env, token) {
  const user = tokenUser(token);
  if (!user) return null;
  const stub = sessionsFor(env, user);
  if (!stub) return null;
  const out = await call(stub, '/logout', { token });
  return out.ok;
}

const sessionKey = (token) => `session:${token}`;

export class Sessions {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /** Expired sessions are pruned on write, so an idle account costs nothing. */
  async prune(now) {
    const all = await this.state.storage.list({ prefix: 'session:' });
    for (const [key, value] of all) {
      if (!value || !value.expiresAt || value.expiresAt <= now) {
        await this.state.storage.delete(key);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const token = String(body.token || '').trim();

    if (url.pathname === '/login') {
      if (!token) return jsonError(400, 'token_required');
      const now = Date.now();
      const ttl = Math.min(Math.max(Number(body.ttl) || SESSION_TTL_MS, 60000), MAX_TTL_MS);
      const expiresAt = now + ttl;
      await this.prune(now);
      await this.state.storage.put(sessionKey(token), { createdAt: now, expiresAt });
      return jsonOk({ token, expiresAt });
    }

    if (url.pathname === '/read') {
      const record = token ? await this.state.storage.get(sessionKey(token)) : null;
      if (!record || !record.expiresAt || record.expiresAt <= Date.now()) {
        if (token) await this.state.storage.delete(sessionKey(token));
        return jsonError(401, 'no_session');
      }
      return jsonOk({ expiresAt: record.expiresAt, createdAt: record.createdAt });
    }

    if (url.pathname === '/logout') {
      if (token) await this.state.storage.delete(sessionKey(token));
      return jsonOk({ ok: true });
    }

    return jsonError(404, 'not_found');
  }
}

function jsonOk(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function jsonError(status, code) {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
