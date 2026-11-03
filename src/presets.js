/**
 * Presets are server data: prompt + model + params. The client only sends a
 * preset id, so an unknown id is an error instead of a silent fallback to some
 * other model (the old worker quietly answered with Gemma).
 *
 * `cf` is the Cloudflare-first rung, `or` the escalation. Leaving `or` null
 * lets OPENROUTER_MODEL from wrangler.jsonc decide.
 */

export const PRESETS = [
  {
    id: 'default',
    name: 'Default',
    cf: '@cf/google/gemma-4-26b-a4b-it',
    or: null,
    temperature: 0.7,
    maxTokens: 4096,
    system: '',
  },
  {
    id: 'truth-engine',
    name: 'Truth Engine',
    cf: '@cf/google/gemma-4-26b-a4b-it',
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
    or: null,
    temperature: 1.0,
    maxTokens: 4096,
    system: 'You write with voice. Concrete images over abstractions, no filler, no throat-clearing.',
  },
  {
    id: 'analysis',
    name: 'Analysis',
    cf: '@cf/qwen/qwen3.8-27b',
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

/** What the client is allowed to see — no prompts, no model slugs. */
export function publicPresets() {
  return PRESETS.map(({ id, name }) => ({ id, name }));
}
