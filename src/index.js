import { json, fail, has, options, b64FromBytes, bytesFromB64, clientIp } from './util.js';
import { charge } from './budget.js';
import { publicPresets, findPreset, openRouterBackedPresets } from './presets.js';
import * as cf from './providers/workers-ai.js';
import * as or from './providers/openrouter.js';
import { decide } from './decide.js';
import { wavInfo, wavChunks } from './audio.js';
import { DONE, delta, errorEvent, meta, sseData, fromOpenRouterChat, fromWorkersAI } from './normalize.js';

const encoder = new TextEncoder();

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'access-control-allow-origin': '*',
};

const AUDIO_HEADERS = {
  'cache-control': 'public, max-age=31536000, immutable',
  'access-control-allow-origin': '*',
};

/** Cloudflare models that can actually see an image. Others would drop it. */
const VISION_CF = new Set([
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/qwen/qwen3.8-27b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  '@cf/meta/llama-3.2-11b-vision-instruct',
]);

const MAX_MESSAGES_CHARS = 200000;
const MAX_IMAGES = 4;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_TTS_CHARS = 2000;

export default {
  async fetch(request, env, ctx = {}) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return options();

    if (url.pathname.startsWith('/api/')) {
      try {
        return await route(request, env, ctx, url);
      } catch (err) {
        const status = err?.status || 500;
        return fail(status, err?.code || 'internal_error', err?.message || String(err));
      }
    }

    if (url.pathname.startsWith('/f/')) return serveObject(env, url.pathname.slice(3));

    if (env?.ASSETS?.fetch) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

async function route(request, env, ctx, url) {
  const method = request.method;
  const path = url.pathname;

  if (path === '/api/health' && method === 'GET') return health(env);
  if (path === '/api/presets' && method === 'GET') return json({ presets: publicPresets() });
  if (path === '/api/chat' && method === 'POST') return chat(request, env);
  if (path === '/api/stt' && method === 'POST') return stt(request, env);
  if (path === '/api/tts' && method === 'GET') return tts(url, env, ctx);
  if (path === '/api/upload' && method === 'POST') return upload(request, env);

  return fail(404, 'not_found', `No route for ${method} ${path}`);
}

function health(env) {
  return json({
    ok: true,
    service: 'ai-Ncards Worker',
    version: '1.0.0',
    engine: {
      workersAI: has(env, 'AI'),
      openrouter: has(env, 'OPENROUTER_API_KEY'),
    },
    bindings: {
      kv: has(env, 'KV'),
      r2: has(env, 'R2'),
      assets: has(env, 'ASSETS'),
    },
    models: {
      text: cf.TEXT_MODEL,
      asr: cf.ASR_MODEL,
      tts: cf.TTS_MODEL,
      openrouter: env.OPENROUTER_MODEL || or.DEFAULT_MODEL,
      // On the OpenRouter rung these resolve to @preset/<slug> instead.
      openrouterPresets: openRouterBackedPresets(),
    },
    // Features disable themselves rather than failing the whole service.
    features: {
      chat: has(env, 'AI') || has(env, 'OPENROUTER_API_KEY'),
      stt: has(env, 'AI') || has(env, 'OPENROUTER_API_KEY'),
      tts: has(env, 'AI') || has(env, 'OPENROUTER_API_KEY'),
      uploads: has(env, 'R2'),
      ttsCache: has(env, 'R2') || typeof caches !== 'undefined',
    },
  });
}

function normalizeMessages(raw) {
  const messages = [];
  const images = [];

  for (const message of raw) {
    if (!message || typeof message !== 'object') continue;
    const role = ['system', 'user', 'assistant'].includes(message.role) ? message.role : 'user';

    if (typeof message.content === 'string') {
      messages.push({ role, content: message.content });
      continue;
    }

    if (Array.isArray(message.content)) {
      let text = '';
      for (const part of message.content) {
        if (!part) continue;
        if (part.type === 'text') text += part.text || '';
        else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          if (url) images.push(url);
        }
      }
      messages.push({ role, content: text });
    }
  }

  return { messages, images };
}

function pickCfModel(preset, images) {
  const model = preset?.cf || cf.TEXT_MODEL;
  if (!images.length) return model;
  return VISION_CF.has(model) ? model : cf.TEXT_MODEL;
}

