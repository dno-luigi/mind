import { sha256Hex } from './util.js';
import { MNL_PROMPT, MICRO_PROMPT, DOC_PROMPT } from './prompts.js';

/**
 * Presets are server data: prompt + model + params, one rung per provider.
 *
 * Each `orPreset` names a preset in the account
 * (https://openrouter.ai/settings/presets), referenced as `@preset/<slug>`.
 * OpenRouter shallow-merges request fields over preset fields, so anything sent
 * alongside the reference replaces what the preset holds.
 *
 * The Truth prompt is not written here: it comes from the TEP secret, and that
 * one text is now used on both rungs. On Workers AI it is the system turn; on
 * OpenRouter it overrides the referenced preset's own prompt, leaving the preset
 * to supply the model and sampling params. Operator and MNL still keep a local
 * copy and the OpenRouter preset's prompt on their own rungs.
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
    // The rung the pipeline generates on when nothing is pinned. Nobody picks it
    // from the menu, so it stays out of /api/presets and out of the button cycle.
    internal: true,
  },
  {
    id: 'mnl',
    name: 'MNL',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    orPreset: 'mnl',
    or: null,
    temperature: 0.7,
    maxTokens: 4096,
    // The owner's MNL prompt, kept here so the Workers AI rung runs the same text
    // the OpenRouter preset carries on its own rung.
    system: MNL_PROMPT,
  },
  // Micro and Doc are the owner's prompts too, kept in src/prompts/ and compiled
  // into src/prompts.js. Their OpenRouter presets carry the same text.
  {
    id: 'micro',
    name: 'Micro',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    orPreset: 'micro',
    or: null,
    temperature: 0.3,
    maxTokens: 4096,
    system: MICRO_PROMPT,
  },
  {
    id: 'doc',
    name: 'Doc',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    orPreset: 'doc',
    or: null,
    temperature: 0.3,
    maxTokens: 4096,
    system: DOC_PROMPT,
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

/**
 * The preset as it will actually run: the stored prompt wins when there is one.
 *
 * `systemFrom` travels with it so the provider rungs can tell a prompt that came
 * from the store from one written for a single provider. Only the Truth preset
 * reads the store: cycling through Operator or MNL must keep those prompts.
 */
export async function withStoredPrompt(env, preset) {
  if (!preset || preset.id !== DEFAULT_PRESET) return preset;
  const prompt = await truthPromptFromStore(env);
  return prompt ? { ...preset, system: prompt, systemFrom: 'store' } : preset;
}

/** Tests read the same isolate the worker does, so the cache needs a reset. */
export function _resetStoredPrompt() {
  storedPrompt = null;
}

/**
 * What the Truth preset will actually run, without the text itself: `source`
 * says whether the store answered, and `version` identifies the prompt by hash
 * so an edit can be seen from outside without the prompt ever being published.
 */
export async function truthPromptInfo(env) {
  const stored = await truthPromptFromStore(env);
  const text = stored || BY_ID.get(DEFAULT_PRESET)?.system || '';
  return {
    source: stored ? 'store' : 'builtin',
    version: text ? (await sha256Hex(text)).slice(0, 12) : null,
    chars: text.length,
  };
}

/** What the client is allowed to see: the presets a person can pick, no internal rung. */
export function publicPresets() {
  return PRESETS.filter((preset) => !preset.internal).map(({ id, name }) => ({ id, name }));
}

/** Presets bound to an OpenRouter preset, for /api/health diagnostics. */
export function openRouterBackedPresets() {
  return PRESETS.filter((p) => p.orPreset && !p.internal).map((p) => p.id);
}
