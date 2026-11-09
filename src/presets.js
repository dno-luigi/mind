import { sha256Hex } from './util.js';
import { TRUTH_PROMPT, MNL_PROMPT, MICRO_PROMPT, DOC_PROMPT } from './prompts.js';

/**
 * Presets are server data: prompt + model + params, one rung per provider.
 *
 * Each `orPreset` names a preset in the account
 * (https://openrouter.ai/settings/presets), referenced as `@preset/<slug>`.
 * OpenRouter shallow-merges request fields over preset fields, so anything sent
 * alongside the reference replaces what the preset holds.
 *
 * The prompts are the owner's, in src/prompts/*.md and compiled into
 * src/prompts.js. Truth, MNL, Micro and Doc each carry their own text, and the
 * Truth one is used on both rungs: on Workers AI it is the system turn, and on
 * OpenRouter it overrides the referenced preset's own prompt, leaving the preset
 * to supply the model and sampling params. Operator keeps a local copy for the
 * rung the pipeline generates on when nothing is pinned.
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
    // The owner's Truth Engine prompt (src/prompts/truth.md). `systemFrom: 'code'`
    // tells the OpenRouter rung to send this text over the preset's own prompt, so
    // one prompt is what answers on both rungs.
    system: TRUTH_PROMPT,
    systemFrom: 'code',
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
 * What the Truth preset will run, without the text itself: `version` identifies
 * the prompt by hash, so an edit is visible from outside without publishing it.
 *
 * The text lives in src/prompts/truth.md. The Secrets Store binding that used to
 * hold a prompt answered with a 24,205-character value that took most of a turn's
 * twenty-second opening budget and was not this text, so the file is now the only
 * source and nothing can quietly substitute something else.
 */
export async function truthPromptInfo() {
  const text = BY_ID.get(DEFAULT_PRESET)?.system || '';
  return {
    source: 'code',
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
