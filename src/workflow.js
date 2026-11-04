import { stateKv } from './bindings.js';

/**
 * The pipeline switch, built like the engine switch on purpose.
 *
 * On  — every turn runs cache → decision → browse → answer → review queue.
 * Off — the turn goes straight to the model: no cache read, no decision model,
 *       no browser, no candidate recorded. Useful when the pipeline is the thing
 *       being debugged, or when a stale cache entry is worse than no cache.
 *
 * The value lives in MEM, not in the page, because it changes what the Worker
 * does for every browser. An isolate caches it for ten seconds so a busy tab
 * does not pay a KV read per turn.
 */
export const KEY = 'settings:workflow';

export const ON = 'on';
export const OFF = 'off';

const CACHE_MS = 10000;
let cached = { value: null, at: 0 };

/** Exported for tests: a suite that flips this must not leak it into the next. */
export function _resetWorkflow() {
  cached = { value: null, at: 0 };
}

/** Accepts the JSON the API writes and a bare "on"/"off" set by hand. */
function fromRecord(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.enabled === false) return OFF;
    if (parsed && parsed.enabled === true) return ON;
    return null;
  } catch {
    const text = String(raw).trim().toLowerCase();
    if (text === 'off' || text === 'disabled' || text === 'false') return OFF;
    if (text === 'on' || text === 'enabled' || text === 'true') return ON;
    return null;
  }
}

export async function workflowFor(env) {
  // An explicit env var wins, for a deployment that never wants the switch.
  if (env?.WORKFLOW === OFF) return OFF;
  if (env?.WORKFLOW === ON) return ON;
  if (cached.value && Date.now() - cached.at < CACHE_MS) return cached.value;

  // On is the default: the pipeline is what shipped, and losing the store must
  // not silently downgrade every answer to a bare model call.
  let value = ON;
  const kv = stateKv(env);
  if (kv) {
    try {
      value = fromRecord(await kv.get(KEY)) || ON;
    } catch {
      value = ON;
    }
  }
  cached = { value, at: Date.now() };
  return value;
}

export const workflowOn = (value) => value !== OFF;

export async function setWorkflowFor(env, enabled) {
  const kv = stateKv(env);
  if (!kv) {
    const err = new Error('The workflow switch needs the MEM KV binding, or it resets with the isolate.');
    err.status = 503;
    err.code = 'no_store';
    throw err;
  }

  const value = enabled ? ON : OFF;
  await kv.put(KEY, JSON.stringify({ enabled: Boolean(enabled), at: new Date().toISOString() }));
  // Update this isolate now rather than waiting out the cache window.
  cached = { value, at: Date.now() };
  return value;
}
