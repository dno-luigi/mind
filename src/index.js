import { json, fail, has, options, b64FromBytes, bytesFromB64, clientIp, keyMatches } from './util.js';
import { charge } from './budget.js';
import { stateKv, objects, bindingReport } from './bindings.js';
import { engineFor, setEngineFor, canUseCloudflare } from './engine.js';
import { publicPresets, findPreset, openRouterBackedPresets, DEFAULT_PRESET } from './presets.js';
import * as cf from './providers/workers-ai.js';
import * as or from './providers/openrouter.js';
import { decide, recordReview, within } from './decide.js';
import { recordCandidate, questionOf } from './truth.js';
import { adminUnlock, adminListKeys, adminReadKey } from './admin.js';
import { shot } from './shot.js';
import { wavInfo, wavChunks } from './audio.js';
import { DONE, delta, errorEvent, meta, sseData, upstreamError, frameShape, fromOpenRouterChat, fromWorkersAI } from './normalize.js';

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

/**
 * An idle budget, restarted on every chunk: a slow but flowing answer survives,
 * a dead one becomes an error naming the model instead of a 58-second silence.
 */
const STREAM_IDLE_MS = 15000;
/** How long opening a connection — not answering — may take. */
const UPSTREAM_OPEN_MS = 20000;

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

    // Static assets answer a POST to "/" with a bare 405, which reads as the
    // whole app being down. Name the route that was actually wanted instead.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(405, 'wrong_route', `${request.method} ${url.pathname} is not an endpoint; chat is POST /api/chat.`);
    }

    if (env?.ASSETS?.fetch) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

async function route(request, env, ctx, url) {
  const method = request.method;
  const path = url.pathname;

  if (path === '/api/health' && method === 'GET') return health(env);
  if (path === '/api/presets' && method === 'GET') return json({ presets: publicPresets() });
  if (path === '/api/chat' && method === 'POST') return chat(request, env, ctx);
  if (path === '/api/stt' && method === 'POST') return stt(request, env);
  if (path === '/api/tts' && method === 'GET') return tts(url, env, ctx);
  if (path === '/api/upload' && method === 'POST') return upload(request, env);
  if (path === '/api/engine' && method === 'GET') return engineView(env);
  if (path === '/api/engine' && method === 'POST') return switchEngine(request, env);
  // Headless screenshots. Billed per browser-second, so one page, one shot, closed.
  if (path === '/api/shot' && method === 'GET') return shot(url, env);

  // The console reads the store; it still cannot write one. Every route below
  // needs ADMIN_KEY, and an unset key fails closed rather than open.
  if (path === '/api/admin/unlock' && method === 'POST') return adminUnlock(request, env);
  if (path === '/api/admin/keys' && method === 'GET') return adminListKeys(request, env, url);
  if (path === '/api/admin/key' && method === 'GET') return adminReadKey(request, env, url);

  return fail(404, 'not_found', `No route for ${method} ${path}`);
}

async function health(env) {
  const kv = stateKv(env);
  const bucket = objects(env);
  const engine = await engineFor(env);
  const useCf = canUseCloudflare(env, engine);

  return json({
    ok: true,
    service: 'mind',
    version: '1.2.0',
    engine: {
      workersAI: has(env, 'AI'),
      openrouterKey: has(env, 'OPENROUTER_API_KEY'),
      // The switch. "openrouter" means no Workers AI call is made at all.
      active: engine,
      cloudflare: useCf,
    },
    bindings: bindingReport(env),
    models: {
      text: cf.TEXT_MODEL,
      asr: cf.ASR_MODEL,
      tts: cf.TTS_MODEL,
      openrouter: env.OPENROUTER_MODEL || or.DEFAULT_MODEL,
      // What answers when the switch is off.
      openrouterFree: or.freeModelFor(env),
      // On the OpenRouter rung these resolve to @preset/<slug> instead.
      openrouterPresets: openRouterBackedPresets(),
    },
    // Features disable themselves rather than failing the whole service.
    features: {
      chat: useCf || has(env, 'OPENROUTER_API_KEY'),
      stt: useCf || has(env, 'OPENROUTER_API_KEY'),
      tts: useCf || has(env, 'OPENROUTER_API_KEY'),
      uploads: Boolean(bucket),
      ttsCache: Boolean(bucket) || typeof caches !== 'undefined',
      // False means the budget is per-isolate and resets; see wrangler.jsonc.
      sharedBudget: Boolean(kv),
      decisionCache: Boolean(kv),
      // Candidates are recorded in MEM; truth records are seeded out of band.
      truth: Boolean(kv),
      // Browser Rendering is opt-in: no binding, no /api/shot.
      screenshots: Boolean(env?.MYBROWSER),
    },
  });
}

