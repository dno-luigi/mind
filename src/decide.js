import { sha256Hex } from './util.js';
import { stateKv, browsingService } from './bindings.js';
import { readPage, firstUrl } from './page.js';
import { resolveTruth, questionOf } from './truth.js';
import { findPreset, DEFAULT_PRESET } from './presets.js';

/**
 * A question that names a page, or asks about the live web, needs the browser
 * whatever she said. Keying the browse stage on the decision alone meant the
 * browser never ran when the decision did not name a page.
 */
const WEB_HINT = /\b(browse|search|look ?up|fetch|scrape|latest|current|today|news|website|web ?page)\b/i;

function webWanted(query) {
  const text = String(query || '');
  return /https?:\/\//i.test(text) || WEB_HINT.test(text);
}

const REVIEW_TTL = 60 * 60 * 24 * 30;

const BROWSE_TIMEOUT_MS = 4000;

/**
 * Per-isolate L1 in front of KV.
 *
 * KV reads are served from an edge cache and a freshly written key can stay
 * invisible for up to 60s, so repeating the same turn immediately misses every
 * time — which looks exactly like "the cache does not work". This layer is a
 * plain module-scope Map because `env` is a per-request object in Workers, so
 * keying by it would give each request its own empty cache. Losing the Map on
 * recycle costs one lookup, never a wrong answer.
 */
const L1 = new Map();
const L1_MAX = 500;

/** Exported for tests: a fresh suite must never inherit a previous decision. */
export function _resetDecisionCache() {
  L1.clear();
}

function cacheHit(cached, via, cacheKey) {
  return {
    ...cached,
    source: 'cache',
    // The trace describes this request. Replaying the cached run's stages would
    // claim browse ran again when it did not; keep that under its own name.
    trace: ['cache:hit'],
    cacheSource: via,
    cachedTrace: cached.trace || [],
    cacheKey,
  };
}

/**
 * Bound any upstream call. Without this a stalled engine holds the whole request
 * open — the client sees a spinner, then a blank card, and never learns why.
 */
export function within(ms, label, run) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      err.code = 'upstream_timeout';
      err.status = 504;
      reject(err);
    }, ms);
  });
  return Promise.race([run(), expiry]).finally(() => clearTimeout(timer));
}

/**
 * Stage 2 — intent, straight from her. A missing binding falls back to the old
 * default rather than failing: no decider is the one case she cannot block on.
 */
const PRESET_ACTIONS = new Set(['truth', 'operator', 'mnl', 'doc', 'micro']);

// Her three results, in mind's own terms: the store's result, a preset, or an
// answer written now.
const RESULT_ACTIONS = { result: 'truth', preset: 'operator', ask: 'operator' };

/** The lane a preset answers in. Cods names this on every card; mind never did. */
function domainOf(presetId) {
  return presetId === 'truth' || presetId === 'doc' ? 'legal' : 'general';
}

function fromAra(ara, presetId) {
  if (!ara || !ara.bound) {
    return { preset: presetId || 'operator', task: 'chat', depth: 'normal', tone: 'plain', source: 'no-decider', domain: null };
  }
  // She picks one of mind's own actions, so there is nothing left to classify:
  // a preset action is that preset, browse is generation with the web read first.
  const action = ara.move || 'operator';
  return {
    preset: presetId || (PRESET_ACTIONS.has(action) ? action : RESULT_ACTIONS[action] || 'operator'),
    task: action === 'style' ? 'style' : action === 'truth' || action === 'result' ? 'chat' : 'generate',
    // Her own domain when she sends one; otherwise the lane the preset belongs to.
    depth: 'normal',
    tone: 'plain',
    source: 'ara',
    domain: ara.domain || null,
  };
}

/**
 * Stage 3 — browse. A missing binding is normal, and a failing one must never
 * take the request down: the intent is still good without the material.
 */
