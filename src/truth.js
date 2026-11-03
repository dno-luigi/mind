import { stateKv, masterKv, truthKv } from './bindings.js';
import { sha256Hex } from './util.js';

/**
 * Truth layers, in the order a query resolves:
 *
 *   master       promoted by hand; answers without a model at all
 *   provisional  promoted, but not yet blessed as the final answer
 *   candidate    every answer the pipeline produced, kept for promotion
 *
 * The hit formula is deliberately blunt: case, spacing and trailing punctuation
 * must not split one question into two records, and nothing else is rewritten.
 * A fuzzy match here would promote the wrong answer, which is worse than a miss.
 */

/** How many times one answer must recur before promotion is suggested. */
export const PROMOTE_AT = 3;

/** Thirty days: long enough to review a session, short enough to stay small. */
const TTL = 60 * 60 * 24 * 30;

const MAX_INPUT = 500;
const MAX_ANSWER = 20000;

export function truthKey(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[?!.,;:'"()[\]{}]+/g, '')
    .trim()
    .slice(0, MAX_INPUT);
}

export async function truthId(input) {
  const query = truthKey(input);
  return query ? sha256Hex(query) : null;
}

export const candidateKey = (id) => `candidate:${id}`;
export const truthKeyOf = (layer, id) => `truth:${layer}:${id}`;

/** KV keys cap at 512 bytes, so a plain-text key stops well short of that. */
const MAX_TEXT_KEY = 240;

/** How many different answers to keep beside the first stored one. */
const MAX_ALTERNATIVES = 3;

/** How much of a namespace the search path may look through. */
const TRUTH_SCAN_LIMIT = 500;
const TRUTH_SCAN_READS = 30;

/** Keys this app writes itself. None of them is a stored truth. */
const INTERNAL_PREFIXES = ['candidate:', 'decision:', 'review:', 'budget:', 'tts:', 'upload:', 'obj:', 'index:'];

/** Queries that already proved empty in this isolate, so a miss scans once. */
const SCAN_MISSES = new Set();

/**
 * A stored truth is a truth whatever wrote it. These are the shapes a pair saved
 * before this layout — or by a separate admin page — may live under.
 */
export function legacyTruthKeys(layer, id, query) {
  const text = String(query || '').slice(0, MAX_TEXT_KEY);
  const names = layer === 'master' ? ['master'] : ['provisional'];
  const keys = [];
  for (const name of names) {
    keys.push(`${name}:${id}`, `truth:${name}:${text}`, `${name}:${text}`);
  }
  keys.push(`truth:${id}`, `truth:${text}`);
  return keys;
}

/**
 * Stored pairs are not always this file's shape: a hand-written admin may have
 * saved the answer as `html`, `text`, `content` or a bare string.
 */
function answerOf(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  for (const field of ['answer', 'html', 'text', 'content', 'body', 'response', 'truth']) {
    const raw = value[field];
    if (typeof raw === 'string' && raw.trim()) return raw;
  }
  return null;
}

function citationsOf(value) {
  const raw = Array.isArray(value?.citations)
    ? value.citations
    : Array.isArray(value?.meta?.citations)
      ? value.meta.citations
      : [];
  return raw.filter((c) => c && typeof c === 'object' && c.url).slice(0, 4);
}

function parseRecord(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // a bare string value is the answer itself
  }
}

/** One read, whatever shape the record is in. A tombstone or review blob is a miss. */
async function readTruth(store, key, layer, id, query) {
  if (!store || typeof store.get !== 'function') return null;
  const raw = await store.get(key).catch(() => null);
  if (!raw) return null;
  const parsed = parseRecord(raw);
  const answer = answerOf(parsed);
  if (!answer) return null;
  const fields = parsed && typeof parsed === 'object' ? parsed : {};
  const declared =
    typeof fields.query === 'string'
      ? fields.query
      : typeof fields.input === 'string'
        ? fields.input
        : null;
  return {
    ...fields,
    layer,
    id,
    query: declared || query,
    declared,
    answer,
    citations: citationsOf(parsed),
    key,
  };
}

/** Does the record say it is about this query? A key made of a slug needs this. */
function answersQuery(record, query) {
  for (const field of ['declared', 'question', 'prompt', 'name']) {
    const value = record?.[field];
    if (typeof value === 'string' && truthKey(value) === query) return true;
  }
  return false;
}

/**
 * An opaque key — `ranger1189` — cannot be derived from the query, so the record
 * has to be found by what it says about itself. Bounded, and only reached on a
 * miss, with the miss remembered so the same question does not scan twice.
 */
