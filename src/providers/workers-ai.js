import { bytesFromB64 } from '../util.js';

export const TEXT_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const ASR_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const TTS_MODEL = '@cf/myshell-ai/melotts';
export const AURA_MODEL = '@cf/deepgram/aura-2-en';

/**
 * Workers AI has two image conventions on the binding, and picking the wrong
 * one sends an image the model never sees. Newer OpenAI-shaped models take a
 * content part; llama-3.2-vision and moondream take a top-level `image`.
 */
const OPENAI_SHAPED = new Set([
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/qwen/qwen3.8-27b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
]);

export function isOpenAIShaped(model) {
  return OPENAI_SHAPED.has(model);
}

export function buildPayload(model, { messages = [], temperature, maxTokens, images = [] } = {}) {
  const base = { messages: messages.map((m) => ({ role: m.role, content: m.content })) };
  if (temperature != null) base.temperature = temperature;
  if (maxTokens != null) base.max_tokens = maxTokens;
  if (!images.length) return base;

  if (isOpenAIShaped(model)) {
    const last = base.messages[base.messages.length - 1] || { role: 'user', content: '' };
    const text = typeof last.content === 'string' ? last.content : '';
    base.messages[base.messages.length - 1] = {
      role: last.role || 'user',
      content: [
        // Text first, then images — the documented order for these models.
        { type: 'text', text },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    };
    return base;
  }

  base.image = images[0];
  return base;
}

export async function chat(env, opts) {
  const result = await env.AI.run(opts.model, buildPayload(opts.model, opts));
  return result?.response ?? result?.result?.response ?? '';
}

export async function streamChat(env, opts) {
  return env.AI.run(opts.model, { ...buildPayload(opts.model, opts), stream: true });
}

export async function transcribe(env, { audio, model = ASR_MODEL, initialPrompt, language }) {
  const body = { audio, task: 'transcribe' };
  if (initialPrompt) body.initial_prompt = initialPrompt;
  if (language) body.language = language;
  const result = await env.AI.run(model, body);
  return result?.text ?? '';
}

/**
 * melotts returns JSON {audio: base64 mp3}; aura returns a binary stream.
 * Voices are named "aura:<speaker>" so the client can offer them without
 * knowing which binding serves them.
 */
export async function speech(env, { text, voice, lang = 'en' }) {
  if (voice && voice.startsWith('aura:')) {
    const speaker = voice.slice(5) || 'luna';
    const raw = await env.AI.run(
      AURA_MODEL,
      { text, speaker, encoding: 'mp3', container: 'none' },
      { returnRawResponse: true },
    );
    return { body: raw.body, contentType: 'audio/mpeg' };
  }

  const result = await env.AI.run(TTS_MODEL, { prompt: text, lang });
  if (!result?.audio) throw new Error('melotts returned no audio');
  return { bytes: bytesFromB64(result.audio), contentType: 'audio/mpeg' };
}
