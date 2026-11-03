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
 * Optional: the namespace a standalone admin writes to. Binding it here means the
 * pairs written there are read here, without copying anything between stores.
 */
export const truthKv = (env) => env?.TRUTH || null;
export const objects = (env) => env?.BUCKET || env?.R2 || null;

/** What is actually attached, by its deployed name, for /api/health. */
export function bindingReport(env) {
  return {
    ai: Boolean(env?.AI),
    assets: Boolean(env?.ASSETS),
    kv: {
      mem: Boolean(env?.MEM),
      master: Boolean(env?.MASTER),
      truth: Boolean(env?.TRUTH),
      legacy: Boolean(env?.KV),
    },
    r2: {
      bucket: Boolean(env?.BUCKET),
      legacy: Boolean(env?.R2),
    },
    services: {
      agentBrowsing: Boolean(env?.['AGENT-BROWSING']),
    },
  };
}
