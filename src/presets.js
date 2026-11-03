/**
 * Presets are server data: prompt + model + params, one rung per provider.
 *
 * `orPreset` is the slug of an OpenRouter preset
 * (https://openrouter.ai/settings/presets). When the OpenRouter rung answers,
 * the request references `@preset/<slug>` and sends no prompt, model or
 * sampling params — the preset owns those. OpenRouter shallow-merges request
 * fields over preset fields, so sending ours would quietly undo the preset and
 * make the reference pointless.
 *
 * `cf`, `system` and `temperature` therefore describe the Workers AI rung only.
 * The consequence worth knowing: if a preset has no system prompt configured on
 * OpenRouter and the escalation rung answers, no preset prompt applies. The
 * Cloudflare rung always has one.
 */

export const PRESETS = [
  {
    id: 'default',
    name: 'Default',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    orPreset: null,
    or: null,
    temperature: 0.7,
    maxTokens: 4096,
    system: '',
  },
  {
    id: 'truth-engine',
    name: 'Truth Engine',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    orPreset: 'truth-engine',
    or: null,
    temperature: 0.1,
    maxTokens: 4096,
    system:
      'You separate verified fact from plausible inference from speculation. Label each claim, cite the reasoning, and say plainly when something cannot be known from the information given. Never invent sources.',
  },
  {
    id: 'coding',
    name: 'Coding',
    cf: '@cf/qwen/qwen3.8-27b',
    orPreset: 'coding',
    or: null,
    temperature: 0.2,
    maxTokens: 8192,
    system:
      'You are a precise programming assistant. Prefer complete, runnable code over fragments. Name the language, state assumptions, and call out anything you could not verify.',
  },
  {
    id: 'legal',
    name: 'Legal',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    orPreset: 'legal',
    or: null,
    temperature: 0.2,
    maxTokens: 4096,
    system:
      'You explain legal concepts in plain language. You are not a lawyer and you say so when it matters. Distinguish what the text says from what it might imply.',
  },
  {
    id: 'creative',
    name: 'Creative',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    orPreset: 'creative',
    or: null,
    temperature: 1.0,
    maxTokens: 4096,
    system: 'You write with voice. Concrete images over abstractions, no filler, no throat-clearing.',
  },
  {
    id: 'analysis',
    name: 'Analysis',
    cf: '@cf/qwen/qwen3.8-27b',
    orPreset: 'analysis',
    or: null,
    temperature: 0.4,
    maxTokens: 6144,
    system:
      'You break problems into parts, weigh evidence, and state a conclusion. Where the data is thin, say what would change your answer.',
  },
];

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function findPreset(id) {
  if (!id) return null;
  // The client stores keys as truth_engine; presets are named truth-engine.
  return BY_ID.get(String(id).toLowerCase().replace(/_/g, '-')) || null;
}

/** What the client is allowed to see — no prompts, no slugs. */
export function publicPresets() {
  return PRESETS.map(({ id, name }) => ({ id, name }));
}

/** Presets bound to an OpenRouter preset, for /api/health diagnostics. */
export function openRouterBackedPresets() {
  return PRESETS.filter((p) => p.orPreset).map((p) => p.id);
}
