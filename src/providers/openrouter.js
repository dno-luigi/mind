import { b64FromBytes } from '../util.js';

const BASE = 'https://openrouter.ai/api/v1';

export const DEFAULT_MODEL = 'google/gemini-2.5-flash';
export const DEFAULT_STT_MODEL = 'openai/whisper-large-v3';
export const DEFAULT_TTS_MODEL = 'elevenlabs/eleven-flash-v2.5';

export class UpstreamError extends Error {
  constructor(status, body) {
    super(`OpenRouter ${status}: ${String(body).slice(0, 400)}`);
    this.status = 502;
    this.code = 'upstream_error';
    this.upstreamStatus = status;
  }
}

function headers(env) {
  return {
    authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    'content-type': 'application/json',
    'x-title': 'ai-Ncards',
    ...(env.APP_ORIGIN ? { 'http-referer': env.APP_ORIGIN } : {}),
  };
}

/**
 * A preset slug is referenced as `@preset/<slug>` — a bare slug is ignored by
 * OpenRouter, which would silently fall back to the plain model.
 */
export function modelFor(env, preset) {
  if (preset?.orPreset) return `@preset/${preset.orPreset}`;
  return preset?.or || env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

/**
 * The model that answers when Cloudflare is switched off.
 *
 * `openrouter/free` is OpenRouter's own free router: it picks a free model per
 * request, so the app keeps answering when the daily neurons are gone instead
 * of repointing at one free model that may be withdrawn. A preset cannot be
 * used on this path — its prompt lives in the account and its model is the paid
 * one — so the local prompt travels with the request.
 */
export const FREE_MODEL = 'openrouter/free';

export function freeModelFor(env) {
  return env.OPENROUTER_FREE_MODEL || FREE_MODEL;
}

async function post(env, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new UpstreamError(res.status, await res.text().catch(() => ''));
  return res;
}

export async function chat(env, { model, messages, temperature, maxTokens }) {
  const body = { model, messages, stream: true };
  if (temperature != null) body.temperature = temperature;
  if (maxTokens != null) body.max_tokens = maxTokens;
  return post(env, '/chat/completions', body);
}

export async function transcribe(env, { bytes, format = 'wav', model, language, verbose = false }) {
  const body = {
    model: model || env.OPENROUTER_STT_MODEL || DEFAULT_STT_MODEL,
    input_audio: { data: b64FromBytes(bytes), format },
    response_format: verbose ? 'verbose_json' : 'json',
  };
  if (language) body.language = language;
  const res = await post(env, '/audio/transcriptions', body);
  const data = await res.json();
  return data.text || '';
}

/**
 * response_format is mp3 or pcm and DEFAULTS TO PCM — omit it and the browser
 * receives headerless samples it cannot play.
 */
export async function speech(env, { text, voice, model, format = 'mp3' }) {
  const body = {
    model: model || env.OPENROUTER_TTS_MODEL || DEFAULT_TTS_MODEL,
    input: text,
    voice: voice || 'alloy',
    response_format: format,
  };
  const res = await post(env, '/audio/speech', body);
  return { body: res.body, contentType: format === 'mp3' ? 'audio/mpeg' : 'audio/pcm' };
}

/** Build an OpenRouter content-part array for a message carrying images. */
export function withImages(text, images) {
  if (!images.length) return text;
  return [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
}
