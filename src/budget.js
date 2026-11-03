import { utcDay } from './util.js';
import { stateKv } from './bindings.js';

// Per-isolate fallback. Resets whenever the isolate is recycled, which is why
// KV is the real store; this only keeps a single-instance deployment honest.
const memory = new Map();

export function _resetBudget() {
  memory.clear();
}

export function dailyLimit(env) {
  const parsed = Number(env?.DAILY_NEURONS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
}

/**
 * Reserve `neurons` against today's per-IP allowance.
 * Soft ceiling: two concurrent requests can both pass, which is acceptable for
 * a personal app and avoids a Durable Object.
 */
export async function charge(env, ip, neurons = 0) {
  const limit = dailyLimit(env);
  const key = `budget:${utcDay()}:${ip}`;
  const amount = Math.max(0, Math.round(neurons));

  const kv = stateKv(env);
  if (kv) {
    const raw = await kv.get(key);
    const used = Number(raw || 0);
    if (used + amount > limit) return { ok: false, used, limit };
    const next = used + amount;
    await kv.put(key, String(next), { expirationTtl: 172800 });
    return { ok: true, used: next, limit };
  }

  const used = memory.get(key) || 0;
  if (used + amount > limit) return { ok: false, used, limit };
  memory.set(key, used + amount);
  return { ok: true, used: used + amount, limit };
}