/** The provider ladder: Cloudflare first, OpenRouter when CF cannot serve it. */
async function openUpstream(env, { messages, images, preset }) {
  const failures = [];

  if (has(env, 'AI')) {
    const model = pickCfModel(preset, images);
    try {
      const stream = await cf.streamChat(env, {
        model,
        messages,
        images,
        temperature: preset?.temperature,
        maxTokens: preset?.maxTokens,
      });
      return { route: 'workers-ai', model, stream, extract: fromWorkersAI };
    } catch (err) {
      failures.push(`workers-ai: ${err?.message || err}`);
    }
  }

  if (has(env, 'OPENROUTER_API_KEY')) {
    // A referenced OpenRouter preset owns its model, prompt and sampling params.
    // Request fields shallow-merge over preset fields, so sending ours here
    // would override the configuration the preset exists to hold.
    const usesPreset = Boolean(preset?.orPreset);
    const model = or.modelFor(env, preset);
    const base = usesPreset ? messages.filter((message) => message.role !== 'system') : messages;
    const payload = base.map((message, index) =>
      index === base.length - 1 && images.length
        ? { ...message, content: or.withImages(message.content, images) }
        : message,
    );
    const res = await or.chat(env, {
      model,
      messages: payload,
      temperature: usesPreset ? undefined : preset?.temperature,
      maxTokens: usesPreset ? undefined : preset?.maxTokens,
    });
    return { route: 'openrouter', model, stream: res.body, extract: fromOpenRouterChat };
  }

  const err = new Error(`No usable engine. ${failures.join('; ') || 'Bind AI or set OPENROUTER_API_KEY.'}`);
  err.code = 'no_engine';
  err.status = 503;
  throw err;
}

async function chat(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return fail(400, 'messages_required', 'Send { messages: [{ role, content }], preset, stream }.');
  }

  const { messages, images } = normalizeMessages(body.messages);
  if (!messages.length) return fail(400, 'messages_required', 'No usable messages were provided.');

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > MAX_MESSAGES_CHARS) {
    return fail(413, 'context_too_large', `Conversation is ${totalChars} characters; the limit is ${MAX_MESSAGES_CHARS}.`);
  }
  if (images.length > MAX_IMAGES) {
    return fail(413, 'too_many_images', `At most ${MAX_IMAGES} images per request.`);
  }

  const requested = body.preset ? String(body.preset).toLowerCase() : null;
  const requestedPreset = requested ? findPreset(requested) : null;
  if (requested && !requestedPreset) {
    return fail(400, 'unknown_preset', `Unknown preset "${requested}".`, {
      available: publicPresets().map((p) => p.id),
    });
  }

  const gate = await charge(env, clientIp(request), 300);
  if (!gate.ok) {
    return fail(429, 'budget_exhausted', `Daily budget reached (${gate.used}/${gate.limit} neurons). Resets at 00:00 UTC.`);
  }

  // A preset the user picked wins; decide() only fills the gap.
  const decision = await decide(env, { messages, images, presetId: requested });
  const preset =
    requestedPreset ||
    (decision.preset && findPreset(decision.preset)) ||
    findPreset('default');

  const system = preset?.system
    ? [{ role: 'system', content: preset.system }, ...messages]
    : messages;

  const wantsStream = body.stream !== false;

  if (!wantsStream) {
    const { route, model, stream, extract } = await openUpstream(env, { messages: system, images, preset });
    let text = '';
    for await (const data of sseData(stream)) text += extract(data);
    return json({ text, route, model, decision });
  }

  const { route, model, stream, extract } = await openUpstream(env, { messages: system, images, preset });

  const out = new ReadableStream({
    async start(controller) {
      const send = (chunk) => chunk && controller.enqueue(encoder.encode(chunk));
      try {
        send(meta({ route, model, preset: preset?.id, decision }));
        for await (const data of sseData(stream)) {
          const text = extract(data);
          if (text) send(delta(text));
        }
      } catch (err) {
        send(errorEvent(err?.code || 'stream_failed', err?.message || String(err)));
      }
      send(DONE);
      controller.close();
    },
  });

  return new Response(out, { headers: SSE_HEADERS });
}

