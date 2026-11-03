import { stateKv, masterKv } from './bindings.js';
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

function bad(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Master, then provisional, then the candidate worth promoting. A miss is a
 * normal answer, not an error: it just means the pipeline has to generate.
 */
export async function resolveTruth(env, input) {
  const kv = stateKv(env);
  const query = truthKey(input);
  if (!kv) return { layer: 'none', query, reason: 'unbound' };
  if (!query) return { layer: 'none', query, reason: 'empty' };

  const id = await sha256Hex(query);

  const read = async (store, key, layer) => {
    if (!store) return null;
    const raw = await store.get(key).catch(() => null);
    if (!raw) return null;
    try {
      return { ...JSON.parse(raw), layer, id };
    } catch {
      return null; // a corrupt record is a miss, never a crash
    }
  };

  // Master lives in its own namespace; provisional and candidates share MEM,
  // and a candidate is keyed without a layer prefix because it has none yet.
  return (
    (await read(masterKv(env), truthKeyOf('master', id), 'master')) ||
    (await read(kv, truthKeyOf('provisional', id), 'provisional')) ||
    (await read(kv, candidateKey(id), 'candidate')) ||
    { layer: 'none', id, query }
  );
}

/**
 * Every generated answer lands here, so nothing the pipeline said is lost before
 * someone decides whether it is the truth. `hits` counts how many times the same
 * normalized question was answered — the only signal distinguishing a recurring
 * question from a one-off, and the thing promotion is based on.
 */
export async function recordCandidate(env, { input, answer, preset, route, model }) {
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

  const record = {
    layer: 'candidate',
    id,
    query,
    input: String(input).slice(0, MAX_INPUT),
    answer: text.slice(0, MAX_ANSWER),
    hits: (previous?.hits || 0) + 1,
    firstAt: previous?.firstAt || now,
    lastAt: now,
    preset: preset || null,
    route: route || null,
    model: model || null,
    suggested: (previous?.hits || 0) + 1 >= PROMOTE_AT,
  };

  try {
    await kv.put(key, JSON.stringify(record), { expirationTtl: TTL });
  } catch {
    return record;
  }
  return record;
}

/** Promote a candidate, or save an edit of one, into a truth layer. */
export async function promote(env, { input, answer, layer = 'master', editor = 'admin', citations = [] }) {
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
    promotedAt: now,
  };

  const store = layer === 'master' ? masterKv(env) : kv;
  await store.put(truthKeyOf(layer, id), JSON.stringify(record), { expirationTtl: TTL });

  // A master truth supersedes its provisional, and both supersede the candidate.
  if (layer === 'master') {
    await kv.delete(truthKeyOf('provisional', id)).catch(() => {});
  }
  return record;
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
