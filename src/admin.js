import { keyMatches } from './util.js';
import { stateKv, masterKv } from './bindings.js';
import { listCandidates, PROMOTE_AT } from './truth.js';

/**
 * The console is a read-and-curate surface, not a chat route: it lists what is
 * already stored so a pair can be found without remembering its key. Every
 * response here needs ADMIN_KEY, and an unset ADMIN_KEY fails closed — the
 * console would otherwise be the one place that hands out the whole store.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const PREVIEW_CHARS = 240;
const MAX_VALUE_CHARS = 262144;

const ANSWER_FIELDS = ['answer', 'html', 'text', 'content', 'body', 'response', 'truth'];
const QUESTION_FIELDS = ['query', 'input', 'question', 'prompt', 'name'];
const TIME_FIELDS = ['saved', 'savedAt', 'updated', 'updatedAt', 'created', 'createdAt', 'at'];

const KINDS = [
  ['truth:master:', 'master'],
  ['truth:provisional:', 'provisional'],
  ['candidate:', 'candidate'],
  ['decision:', 'decision'],
  ['review:', 'review'],
  ['budget:', 'budget'],
  ['tts:', 'tts'],
  ['upload:', 'upload'],
  ['index:', 'index'],
  ['settings:', 'settings'],
];

/** Admin answers are for one signed-in console, so no cross-origin grant. */
function adminJson(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(init.headers || {}),
    },
  });
}

const adminFail = (status, code, message) => adminJson({ error: { code, message } }, { status });

/** null means the request may continue; a Response means it stops here. */
export function adminGate(request, env) {
  const secret = String(env?.ADMIN_KEY || '');
  if (!secret) {
    return adminFail(
      503,
      'admin_key_unset',
      'Set the ADMIN_KEY secret (wrangler secret put ADMIN_KEY) before the console can be used.',
    );
  }
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = request.headers.get('x-admin-key') || bearer || '';
  if (!keyMatches(secret, provided)) {
    return adminFail(401, 'admin_key_required', 'Send the ADMIN_KEY in the x-admin-key header.');
  }
  return null;
}

/**
 * MASTER first, then MEM. Where only MEM is bound the two are the same store, so
 * it is listed once instead of twice.
 */
export function adminStores(env) {
  const out = [];
  const master = masterKv(env);
  const mem = stateKv(env);
  if (master && master !== mem) out.push({ name: 'MASTER', store: master });
  if (mem) out.push({ name: 'MEM', store: mem });
  if (!out.length && master) out.push({ name: 'MEM', store: master });
  return out;
}

function parseValue(raw) {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // a bare string value is the answer itself
  }
}

function answerOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const field of ANSWER_FIELDS) {
    const raw = value[field];
    if (typeof raw === 'string' && raw.trim()) return raw;
  }
  return '';
}

function questionOf(value, key) {
  if (value && typeof value === 'object') {
    for (const field of QUESTION_FIELDS) {
      const raw = value[field];
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
    }
  }
  return key;
}

function kindOf(key) {
  for (const [prefix, kind] of KINDS) if (key.startsWith(prefix)) return kind;
  return 'other';
}

function savedOf(value) {
  if (!value || typeof value !== 'object') return null;
  for (const field of TIME_FIELDS) {
    const raw = value[field];
    if (typeof raw === 'string' && raw.trim()) return raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const date = new Date(raw < 1e12 ? raw * 1000 : raw);
      return Number.isNaN(date.getTime()) ? String(raw) : date.toISOString();
    }
  }
  return null;
}

function rowFor(store, key, raw) {
  const value = parseValue(raw);
  const answer = answerOf(value);
  return {
    key,
    store,
    kind: kindOf(key),
    question: questionOf(value, key).slice(0, 200),
    preview: answer.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
    chars: answer.length,
    bytes: typeof raw === 'string' ? raw.length : 0,
    hits: Number(value?.hits) || 0,
    saved: savedOf(value),
  };
}

function clampLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function pickStore(env, url) {
  const stores = adminStores(env);
  if (!stores.length) return { error: adminFail(503, 'no_store', 'No KV namespace is bound to this worker.') };
  const wanted = String(url.searchParams.get('store') || stores[0].name).toUpperCase();
  const found = stores.find((entry) => entry.name === wanted);
  if (!found) {
    return {
      error: adminFail(
        404,
        'store_not_found',
        `Unknown store ${wanted}; this deployment has ${stores.map((s) => s.name).join(', ')}.`,
      ),
    };
  }
  return { found, stores };
}