async function browseFor(env, { intent, query, worthy }) {
  if (!worthy) return { skipped: true };

  // ABROWSER is this account's name for the agent-browsing worker.
  const service = browsingService(env);
  const url = firstUrl(query);

  if (service && typeof service.fetch === 'function') {
    try {
      const res = await within(BROWSE_TIMEOUT_MS, 'agent-browsing', () =>
        service.fetch(
          new Request('https://agent-browsing/', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ task: intent.task, query: String(query || '').slice(0, 2000) }),
          }),
        ),
      );
      if (res.ok) {
        const text = (await res.text()).slice(0, 4000);
        if (text.trim()) return { ok: true, text, via: 'service' };
      }
      // A service that answers with nothing useful is not the end of the stage.
      // Whether the named page can still be read is decided below.
      if (!url) return { ok: false, status: res.status, via: 'service' };
      const page = await readPage(env, url);
      return page.ok ? page : { ok: false, status: res.status, error: page.error, via: 'rendering' };
    } catch (err) {
      if (!url) return { ok: false, error: String(err?.message || err), via: 'service' };
      const page = await readPage(env, url);
      return page.ok ? page : { ok: false, error: page.error || String(err?.message || err), via: 'rendering' };
    }
  }

  // No browsing service at all: the named page is still readable here.
  if (url) return readPage(env, url);
  return null;
}

/**
 * Stage 6 — review. Records go to MASTER so a session can be read back later;
 * the payload is capped so a long conversation cannot bloat the namespace.
 */
export async function recordReview(env, ctx, record) {
  const master = env?.MASTER;
  if (!master || typeof master.put !== 'function') return false;

  const at = new Date().toISOString();
  const key = `review:${at}:${crypto.randomUUID().slice(0, 8)}`;
  const write = master.put(key, JSON.stringify({ at, ...record }), { expirationTtl: REVIEW_TTL }).catch(
    () => {},
  );

  if (ctx?.waitUntil) ctx.waitUntil(write);
  else await write;
  return true;
}

/**
 * The decision pipeline, in order:
 *
 *   1. cache    MEM lookup; a hit ends the chain
 *   2. intent   ARA answers: route, depth, tone, web
 *   3. browse   AGENT-BROWSING, only when the intent needs outside material
 *   4. user     hand the intent back so the answer can be built
 *   5. operator the rung it runs on: @preset/operator unless a preset was pinned
 *
 * Stage 6 (review) runs after generation, since it records the answer too.
 */
