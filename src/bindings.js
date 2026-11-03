/**
 * The deployment owns the binding names; the code owns the behaviour.
 *
 * In the `mind` worker the stores are called MEM (Memoria) and BUCKET. The
 * generic KV / R2 names stay supported so the test suite, local dev and any
 * earlier deployment keep working without a config fork.
 */

export const stateKv = (env) => env?.MEM || env?.KV || null;
export const objects = (env) => env?.BUCKET || env?.R2 || null;

/** What is actually attached, by its deployed name, for /api/health. */
export function bindingReport(env) {
  return {
    ai: Boolean(env?.AI),
    assets: Boolean(env?.ASSETS),
    kv: {
      mem: Boolean(env?.MEM),
      master: Boolean(env?.MASTER),
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