async function scanForTruth(stores, { id, query }) {
  if (SCAN_MISSES.has(query)) return null;

  for (const store of stores) {
    if (!store || typeof store.list !== 'function') continue;
    const listed = await store.list({ limit: TRUTH_SCAN_LIMIT }).catch(() => null);
    const names = (listed?.keys || [])
      .map((entry) => entry?.name)
      .filter((name) => typeof name === 'string' && !INTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .slice(0, TRUTH_SCAN_READS);
    if (!names.length) continue;

    const found = await Promise.all(
      names.map(async (name) => {
        const hit = await readTruth(store, name, 'master', id, query);
        if (!hit) return null;
        if (!answersQuery(hit, query) && hit.key !== query) return null;
        return { ...hit, scanned: true };
      }),
    );
    const match = found.find(Boolean);
    if (match) return match;
  }

  if (SCAN_MISSES.size > 200) SCAN_MISSES.clear();
  SCAN_MISSES.add(query);
  return null;
}

/**
 * Conflict traffic goes to a different Worker, which keeps the list. Two
 * transports because a deploy may only have one: a service binding when it
 * exists, an explicit URL when it does not. Unconfigured is silent — the stored
 * answer still stands, only the notice is missing.
 */
export function reportConflict(env, ctx, payload) {
  const trim = (value) => (typeof value === 'string' ? value.slice(0, 1000) : (value ?? null));
  const notice = {
    service: 'mind',
    ...payload,
    existing: trim(payload?.existing),
    incoming: trim(payload?.incoming),
    at: payload?.at || new Date().toISOString(),
  };
  const body = JSON.stringify(notice);
  const headers = { 'content-type': 'application/json' };

  let send = null;
  const binding = env?.ALERTS;
  if (binding && typeof binding.fetch === 'function') {
    send = () => binding.fetch(new Request('https://alerts/', { method: 'POST', headers, body }));
  } else if (typeof env?.TRUTH_ALERTS_URL === 'string' && env.TRUTH_ALERTS_URL) {
    const url = env.TRUTH_ALERTS_URL;
    send = () => fetch(url, { method: 'POST', headers, body });
  }
  if (!send) return null;

  const promise = Promise.resolve()
    .then(send)
    .then((res) => Boolean(res?.ok), () => false);
  if (ctx?.waitUntil) ctx.waitUntil(promise);
  return promise;
}

function bad(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Master, then provisional, then the candidate worth promoting. A miss is a
 * normal answer, not an error: it just means the pipeline has to generate.
 *
 * The canonical keys are read first, one round trip. Only when they all miss does
 * the search path run: the shapes an older writer used, the key name itself (an
 * opaque slug like `ranger1189` is the query), then a bounded scan for a record
 * that says which question it answers. A stored pair is found, never answered
 * over — that is the whole point of the first cache check.
 */
export async function resolveTruth(env, input) {
  const mem = stateKv(env);
  const master = masterKv(env);
  // Optional: bind the namespace the admin writes to and its pairs are visible
  // here without copying them anywhere.
  const shared = truthKv(env);
  const query = truthKey(input);
  const stores = [shared, master, mem].filter((store, index, all) => store && all.indexOf(store) === index);

  if (!stores.length) return { layer: 'none', query, reason: 'unbound' };
  if (!query) return { layer: 'none', query, reason: 'empty' };

  const id = await sha256Hex(query);
  const raw = String(input || '').trim();
  const canonical = [truthKeyOf('master', id), truthKeyOf('provisional', id), candidateKey(id)];

  const reads = [];
  for (const store of stores) {
    reads.push(readTruth(store, canonical[0], 'master', id, query));
    reads.push(readTruth(store, canonical[1], 'provisional', id, query));
    reads.push(readTruth(store, canonical[2], 'candidate', id, query));
  }
  const hits = await Promise.all(reads);

  // Layer beats store: a master anywhere outranks a provisional anywhere.
  const masterHit = hits.find((hit) => hit && hit.layer === 'master');
  if (masterHit) return masterHit;
  const provisionalHit = hits.find((hit) => hit && hit.layer === 'provisional');
  if (provisionalHit) return provisionalHit;
  const candidateHit = hits.find((hit) => hit && hit.layer === 'candidate');
  if (candidateHit) return candidateHit;

  const pairs = [];
  const seen = new Set(canonical);
  const add = (store, keys, layer) => {
    for (const key of keys) {
      if (!store || seen.has(key)) continue;
      seen.add(key);
      pairs.push([store, key, layer]);
    }
  };

  for (const store of stores) {
    add(store, legacyTruthKeys('master', id, query), 'master');
    add(store, [query, raw].filter(Boolean), 'master');
  }
  for (const store of stores) {
    add(store, legacyTruthKeys('provisional', id, query), 'provisional');
  }

  const swept = await Promise.all(
    pairs.map(([store, key, layer]) => readTruth(store, key, layer, id, query)),
  );
  const sweptMaster = swept.find((hit) => hit && hit.layer === 'master');
  if (sweptMaster) return sweptMaster;
  const sweptProvisional = swept.find((hit) => hit && hit.layer === 'provisional');
  if (sweptProvisional) return sweptProvisional;

  const scanned = await scanForTruth(stores, { id, query });
  if (scanned) return scanned;

  return { layer: 'none', id, query };
}

/**
 * Every generated answer lands here, so nothing the pipeline said is lost before
 * someone decides whether it is the truth. `hits` counts how many times the same
 * normalized question was answered — the only signal distinguishing a recurring
 * question from a one-off, and the thing promotion is based on.
 *
 * The first stored answer is never replaced. A different answer is kept beside it
 * as an alternative and reported as a conflict: choosing between two answers is
 * an edit, and edits belong in the admin, not in the cache.
 */
export async function recordCandidate(env, { input, answer, preset, route, model }, ctx) {
  const kv = stateKv(env);
  const query = truthKey(input);
  const text = String(answer || '').trim();
  if (!kv || !query || !text) return null;

  const id = await sha256Hex(query);
  const key = candidateKey(id);
  const now = new Date().toISOString();

  let previous = null;
  try {
    previous = JSON.parse((await kv.get(key)) || 'null');
  } catch {
    previous = null;
  }

  const stored = typeof previous?.answer === 'string' ? previous.answer.trim() : '';
  const same = !stored || stored === text;
  const alternatives = Array.isArray(previous?.alternatives) ? [...previous.alternatives] : [];

  if (!same) {
    const known = alternatives.find((entry) => entry?.answer === text);
    if (known) known.count = (known.count || 1) + 1;
    else if (alternatives.length < MAX_ALTERNATIVES) {
      alternatives.push({ answer: text.slice(0, MAX_ANSWER), count: 1, at: now, model: model || null });
    }
  }

  const hits = (previous?.hits || 0) + 1;
  const record = {
    layer: 'candidate',
    id,
    query,
    input: String(input).slice(0, MAX_INPUT),
    answer: (stored || text).slice(0, MAX_ANSWER),
    hits,
    ...(alternatives.length ? { alternatives } : {}),
    firstAt: previous?.firstAt || now,
    lastAt: now,
    preset: preset || null,
    route: route || null,
    model: model || null,
    suggested: hits >= PROMOTE_AT,
  };

  try {
    await kv.put(key, JSON.stringify(record), { expirationTtl: TTL });
  } catch {
    return record;
  }

  if (!same) {
    reportConflict(env, ctx, {
      type: 'candidate_divergence',
      query,
      id,
      key,
      layer: 'candidate',
      existing: stored,
      incoming: text,
      route: route || null,
      model: model || null,
      at: now,
    });
  }

  return record;
}

/**
 * Promote a candidate, or save an edit of one, into a truth layer.
 *
 * Master records carry no expiry: a hand-curated answer that vanishes after
 * thirty days is a bug, not housekeeping. An existing record is not replaced
 * unless `overwrite` is passed — the call reports the clash and leaves both
 * versions alone, so the difference is settled by hand instead of by whichever
 * write came last.
 */
export async function promote(
  env,
  { input, answer, layer = 'master', editor = 'admin', citations = [], overwrite = false },
  ctx,
) {
  const kv = stateKv(env);
  if (!kv) throw bad(503, 'no_store', 'MEM is not bound, so a truth cannot be stored.');
  if (layer !== 'master' && layer !== 'provisional') {
    throw bad(400, 'bad_layer', 'layer must be "master" or "provisional".');
  }

  const query = truthKey(input);
  if (!query) throw bad(400, 'query_required', 'A query is required.');
  const text = String(answer || '').trim();
  if (!text) throw bad(400, 'answer_required', 'An answer is required.');

  const id = await sha256Hex(query);
  const now = new Date().toISOString();
  const key = truthKeyOf(layer, id);
  const store = layer === 'master' ? masterKv(env) : kv;
  const existing = await readTruth(store, key, layer, id, query);

  if (existing && !overwrite && existing.answer.trim() !== text) {
    reportConflict(env, ctx, {
      type: 'promote_conflict',
      query,
      id,
      key,
      layer,
      existing: existing.answer,
      incoming: text,
      at: now,
    });
    return {
      saved: false,
      conflict: true,
      layer,
      id,
      key,
      existing: { layer: existing.layer, answer: existing.answer },
    };
  }

  const record = {
    layer,
    id,
    query,
    input: String(input).slice(0, MAX_INPUT),
    answer: text.slice(0, MAX_ANSWER),
    editor: String(editor || 'admin').slice(0, 80),
    citations: (Array.isArray(citations) ? citations : [])
      .filter((c) => c && c.title && c.url)
      .slice(0, 4)
      .map((c) => ({ title: String(c.title).slice(0, 200), url: String(c.url).slice(0, 500) })),
    promotedAt: existing?.promotedAt || now,
    updatedAt: now,
  };

  if (layer === 'master') await store.put(key, JSON.stringify(record));
  else await store.put(key, JSON.stringify(record), { expirationTtl: TTL });

  // The provisional is left alone: master wins by precedence, and a stored pair
  // is never deleted just to make room for another one.
  return { ...record, saved: true, conflict: false };
}

/** The review queue: candidates by hits, so recurring questions surface first. */
export async function listCandidates(env, { limit = 40 } = {}) {
  const kv = stateKv(env);
  if (!kv) return [];

  const listed = await kv.list({ prefix: 'candidate:', limit }).catch(() => null);
  const keys = listed?.keys || [];
  const out = [];

  for (const entry of keys) {
    const raw = await kv.get(entry.name).catch(() => null);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* skip a corrupt record */
    }
  }

  return out.sort((a, b) => (b.hits || 0) - (a.hits || 0));
}
