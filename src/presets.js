/**
 * Presets are server data: prompt + model + params, one rung per provider.
 *
 * The OpenRouter side is the source of truth for the prompt: each `orPreset`
 * names a preset in the account (https://openrouter.ai/settings/presets) and
 * the escalation rung references `@preset/<slug>` while sending no prompt,
 * model or sampling params of its own. OpenRouter shallow-merges request fields
 * over preset fields, so sending ours would quietly undo the preset.
 *
 * `cf`, `system` and `temperature` therefore describe the Workers AI rung only.
 * It cannot read a prompt that lives in the OpenRouter account, so anything you
 * want on both rungs has to be written twice — here and in the dashboard.
 */

/** Used when no preset is picked and the decision model declines to route. */
export const DEFAULT_PRESET = 'truth';

/** The rung the decision pipeline generates on when nothing was pinned. */
export const OPERATOR_PRESET = 'operator';

export const PRESETS = [
  {
    id: 'truth',
    name: 'Truth',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    orPreset: 'truth',
    or: null,
    // 0.1 stalls on this model: a long ask can run for minutes emitting nothing.
    temperature: 0.3,
    maxTokens: 4096,
    system:
      'You separate verified fact from plausible inference from speculation. Label each claim, cite the reasoning, and say plainly when something cannot be known from the information given. Never invent sources. Answer at the length the request calls for: when it asks for a set number of paragraphs, words or steps, deliver all of them and label claims as you go, rather than answering in one sentence.',
  },
  {
    id: 'operator',
    name: 'Operator',
    cf: '@cf/qwen/qwen3.8-27b',
    orPreset: 'operator',
    or: null,
    temperature: 0.3,
    maxTokens: 6144,
    system:
      'You are an operator: you act rather than explain. Give the shortest path to a working result, name the exact commands or steps, state the precondition that would break it, and skip preamble.',
  },
  {
    id: 'mnl',
    name: 'MNL',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    orPreset: 'mnl',
    or: null,
    temperature: 0.7,
    maxTokens: 4096,
    // The OpenRouter preset owns this prompt; this copy only runs on the
    // Workers AI rung. Fill it in if MNL should behave the same there.
    system: '',
  },
];

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function findPreset(id) {
  if (!id) return null;
  // Older clients sent keys with underscores; ids are lowercase and hyphenated.
  return BY_ID.get(String(id).toLowerCase().replace(/_/g, '-')) || null;
}

/**
 * The Truth Engine Prompt is a secret, not source: it lives in the account's
 * Secrets Store under the TEP binding, so it can be rewritten without a deploy
 * and never appears in this file, in git, or in a chat message.
 *
 * The built-in string above is the fallback, which makes every failure mode
 * boring: no binding, an empty edit, or a store that will not answer leaves the
 * truth preset answering with what it always did rather than failing.
 */
export const promptStore = (env) => (typeof env?.TEP?.get === 'function' ? env.TEP : null);

// One read per isolate: the secret only changes on an edit, and a healthy read
// is worth keeping. A failed read is not cached, so the next turn retries.
let storedPrompt = null;

export async function truthPromptFromStore(env) {
  if (storedPrompt) return storedPrompt;
  const store = promptStore(env);
  if (!store) return null;
  const value = await store.get().catch(() => null);
  const prompt = String(value ?? '').trim();
  if (!prompt) return null;
  storedPrompt = prompt;
  return storedPrompt;
}

/** The preset as it will actually run: the stored prompt wins when there is one. */
export async function withStoredPrompt(env, preset) {
  if (!preset || preset.id !== DEFAULT_PRESET) return preset;
  const prompt = await truthPromptFromStore(env);
  return prompt ? { ...preset, system: prompt } : preset;
}

/** Tests read the same isolate the worker does, so the cache needs a reset. */
export function _resetStoredPrompt() {
  storedPrompt = null;
}

/** What the client is allowed to see — no prompts, no slugs. */
export function publicPresets() {
  return PRESETS.map(({ id, name }) => ({ id, name }));
}

/** Presets bound to an OpenRouter preset, for /api/health diagnostics. */
export function openRouterBackedPresets() {
  return PRESETS.filter((p) => p.orPreset).map((p) => p.id);
}
