import { PRESETS } from './presets.js';

/**
 * Promote a local preset definition into the OpenRouter account, so a prompt
 * edit lives in code and the dashboard just holds the deployed version.
 *
 * Two constraints from the API matter here:
 *
 * 1. The chat/completions skin persists only fields that overlap preset config
 *    (model, temperature, provider, top_p, system, tools). `messages` is ignored
 *    for storage but a system message in it is extracted into `system_prompt`,
 *    which is the only way to set the prompt through this skin.
 * 2. `max_tokens` is not part of a preset, so it stays a request concern. The
 *    preset rung sends none, which means the preset's own output cap applies.
 */

export function upsertPath(slug) {
  return `/presets/${encodeURIComponent(slug)}/chat/completions`;
}

export function upsertBody(preset, { model } = {}) {
  const chosen = model || preset.or;
  if (!chosen) {
    throw new Error(
      `No OpenRouter model for preset "${preset.id}". Set \`or\` in src/presets.js or pass --model.`,
    );
  }

  const body = { model: chosen };
  if (preset.temperature != null) body.temperature = preset.temperature;
  if (preset.system) body.messages = [{ role: 'system', content: preset.system }];
  return body;
}

/** One entry per preset that names an OpenRouter slug; others are local-only. */
export function syncPlan({ model } = {}) {
  return PRESETS.filter((preset) => preset.orPreset).map((preset) => ({
    id: preset.id,
    slug: preset.orPreset,
    path: upsertPath(preset.orPreset),
    body: upsertBody(preset, { model }),
  }));
}