/** Proves the key before the console renders anything. */
export async function adminUnlock(request, env) {
  const gate = adminGate(request, env);
  if (gate) return gate;
  const stores = adminStores(env);
  return adminJson({
    ok: true,
    stores: stores.map((s) => s.name),
    limit: MAX_LIMIT,
    preview: PREVIEW_CHARS,
  });
}

/**
 * One page of the store, values included: a key name alone cannot be curated,
 * and a page of 100 reads stays well inside the per-invocation KV budget.
 */
export async function adminListKeys(request, env, url) {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const { found, stores, error } = pickStore(env, url);
  if (error) return error;
  if (typeof found.store.list !== 'function') {
    return adminFail(503, 'store_unlistable', `${found.name} cannot be listed.`);
  }

  const limit = clampLimit(url.searchParams.get('limit'));
  const cursor = url.searchParams.get('cursor') || undefined;

  let listed;
  try {
    listed = await found.store.list(cursor ? { limit, cursor } : { limit });
  } catch (err) {
    return adminFail(502, 'list_failed', `Could not list ${found.name}: ${err?.message || err}`);
  }

  const names = (listed?.keys || [])
    .map((entry) => entry?.name)
    .filter((name) => typeof name === 'string' && name);

  // The name filter runs before the reads, so a narrow search costs fewer gets.
  const needle = String(url.searchParams.get('q') || '').trim().toLowerCase();
  const matched = needle ? names.filter((name) => name.toLowerCase().includes(needle)) : names;

  const rows = await Promise.all(
    matched.map(async (key) => rowFor(found.name, key, await found.store.get(key).catch(() => null))),
  );

  const next = listed?.list_complete === false ? listed.cursor || null : null;
  return adminJson({
    ok: true,
    store: found.name,
    stores: stores.map((s) => s.name),
    rows,
    cursor: next,
    done: !next,
    listed: names.length,
    matched: matched.length,
    limit,
  });
}

/**
 * The human in the loop. Every answer the pipeline produced is already a
 * candidate; this is the queue, most-repeated first, with the ones that have
 * earned a promotion flagged. It is read-only on purpose: promoting is an edit,
 * and edits go to a truth layer, not to whatever the pipeline happened to say.
 */
export async function adminQueue(request, env, url) {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const limit = clampLimit(url.searchParams.get('limit'));
  const candidates = await listCandidates(env, { limit }).catch(() => []);

  const rows = candidates.map((entry) => ({
    id: entry?.id || null,
    key: entry?.id ? `candidate:${entry.id}` : null,
    question: String(entry?.query || entry?.input || '').slice(0, 200),
    preview: String(entry?.answer || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
    chars: String(entry?.answer || '').length,
    hits: Number(entry?.hits) || 0,
    suggested: Boolean(entry?.suggested) || (Number(entry?.hits) || 0) >= PROMOTE_AT,
    alternatives: Array.isArray(entry?.alternatives) ? entry.alternatives.length : 0,
    preset: entry?.preset || null,
    route: entry?.route || null,
    model: entry?.model || null,
    lastAt: entry?.lastAt || null,
  }));

  return adminJson({
    ok: true,
    promoteAt: PROMOTE_AT,
    total: rows.length,
    ready: rows.filter((row) => row.suggested).length,
    rows,
  });
}

/** The full value behind one row, for the editor. */
export async function adminReadKey(request, env, url) {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const { found, error } = pickStore(env, url);
  if (error) return error;

  const key = String(url.searchParams.get('name') || '');
  if (!key) return adminFail(400, 'name_required', 'Send ?name=<key>.');
  if (typeof found.store.get !== 'function') {
    return adminFail(503, 'store_unreadable', `${found.name} cannot be read.`);
  }

  const raw = await found.store.get(key).catch(() => null);
  if (raw == null) return adminFail(404, 'key_not_found', `${key} is not in ${found.name}.`);

  const text = String(raw);
  const truncated = text.length > MAX_VALUE_CHARS;
  const body = truncated ? text.slice(0, MAX_VALUE_CHARS) : text;
  return adminJson({
    ok: true,
    store: found.name,
    key,
    chars: text.length,
    truncated,
    raw: body,
    value: parseValue(body),
  });
}