async function stt(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let bytes;

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null);
    bytes = bytesFromB64(body?.audio || '');
  } else {
    bytes = new Uint8Array(await request.arrayBuffer());
  }

  if (!bytes || !bytes.length) {
    return fail(400, 'audio_required', 'Send a WAV body or {"audio": "<base64>"}.');
  }
  if (bytes.length > MAX_AUDIO_BYTES) {
    return fail(413, 'audio_too_large', `Audio must be under ${Math.round(MAX_AUDIO_BYTES / 1048576)} MB.`);
  }

  const info = wavInfo(bytes);
  const seconds = info?.seconds ?? null;
  const gate = await charge(env, clientIp(request), (seconds ? seconds / 60 : 1) * 46.63);
  if (!gate.ok) {
    return fail(429, 'budget_exhausted', `Daily budget reached (${gate.used}/${gate.limit} neurons).`);
  }

  if (has(env, 'AI')) {
    // 30 s of 16 kHz mono WAV is ~960 KB, under the documented ~1 MB guidance.
    const chunks = info ? wavChunks(bytes, info, 30) : [bytes];
    let text = '';
    for (const chunk of chunks) {
      const piece = await cf.transcribe(env, {
        audio: b64FromBytes(chunk),
        initialPrompt: text ? text.slice(-220) : undefined,
      });
      text += (text ? ' ' : '') + String(piece || '').trim();
    }
    return json({ text: text.trim(), engine: 'workers-ai', chunks: chunks.length, seconds });
  }

  if (has(env, 'OPENROUTER_API_KEY')) {
    const text = await or.transcribe(env, { bytes, format: info ? 'wav' : 'webm' });
    return json({ text: String(text || '').trim(), engine: 'openrouter', chunks: 1, seconds });
  }

  return fail(503, 'no_asr_engine', 'No ASR available: bind AI or set OPENROUTER_API_KEY.');
}

async function tts(url, env, ctx) {
  const text = (url.searchParams.get('t') || '').trim();
  if (!text) return fail(400, 'text_required', 'Pass ?t=<text>.');
  if (text.length > MAX_TTS_CHARS) {
    return fail(413, 'text_too_long', `Split text into chunks under ${MAX_TTS_CHARS} characters.`);
  }

  const voice = url.searchParams.get('v') || '';
  const model = url.searchParams.get('m') || 'melotts';
  const key = `tts/${await sha256Key(`${model}|${voice}|${text}`)}.mp3`;

  if (has(env, 'R2')) {
    const hit = await env.R2.get(key);
    if (hit) return audioResponse(hit.body, { source: 'r2' });
  }

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = cache ? new Request(url.toString(), { method: 'GET' }) : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const gate = await charge(env, clientIpFromUrl(url), Math.max(20, text.length / 6));
  if (!gate.ok) {
    return fail(429, 'budget_exhausted', `Daily budget reached (${gate.used}/${gate.limit} neurons).`);
  }

  let speech;
  if (has(env, 'AI')) {
    speech = await cf.speech(env, { text, voice, lang: url.searchParams.get('lang') || 'en' });
  } else if (has(env, 'OPENROUTER_API_KEY')) {
    speech = await or.speech(env, { text, voice, model });
  } else {
    return fail(503, 'no_tts_engine', 'No TTS available: bind AI or set OPENROUTER_API_KEY.');
  }

  const bytes = speech.bytes || new Uint8Array(await new Response(speech.body).arrayBuffer());
  const response = audioResponse(bytes, { source: 'generated' });

  if (has(env, 'R2') && ctx?.waitUntil) ctx.waitUntil(env.R2.put(key, bytes).catch(() => {}));
  if (cache && cacheKey && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));

  return response;
}

function clientIpFromUrl(url) {
  return url.searchParams.get('ip') || 'anon';
}

function audioResponse(body, { source }) {
  return new Response(body, {
    headers: { ...AUDIO_HEADERS, 'content-type': 'audio/mpeg', 'x-tts-source': source },
  });
}

async function sha256Key(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function upload(request, env) {
  if (!has(env, 'R2')) {
    return fail(503, 'no_storage', 'Uploads need an R2 binding named R2.');
  }
  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  if (!/^(image\/(png|jpeg|webp|gif)|application\/pdf|audio\/|video\/)/.test(contentType)) {
    return fail(415, 'unsupported_type', `Unsupported content type: ${contentType}`);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return fail(400, 'empty_body', 'Upload was empty.');
  if (bytes.length > MAX_AUDIO_BYTES) return fail(413, 'file_too_large', 'Files must be under 12 MB.');

  const digest = await sha256Key(`${contentType}:${bytes.length}:${Date.now()}`);
  const id = `${digest.slice(0, 32)}${extensionFor(contentType)}`;
  await env.R2.put(`uploads/${id}`, bytes, { httpMetadata: { contentType } });
  return json({ id, url: `/f/${id}`, contentType, size: bytes.length });
}

function extensionFor(contentType) {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('pdf')) return '.pdf';
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('mpeg')) return '.mp3';
  if (contentType.includes('mp4')) return '.mp4';
  if (contentType.includes('webm')) return '.webm';
  return '.bin';
}

async function serveObject(env, id) {
  if (!has(env, 'R2')) return new Response('Not found', { status: 404 });
  const object = await env.R2.get(`uploads/${id}`);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  });
}
