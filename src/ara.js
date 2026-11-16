/**
 * ARA first.
 *
 * The same place clef sits — the front of the chat pipeline — except this is the
 * point of contact rather than a router: when the binding is present she must
 * answer, and a refusal, a timeout or no decision stops the request before any
 * model is called.
 *
 * Unbound (tests, local dev) falls through untouched, so nothing that already
 * works starts failing for want of a binding.
 */
export async function askAra(env, text, domain = 'mind', choice = null, stored = null) {
  const binder = env && env.ARA;
  if (!binder || typeof binder.fetch !== 'function') {
    return { ok: true, bound: false, id: null, move: null, route: null };
  }

  try {
    const response = await binder.fetch('https://ara/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: String(text || ''),
        domain: 'mind',
        surface: 'mind',
        ...(choice ? { choice } : {}),
        ...(stored ? { stored } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false, bound: true, reason: 'ara_status_' + response.status };

    const data = await response.json();
    // She did not understand: the card goes back to him and nothing is generated.
    if (data && data.clarify) {
      return { ok: true, bound: true, clarify: data.clarify, id: data.id ?? null, move: data.move ?? null, route: null, notes: data.notes ?? null };
    }
    if (!data || data.refused || !data.move) return { ok: false, bound: true, reason: 'ara_no_decision' };

    return { ok: true, bound: true, id: data.id ?? null, move: data.move, route: data.route ?? null, notes: data.notes ?? null };
  } catch {
    return { ok: false, bound: true, reason: 'ara_error' };
  }
}

/**
 * What the decision produced. She decides, the run happens, and the row is told
 * what came of it — so her record is not just what she picked.
 */
export async function reportOutcome(env, id, what = {}) {
  const binder = env && env.ARA;
  if (!binder || typeof binder.fetch !== 'function' || id == null) return false;
  try {
    const key = araKey(env);
    const response = await binder.fetch('https://ara/outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
      body: JSON.stringify({
        id,
        returned: what.returned ?? null,
        stored: what.stored ?? null,
        route: what.route ?? null,
        origin: what.origin ?? null,
      }),
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The key ARA's journal now asks for. It lives here rather than in a browser
 * prompt: these two calls are machine writes made with nobody watching, and a
 * prompt cannot answer them. A missing key is reported once by ARA (503) and the
 * call degrades to false, which is what the caller already handles.
 */
const araKey = (env) => String((env && (env.ARA_KEY || env.ADMIN_KEY)) || '').trim();

/** His verdict on a decision, in his words, sent to the row that made it. */
export async function sendVerdict(env, { id, correct, correctedTo = null } = {}) {
  const binder = env && env.ARA;
  if (!binder || typeof binder.fetch !== 'function' || id == null || correct == null) return false;
  try {
    const key = araKey(env);
    const response = await binder.fetch('https://ara/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
      body: JSON.stringify({ id, correct, correctedTo }),
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
