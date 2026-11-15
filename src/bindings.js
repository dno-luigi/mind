/**
 * The deployment owns the binding names; the code owns the behaviour.
 *
 * In the `mind` worker the stores are called MEM (Memoria) and BUCKET. The
 * generic KV / R2 names stay supported so the test suite, local dev and any
 * earlier deployment keep working without a config fork.
 */

export const stateKv = (env) => env?.MEM || env?.KV || null;

/**
 * Master truths belong in the namespace named for them. Where only MEM is bound
 * (local dev, the test suite, a single-namespace deployment) they live there
 * instead, so promotion never fails for want of a second binding.
 */
export const masterKv = (env) => env?.MASTER || stateKv(env) || null;

/**
 * Optional: the truth worker itself, as a service binding. It is the store the
 * standalone admin writes to, so the first cache check can ask it the same
 * question the console asks.
 */
export const truthService = (env) => env?.TRUTH || null;
export const objects = (env) => env?.BUCKET || env?.R2 || null;

/**
 * Browser Rendering — the puppeteer host that /api/shot launches. This account
 * names it BROWSER; MYBROWSER (Cloudflare's docs name) still works. It must stay
 * separate from ABROWSER below: a service binding cannot drive puppeteer.
 */
export const browserBinding = (env) => env?.BROWSER || env?.MYBROWSER || null;

/**
 * The agent-browsing worker, which does the reading rather than the rendering.
 * This deployment names it ABROWSER and AGENT-BROWSER; AGENT-BROWSING is the
 * older spelling, and the short one is accepted so a config slip cannot leave the
 * agent unreachable at runtime. The same binding can appear twice — callers get
 * whichever name actually resolved.
 */
export const browsingService = (env) =>
  env?.ABROWSER || env?.ABROSWER || env?.['AGENT-BROWSER'] || env?.['AGENT-BROWSING'] || null;

/** The name the agent binding resolved under, for /api/health. */
export function browsingServiceName(env) {
  if (env?.ABROWSER) return 'ABROWSER';
  if (env?.ABROSWER) return 'ABROSWER';
  if (env?.['AGENT-BROWSER']) return 'AGENT-BROWSER';
  if (env?.['AGENT-BROWSING']) return 'AGENT-BROWSING';
  return null;
}

/** What is actually attached, by its deployed name, for /api/health. */
export function bindingReport(env) {
  return {
    ai: Boolean(env?.AI),
    assets: Boolean(env?.ASSETS),
    // Present only when Browser Rendering is enabled for the account.
    browser: Boolean(browserBinding(env)),
    kv: {
      mem: Boolean(env?.MEM),
      master: Boolean(env?.MASTER),
      legacy: Boolean(env?.KV),
    },
    r2: {
      bucket: Boolean(env?.BUCKET),
      legacy: Boolean(env?.R2),
    },
    // Secrets Store entries are unreadable from outside; the binding is the only
    // thing worth reporting, never what it holds.
    secretsStore: {
      truthPrompt: Boolean(env?.TEP?.get),
    },
    services: {
      agentBrowsing: Boolean(env?.['AGENT-BROWSING']),
      browsing: Boolean(browsingService(env)),
      truth: Boolean(env?.TRUTH),
    },
  };
}
