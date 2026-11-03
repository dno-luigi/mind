import { stateKv } from './bindings.js';

/**
 * Which engine answers: Cloudflare Workers AI first, or OpenRouter only.
 *
 * One switch, one store. A flip in the UI has to apply to every isolate and
 * every browser, so the value lives in MEM rather than in the page, and the
 * request path reads it instead of trusting a per-tab preference.
 *
 * Workers AI is the default because that is how the app has always run and the
 * free neuron allowance is real money; the switch exists for the day it is gone.
 */
export const KEY = 'settings:engine';

export const CLOUDFLARE = 'cloudflare';
export const OPENROUTER = 'openrouter';

/** A KV read can trail the write by up to 60s; re-reading every 10s keeps a flip quick. */
const CACHE_MS = 10000;
let cached = { value: null, at: 0 };

/** Exported for tests: a suite that flips the switch must not leak it into the next. */
export function _resetEngine() {
  cached = { value: null, at: 0 };
}

/** Accepts the JSON the API writes and a bare "on"/"off" set by hand. */
function fromRecord(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.cloudflare === false) return OPENROUTER;
    if (parsed && parsed.cloudflare === true) return CLOUDFLARE;
    return null;
  } catch {
    const text = String(raw).trim().toLowerCase();
    if (text === 'off' || text === OPENROUTER) return OPENROUTER;
    if (text === 'on' || text === CLOUDFLARE) return CLOUDFLARE;
    return null;
  }
}

export async function engineFor(env) {
  // An explicit env var wins, for the deployment that never wants the switch.
  if (env?.ENGINE === OPENROUTER) return OPENROUTER;
  if (cached.value && Date.now() - cached.at < CACHE_MS) return cached.value;

  let value = CLOUDFLARE;
  const kv = stateKv(env);
  if (kv) {
    try {
      value = fromRecord(await kv.get(KEY)) || CLOUDFLARE;
    } catch {
      // An unreadable store must not take the app down: the default is the
      // behaviour that shipped, not a silent switch to the paid engine.
      value = CLOUDFLARE;
    }
  }
  cached = { value, at: Date.now() };
  return value;
}

export async function setEngineFor(env, cloudflare) {
  const kv = stateKv(env);
  if (!kv) {
    const err = new Error('The switch needs the MEM KV binding, or it resets with the isolate.');
    err.status = 503;
    err.code = 'no_store';
    throw err;
  }

  const value = cloudflare ? CLOUDFLARE : OPENROUTER;
  await kv.put(KEY, JSON.stringify({ cloudflare: Boolean(cloudflare), at: new Date().toISOString() }));
  // Update this isolate now rather than waiting out the cache window.
  cached = { value, at: Date.now() };
  return value;
}

/** The switch and the binding together: off means no env.AI.run anywhere. */
export const canUseCloudflare = (env, engine) => engine === CLOUDFLARE && Boolean(env?.AI);