/** What the switch reads as, without exposing the store. */
async function engineView(env) {
  const engine = await engineFor(env);
  return json({
    ok: true,
    engine,
    cloudflare: canUseCloudflare(env, engine),
    bound: {
      ai: has(env, 'AI'),
      openrouter: has(env, 'OPENROUTER_API_KEY'),
      store: Boolean(stateKv(env)),
    },
  });
}

async function switchEngine(request, env) {
  // This is the one route that changes how the app spends money, so it is the
  // one route with a gate. An unset KEY fails closed rather than open.
  const secret = String(env?.KEY || '');
  if (!secret) {
    return fail(
      503,
      'key_unset',
      'Set the KEY secret (wrangler secret put KEY) before the switch can be used.',
    );
  }
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = request.headers.get('x-engine-key') || bearer;
  if (!keyMatches(secret, provided)) {
    return fail(401, 'key_required', 'Send the KEY in the x-engine-key header.');
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.cloudflare !== 'boolean') {
    return fail(400, 'cloudflare_required', 'Send { cloudflare: true | false }.');
  }
  // Turning Cloudflare off with no key to fall back to would leave the app
  // answering nothing, which is a worse outcome than a loud refusal.
  if (!body.cloudflare && !has(env, 'OPENROUTER_API_KEY')) {
    return fail(
      409,
      'no_openrouter_key',
      'OPENROUTER_API_KEY is not set, so Cloudflare cannot be turned off.',
    );
  }

  const engine = await setEngineFor(env, body.cloudflare);
  return json({ ok: true, engine, cloudflare: canUseCloudflare(env, engine) });
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

/** Task -> model. Used when clef decides, rather than the user pinning a preset. */
const TASK_CF = {
  chat: '@cf/google/gemma-4-26b-a4b-it',
  transform: '@cf/qwen/qwen3.8-27b',
  generate: '@cf/google/gemma-4-26b-a4b-it',
  extract: '@cf/qwen/qwen3.8-27b',
  compare: '@cf/qwen/qwen3.8-27b',
};

/** The depth the decision model reports becomes an output budget. */
const DEPTH_TOKENS = { terse: 1024, deep: 8192 };

function budgetFor(preset, decision, explicit) {
  if (explicit) return preset?.maxTokens;
  return DEPTH_TOKENS[decision?.depth] ?? preset?.maxTokens ?? null;
}

function pickCfModel(preset, images, { decision, explicit } = {}) {
  // clef first: with nothing pinned, its task picks the model and the preset only
  // supplies the prompt. A pinned preset overrides both.
  const chosen = explicit ? preset?.cf : TASK_CF[decision?.task] || preset?.cf;
  const model = chosen || cf.TEXT_MODEL;
  if (!images.length) return model;
  return VISION_CF.has(model) ? model : cf.TEXT_MODEL;
}

/** The provider ladder: Cloudflare first, OpenRouter when CF cannot serve it. */
async function openUpstream(
  env,
  { messages, images, preset, decision, explicit, allowCloudflare = true, freeRouter = false },
) {
  const failures = [];

  if (allowCloudflare && has(env, 'AI')) {
    const model = pickCfModel(preset, images, { decision, explicit });
    try {
      const stream = await within(UPSTREAM_OPEN_MS, `workers-ai ${model}`, () =>
        cf.streamChat(env, {
          model,
          messages,
          images,
          temperature: preset?.temperature,
          maxTokens: budgetFor(preset, decision, explicit),
        }),
      );
      return { route: 'workers-ai', model, stream, extract: fromWorkersAI };
    } catch (err) {
      failures.push(`workers-ai: ${err?.message || err}`);
    }
  }

  if (has(env, 'OPENROUTER_API_KEY')) {
    // A referenced OpenRouter preset owns its model, prompt and sampling params.
    // Request fields shallow-merge over preset fields, so sending ours here
    // would override the configuration the preset exists to hold.
    // Only the switch sends traffic to the free router. A deployment with no AI
    // binding is not the same thing: OpenRouter is its only engine, so it keeps
    // the presets and the paid model it always had.
    const freeOnly = Boolean(freeRouter);
    const usesPreset = !freeOnly && Boolean(preset?.orPreset);
    const model = freeOnly ? or.freeModelFor(env) : or.modelFor(env, preset);
    const base = usesPreset ? messages.filter((message) => message.role !== 'system') : messages;
    const payload = base.map((message, index) =>
      index === base.length - 1 && images.length
        ? { ...message, content: or.withImages(message.content, images) }
        : message,
    );
    const res = await within(UPSTREAM_OPEN_MS, `openrouter ${model}`, () =>
      or.chat(env, {
        model,
        messages: payload,
        temperature: usesPreset ? undefined : preset?.temperature,
        maxTokens: usesPreset ? undefined : preset?.maxTokens,
      }),
    );
    return { route: 'openrouter', model, stream: res.body, extract: fromOpenRouterChat };
  }

  const switchedOff = allowCloudflare ? '' : ' Cloudflare is switched off and OPENROUTER_API_KEY is unset.';
  const err = new Error(
    `No usable engine.${switchedOff} ${failures.join('; ') || 'Bind AI or set OPENROUTER_API_KEY.'}`,
  );
  err.code = 'no_engine';
  err.status = 503;
  throw err;
}

/** "0 frames" and "3 frames with keys choices" point at different faults. */
function describeEmpty(frames, shape) {
  if (!frames) return 'the stream carried no frames';
  return `${frames} frame${frames === 1 ? '' : 's'} with keys ${shape || 'unknown'}`;
}

/** An in-stream provider failure still needs to reach the caller as an error. */
function explain(problem) {
  const err = new Error(problem);
  err.code = 'upstream_error';
  err.status = 502;
  return err;
}

/** The review record: enough to reconstruct a session, capped so KV stays small. */
function reviewOf({ preset, decision, route, model, lastUser, text }) {
  return {
    preset: preset?.id ?? null,
    task: decision?.task,
    route,
    model,
    charsIn: String(lastUser).length,
    charsOut: String(text).length,
    prompt: String(lastUser).slice(0, 500),
    answer: String(text).slice(0, 1500),
  };
}

async function chat(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return fail(400, 'messages_required', 'Send { messages: [{ role, content }], preset, stream }.');
  }

  const { messages, images } = normalizeMessages(body.messages);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  // What was actually asked, without the base prompt the client wraps around it.
  const question = questionOf(lastUser);
  if (!messages.length) return fail(400, 'messages_required', 'No usable messages were provided.');

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > MAX_MESSAGES_CHARS) {
    return fail(413, 'context_too_large', `Conversation is ${totalChars} characters; the limit is ${MAX_MESSAGES_CHARS}.`);
  }
  if (images.length > MAX_IMAGES) {
    return fail(413, 'too_many_images', `At most ${MAX_IMAGES} images per request.`);
  }

  const requested = body.preset ? String(body.preset).toLowerCase() : null;
  // "none" is a real selection: no preset prompt and no @preset/ reference.
  const noneSelected = requested === 'none' || requested === 'no-preset';
  const requestedPreset = requested && !noneSelected ? findPreset(requested) : null;
  if (requested && !noneSelected && !requestedPreset) {
    return fail(400, 'unknown_preset', `Unknown preset "${requested}".`, {
      available: publicPresets().map((p) => p.id),
    });
  }

  // Truth is the default preset, not a user choice, so it must not outrank the
  // decision. A preset picked deliberately (anything but the default) does.
  const pinned = Boolean(requestedPreset) && requestedPreset.id !== DEFAULT_PRESET;

  const engine = await engineFor(env);
  const useCf = canUseCloudflare(env, engine);

  // Neurons are the reason this switch exists: with Cloudflare off nothing is
  // charged against the daily allowance, and OpenRouter's limits apply instead.
  const gate = useCf ? await charge(env, clientIp(request), 300) : { ok: true };
  if (!gate.ok) {
    return fail(429, 'budget_exhausted', `Daily budget reached (${gate.used}/${gate.limit} neurons). Resets at 00:00 UTC.`);
  }

  // A preset the user picked wins; decide() only fills the gap.
  const decision = await decide(env, {
    messages,
    images,
    presetId: pinned ? requested : null,
    allowPreset: !noneSelected,
    engine,
  });
  // A deliberate pick wins outright. Otherwise the decision steers, and the
  // preset the client sent (truth, normally) is the fallback prompt.
  const preset = noneSelected
    ? null
    : pinned
      ? requestedPreset
      : (decision.preset && findPreset(decision.preset)) || requestedPreset || findPreset(DEFAULT_PRESET);

  // Report the preset that actually ran, not the one the decision model named:
  // they diverge whenever it suggests a preset that no longer exists.
  const reported = { ...decision, preset: preset?.id ?? null };
  const wantsStream = body.stream !== false;

  // A promoted truth is the cache that actually short-circuits: the MEM check
  // decided this before clef was ever asked, so no model runs.
  if (decision.truth?.answer) {
    const truth = decision.truth;
    if (!wantsStream) {
      await recordReview(
        env,
        ctx,
        reviewOf({ preset, decision: reported, route: 'truth', model: truth.layer, lastUser, text: truth.answer }),
      );
      return json({ text: truth.answer, route: 'truth', model: truth.layer, decision: reported });
    }

    const truthStream = new ReadableStream({
      start(controller) {
        const send = (chunk) => chunk && controller.enqueue(encoder.encode(chunk));
        send(meta({ route: 'truth', model: truth.layer, preset: preset?.id, decision: reported }));
        send(delta(truth.answer));
        send(DONE);
        controller.close();
      },
    });
    return new Response(truthStream, { headers: SSE_HEADERS });
  }

  const system = preset?.system
    ? [{ role: 'system', content: preset.system }, ...messages]
    : messages;

  if (!wantsStream) {
    const { route, model, stream, extract } = await openUpstream(env, {
      messages: system,
      images,
      preset,
      decision: reported,
      explicit: pinned,
      allowCloudflare: useCf,
      freeRouter: engine === 'openrouter',
    });
    let text = '';
    let frames = 0;
    let shape = null;
    for await (const data of sseData(stream, { timeoutMs: STREAM_IDLE_MS })) {
      const problem = upstreamError(data);
      if (problem) throw explain(problem);
      frames += 1;
      shape = shape ?? frameShape(data);
      text += extract(data);
    }
    // An empty answer is not a valid answer. Retry once without streaming so a
    // shape mismatch reads as recovered text instead of a blank card.
    if (!text && route === 'workers-ai') {
      text = await within(UPSTREAM_OPEN_MS, `workers-ai ${model}`, () =>
        cf.chat(env, {
          model,
          messages: system,
          images,
          temperature: preset?.temperature,
          maxTokens: budgetFor(preset, reported, pinned),
        }),
      );
    }
    if (!text) {
      return fail(
        502,
        'empty_upstream',
        `${route} (${model}) returned no text: ${describeEmpty(frames, shape)}.`,
      );
    }
    await recordReview(env, ctx, reviewOf({ preset, decision: reported, route, model, lastUser, text }));
    // Every answer becomes a candidate, so nothing has to be retyped to promote it.
    await recordCandidate(env, { input: question, answer: text, preset: preset?.id, route, model }, ctx);
    return json({ text, route, model, decision: reported });
  }

  const { route, model, stream, extract } = await openUpstream(env, {
    messages: system,
    images,
    preset,
    decision: reported,
    explicit: pinned,
    allowCloudflare: useCf,
    freeRouter: engine === 'openrouter',
  });

  const out = new ReadableStream({
    async start(controller) {
      const send = (chunk) => chunk && controller.enqueue(encoder.encode(chunk));
      // Declared outside the try: the review call after it still needs them.
      let emitted = 0;
      let answer = '';
      let frames = 0;
      let shape = null;
      try {
        send(meta({ route, model, preset: preset?.id, decision: reported }));
        for await (const data of sseData(stream, { timeoutMs: STREAM_IDLE_MS })) {
          const problem = upstreamError(data);
          if (problem) throw explain(problem);
          frames += 1;
          shape = shape ?? frameShape(data);
          const text = extract(data);
          if (text) {
            emitted += 1;
            answer += text;
            send(delta(text));
          }
        }
        if (!emitted && route === 'workers-ai') {
          const text = await within(UPSTREAM_OPEN_MS, `workers-ai ${model}`, () =>
            cf.chat(env, {
              model,
              messages: system,
              images,
              temperature: preset?.temperature,
              maxTokens: budgetFor(preset, reported, pinned),
            }),
          );
          if (text) {
            answer += text;
            send(delta(text));
          }
          else send(errorEvent('empty_upstream', `${model} returned no text: ${describeEmpty(frames, shape)}.`));
        } else if (!emitted) {
          send(errorEvent('empty_upstream', `${route} (${model}) returned no text.`));
        }
      } catch (err) {
        send(errorEvent(err?.code || 'stream_failed', err?.message || String(err)));
      }
      await recordReview(
        env,
        ctx,
        reviewOf({ preset, decision: reported, route, model, lastUser, text: answer }),
      );
      // Stored whether or not it is good: promotion is a later decision.
      await recordCandidate(env, { input: question, answer, preset: preset?.id, route, model }, ctx);
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
  const engine = await engineFor(env);
  const useCf = canUseCloudflare(env, engine);
  const gate = useCf ? await charge(env, clientIp(request), (seconds ? seconds / 60 : 1) * 46.63) : { ok: true };
  if (!gate.ok) {
    return fail(429, 'budget_exhausted', `Daily budget reached (${gate.used}/${gate.limit} neurons).`);
  }

  if (useCf) {
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

  const bucket = objects(env);
  if (bucket) {
    const hit = await bucket.get(key);
    if (hit) return audioResponse(hit.body, { source: 'r2' });
  }

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = cache ? new Request(url.toString(), { method: 'GET' }) : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const engine = await engineFor(env);
  const useCf = canUseCloudflare(env, engine);
  const gate = useCf
    ? await charge(env, clientIpFromUrl(url), Math.max(20, text.length / 6))
    : { ok: true };
  if (!gate.ok) {
    return fail(429, 'budget_exhausted', `Daily budget reached (${gate.used}/${gate.limit} neurons).`);
  }

  let speech;
  if (useCf) {
    speech = await cf.speech(env, { text, voice, lang: url.searchParams.get('lang') || 'en' });
  } else if (has(env, 'OPENROUTER_API_KEY')) {
    speech = await or.speech(env, { text, voice, model });
  } else {
    return fail(503, 'no_tts_engine', 'No TTS available: bind AI or set OPENROUTER_API_KEY.');
  }

  const bytes = speech.bytes || new Uint8Array(await new Response(speech.body).arrayBuffer());
  const response = audioResponse(bytes, { source: 'generated' });

  if (bucket && ctx?.waitUntil) ctx.waitUntil(bucket.put(key, bytes).catch(() => {}));
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
  const bucket = objects(env);
  if (!bucket) {
    return fail(503, 'no_storage', 'Uploads need the BUCKET R2 binding.');
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
  await bucket.put(`uploads/${id}`, bytes, { httpMetadata: { contentType } });
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
  const bucket = objects(env);
  if (!bucket) return new Response('Not found', { status: 404 });
  const object = await bucket.get(`uploads/${id}`);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  });
}