export async function decide(
  env,
  {
    messages,
    images = [],
    presetId = null,
    allowPreset = true,
    engine = 'cloudflare',
    style = false,
    ara = null,
  } = {},
) {
  const trace = [];

  // The client carries its base prompt inside the user turn, so the question a
  // cache or a curated pair is keyed by has to be lifted out of it.
  const lastUser = questionOf([...messages].reverse().find((m) => m.role === 'user')?.content || '');

  const intent = fromAra(ara, presetId);

  const kv = stateKv(env);
  const memo = kv ? L1 : null;
  // The prompt is part of the question. A decision cached under an older prompt
  // replays an answer the current instructions would never give - which is how a
  // corrected preset came back byte-for-byte until the wording changed. Hashing the
  // text means editing a prompt invalidates its cache without anyone tracking a
  // version by hand.
  // A preset carries its prompt as `system` (src/presets.js); reading `prompt`
  // hashed an empty string, which made the fingerprint a constant and the whole
  // guard useless.
  const promptText = String(findPreset(presetId || DEFAULT_PRESET)?.system || '');
  const promptPrint = (await sha256Hex(promptText)).slice(0, 16);
  const cacheKey = `decision:${await sha256Hex(`${lastUser.slice(-4000)}|${images.length}|${presetId || ''}|${promptPrint}`)}`;

  // A question that names a page must not be answered from a decision recorded
  // when the browser did not run: replaying it would skip the browser for good,
  // and the model would then say the page could not be retrieved.
  const wantsWeb = webWanted(lastUser);
  // Only a deployment that can browse has a stale-browse problem; with no
  // binding there is nothing to re-run, so the decision stays a plain hit.
  const canBrowse = Boolean(browsingService(env));
  const staleBrowse = (entry) => canBrowse && wantsWeb && !entry?.browse;

  // 1. cache. A promoted truth is the strongest hit there is, so master and
  // provisional are checked before the decision cache. Memory sits in front of KV
  // because a KV read can lag the write that produced it.
  if (kv) {
    // A palette request is routed, never answered: a stored truth is an answer,
    // and serving one here is what handed back the same theme for every vibe.
    // Everything but a palette may take a stored answer, whatever lane she
    // named: he asked for the store to answer again, and a cache that stays out
    // of the way is a cache that misses.
    const truth = style ? null : await resolveTruth(env, lastUser).catch(() => null);
    // A candidate is an answer this pipeline already produced for this exact
    // question, so it is a cache hit too. Dropping it here meant every repeated
    // ask was generated again — and came back with a different answer, which is
    // the one thing a cache exists to prevent. Whether a candidate is good
    // enough to stand in for the ask is decided by the caller (a brief ask only).
    if (truth?.layer === 'master' || truth?.layer === 'provisional' || truth?.layer === 'candidate') {
      return {
        preset: presetId || intent.preset || DEFAULT_PRESET,
        task: intent.task,
        depth: 'normal',
        tone: 'plain',
        source: 'cache',
        trace: ['cache:hit'],
        domain: intent.domain || domainOf(presetId || intent.preset),
        cacheSource: truth.layer,
        truth,
        cacheKey,
      };
    }

    const local = memo?.get(cacheKey);
    if (local && !staleBrowse(local)) return cacheHit(local, 'memory', cacheKey);
    if (local) trace.push('cache:stale_browse');

    try {
      const hit = await kv.get(cacheKey);
      if (hit) {
        const cached = JSON.parse(hit);
        if (!staleBrowse(cached)) {
          memo?.set(cacheKey, cached);
          return cacheHit(cached, 'kv', cacheKey);
        }
        trace.push('cache:stale_browse');
      }
      if (!trace.includes('cache:stale_browse')) trace.push('cache:miss');
    } catch {
      trace.push('cache:error');
    }
  } else {
    trace.push('cache:unbound');
  }

  // 2. intent — already known.
  trace.push(`intent:${intent.source}`);

  // 3. browse
  const browseWanted = Boolean(ara && ara.bound && ara.move === 'browse');
  const worthy = browseWanted || wantsWeb;
  const browse = await browseFor(env, { intent, query: lastUser, worthy });
  const material = browse?.ok ? browse.text : null;
  trace.push(
    browse === null
      ? 'browse:unbound'
      : browse.skipped
        ? 'browse:skipped'
        : browse.ok
          ? 'browse:ok'
          : 'browse:error',
  );

  // 4. user, then 5. the generation rung. A preset is always in effect — truth
  // is the default, not the absence of one — so this never resolves to null.
  const preset =
    presetId || (allowPreset ? intent.preset : null) || (allowPreset ? DEFAULT_PRESET : null);
  trace.push('user:handoff');
  trace.push(`rung:${preset}`);

  const browseStatus =
    browse === null
      ? 'unbound'
      : browse.skipped
        ? 'skipped'
        : browse.ok
          ? `ok:${browse.via || 'service'}`
          : `error:${browse.status ? `http ${browse.status}` : browse.error || 'unknown'}`;

  const decision = {
    ...intent,
    // Recorded on the decision so the request card, ARA's outcome and the
    // cross-project comparison all speak the same word.
    domain: intent.domain || domainOf(preset || intent.preset),
    preset,
    browse: material,
    browseStatus,
    trace,
    cacheKey,
  };

  // Only a decision that got what it went looking for is worth replaying: a
  // browse that ran and failed must be retried, not remembered. An unbound
  // browser is not a failure — there is nothing to retry.
  const cacheable = !worthy || Boolean(material) || browse === null;

  if (memo && cacheable) {
    if (memo.size >= L1_MAX) memo.clear();
    memo.set(cacheKey, decision);
  }
  if (kv && cacheable) {
    try {
      await kv.put(cacheKey, JSON.stringify(decision), { expirationTtl: 3600 });
    } catch {
      /* the cache is an optimisation, never a requirement */
    }
  }

  return decision;
}
