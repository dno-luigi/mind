/**
 * What he has taught, read from the top.
 *
 * The ladder lives in TEW — his own rules first, then the domain rules, then
 * what any tool learned in chat. TEW computes the matching, the fit and the
 * tiers; this file only asks and carries the answer, so a rule changed there
 * reaches this worker on its next turn without a deploy.
 *
 * The read is a want, never a dependency: no binding, no key, a slow TEW or a
 * refused answer all mean "carry on without it", which is what mind did before
 * the ladder existed.
 */

/** Long enough for a same-account service hop, short enough to stay invisible. */
const TIMEOUT_MS = 1500;

/** The hint is a few lines of rules; anything larger is not a hint any more. */
const HINT_MAX = 2000;

/** TEW is the name in this deployment; TRUTH-ENGINE is the other spelling. */
const tewOf = (env) => env?.TEW || env?.['TRUTH-ENGINE'] || null;

const keyOf = (env) => (typeof env?.LEARN_KEY === 'string' ? env.LEARN_KEY : '');

function signalFor() {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;
}

/**
 * GET /api/learn?prompt=&domain= — the assembled hint and the rows it used.
 * `used` is worth keeping: it says which rows actually shaped this answer.
 */
export async function learnHint(env, { prompt, domain } = {}) {
  const binding = tewOf(env);
  const learnKey = keyOf(env);
  if (!binding || typeof binding.fetch !== 'function' || !learnKey) return null;

  const ask = String(prompt || '').trim().slice(0, 1000);
  if (!ask) return null;

  const query = `prompt=${encodeURIComponent(ask)}${domain ? `&domain=${encodeURIComponent(String(domain))}` : ''}`;

  try {
    const res = await binding.fetch(
      new Request(`https://tew/api/learn?${query}`, {
        headers: { 'x-learn-key': learnKey },
        signal: signalFor(),
      }),
    );
    if (!res.ok) return null;

    const data = await res.json().catch(() => null);
    const hint = typeof data?.hint === 'string' ? data.hint.trim() : '';
    if (!hint) return null;

    return {
      hint: hint.slice(0, HINT_MAX),
      used: Array.isArray(data.used) ? data.used.slice(0, 4) : [],
      counts: data?.counts || null,
    };
  } catch {
    return null; // unreachable TEW is a turn without the hint, not a failed turn
  }
}

/**
 * POST /api/learn — what mind learned, handed up rather than kept here.
 *
 * Only an explicit choice is reported: he picked one of her cards, which is the
 * one moment a turn says something about how he wants this kind of ask handled.
 * Recording every answer instead would fill the ladder with churn.
 */
export async function learnReport(env, ctx, { q, a, source = 'chat' } = {}) {
  const binding = tewOf(env);
  const learnKey = keyOf(env);
  if (!binding || typeof binding.fetch !== 'function' || !learnKey) return false;

  const question = String(q || '').trim().slice(0, 300);
  const answer = String(a || '').trim().slice(0, 500);
  if (!question || !answer) return false;

  const body = JSON.stringify({ action: 'add', q: question, a: answer, source, tool: 'mind' });
  const send = () =>
    binding
      .fetch(
        new Request('https://tew/api/learn', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-learn-key': learnKey },
          body,
          signal: signalFor(),
        }),
      )
      .then((res) => Boolean(res?.ok), () => false);

  // Awaited when there is nowhere to defer to, so the write is not dropped.
  if (ctx?.waitUntil) {
    ctx.waitUntil(send());
    return true;
  }
  return send();
}
