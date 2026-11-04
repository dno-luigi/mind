import { sha256Hex } from './util.js';
import { stateKv, browsingService } from './bindings.js';
import { readPage, firstUrl } from './page.js';
import { workflowOn, ON as WORKFLOW_ON } from './workflow.js';
import { resolveTruth, questionOf } from './truth.js';
import { DEFAULT_PRESET } from './presets.js';

/**
 * The clef ladder: smallest window first, escalate only when the state does not
 * fit. Platform rules this encodes — `model` must be the short name, not the
 * @cf id, and the window is enforced upstream rather than trimmed for us.
 */
export const LADDER = [
  { id: '@cf/cloudflare/clef-flash', model: 'clef-flash', context: 24576 },
  { id: '@cf/cloudflare/clef-omni', model: 'clef-omni', context: 64000 },
  { id: '@cf/cloudflare/clef', model: 'clef', context: 65536 },
];

const CHARS_PER_TOKEN = 3;
const SAFETY = 0.8;

export const QUESTIONS = {
  task: { type: 'choice', choices: ['chat', 'transform', 'generate', 'extract', 'compare'] },
  preset: { type: 'choice', choices: ['truth', 'operator', 'mnl'] },
  depth: { type: 'choice', choices: ['terse', 'normal', 'deep'] },
  tone: { type: 'choice', choices: ['plain', 'precise', 'playful'] },
};

/** Intents that need material from outside the conversation pay for a lookup. */
const BROWSE_WORTHY = new Set(['extract', 'compare']);

/**
 * A question that names a page, or asks about the live web, needs the browser
 * whatever the decision model said. With Cloudflare switched off there is no clef
 * at all — the intent falls back to `chat` — so keying the browse stage on the
 * decision alone meant the browser never ran on exactly those deployments.
 */
const WEB_HINT = /\b(browse|search|look ?up|fetch|scrape|latest|current|today|news|website|web ?page)\b/i;

function webWanted(query) {
  const text = String(query || '');
  return /https?:\/\//i.test(text) || WEB_HINT.test(text);
}

const REVIEW_TTL = 60 * 60 * 24 * 30;

/** A rung that never answers is a failed rung; escalating is cheaper than waiting. */
const RUNG_TIMEOUT_MS = 5000;
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
    // claim clef and browse ran again when they did not; keep that under its own
    // name instead.
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

function budgetState(messages, context) {
  const budget = Math.floor(context * SAFETY * CHARS_PER_TOKEN);
  const joined = messages
    .map((m) => (m.role === 'system' ? `[system] ${m.content}` : `${m.role}: ${m.content}`))
    .join('\n');
  return joined.length <= budget ? joined : `…${joined.slice(-budget)}`;
}

function parseDecision(out) {
  const candidates = [out?.response, out?.result?.response, out?.answers, out?.result];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let value = candidate;
    if (typeof value === 'string') {
      const match = value.match(/\{[\s\S]*\}/);
      if (!match) continue;
      try {
        value = JSON.parse(match[0]);
      } catch {
        continue;
      }
    }
    if (typeof value === 'object') {
      const pick = (field) => {
        const raw = value[field];
        const answer = typeof raw === 'object' && raw !== null ? raw.answer ?? raw.value ?? raw.choice : raw;
        return typeof answer === 'string' ? answer.toLowerCase() : null;
      };
      const result = {};
      for (const field of Object.keys(QUESTIONS)) {
        const answer = pick(field);
        if (answer) result[field] = answer;
      }
      if (result.preset || result.depth || result.task) return result;
    }
  }
  return null;
}

/** Stage 2 — intent. A decision is an optimisation, never a single point of failure. */
async function intentFor(env, { messages, images, presetId, engine = 'cloudflare' }) {
  const fallback = { preset: presetId, depth: 'normal', tone: 'plain', task: 'chat', source: 'fallback' };
  // With Cloudflare switched off there is no clef to ask, and asking it anyway
  // would spend exactly the neurons the switch exists to save.
  if (engine !== 'cloudflare' || !env?.AI || env.DECIDE === 'off') return fallback;

  for (const rung of LADDER) {
    try {
      const payload = {
        model: rung.model,
        state: budgetState(messages, rung.context),
        questions: QUESTIONS,
      };
      // clef reads images itself, but only as data URIs, never remote URLs.
      if (images.length) payload.images = images.slice(0, 4);

      const out = await within(RUNG_TIMEOUT_MS, rung.model, () => env.AI.run(rung.id, payload));
      const parsed = parseDecision(out);
      if (parsed) return { ...fallback, ...parsed, source: rung.model };
    } catch {
      // Window refused or model unavailable — escalate to the next rung.
    }
  }

  return fallback;
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
 *   2. intent   clef ladder classifies task / preset / depth / tone
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
    workflow = WORKFLOW_ON,
  } = {},
) {
  const trace = [];

  // The switch, off: the pipeline is not part of this turn at all. Nothing is
  // read from the cache, nothing is written to it, and no model is asked what
  // the request is — the answer goes straight to the generation rung.
  if (!workflowOn(workflow)) {
    return {
      preset: presetId || (allowPreset ? DEFAULT_PRESET : null),
      task: 'chat',
      depth: 'normal',
      tone: 'plain',
      source: 'off',
      workflow: 'off',
      trace: ['workflow:off'],
      browse: null,
      browseStatus: 'skipped',
      cacheKey: null,
    };
  }
  // The client carries its base prompt inside the user turn, so the question a
  // cache or a curated pair is keyed by has to be lifted out of it.
  const lastUser = questionOf([...messages].reverse().find((m) => m.role === 'user')?.content || '');

  const kv = stateKv(env);
  const memo = kv ? L1 : null;
  const cacheKey = `decision:${await sha256Hex(`${lastUser.slice(-4000)}|${images.length}|${presetId || ''}`)}`;

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
    const truth = await resolveTruth(env, lastUser).catch(() => null);
    if (truth?.layer === 'master' || truth?.layer === 'provisional') {
      return {
        preset: presetId || DEFAULT_PRESET,
        task: 'chat',
        depth: 'normal',
        tone: 'plain',
        source: 'cache',
        trace: ['cache:hit'],
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

  // 2. intent
  const intent = await intentFor(env, { messages, images, presetId, engine });
  trace.push(`intent:${intent.source}`);

  // 3. browse
  const worthy = BROWSE_WORTHY.has(intent.task) || intent.depth === 'deep' || wantsWeb;
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
    preset,
    browse: material,
    browseStatus,
    workflow: 'on',
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
