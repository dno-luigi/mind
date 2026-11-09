import { json, fail, has, options, b64FromBytes, bytesFromB64, clientIp, keyMatches } from './util.js';
import { charge } from './budget.js';
import { stateKv, objects, bindingReport, browserBinding } from './bindings.js';
import { engineFor, setEngineFor, canUseCloudflare } from './engine.js';
import {
  publicPresets,
  findPreset,
  openRouterBackedPresets,
  truthPromptInfo,
  DEFAULT_PRESET,
} from './presets.js';
import * as cf from './providers/workers-ai.js';
import * as or from './providers/openrouter.js';
import { decide, recordReview, within } from './decide.js';
import { recordCandidate, questionOf } from './truth.js';
import { adminUnlock, adminListKeys, adminReadKey, adminQueue } from './admin.js';
import { shot } from './shot.js';
import { wavInfo, wavChunks } from './audio.js';
import { extractText } from './extract.js';
import { sessionCookie, clearCookie, tokenFrom } from './cookie.js';
import {
  Sessions,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionsBinding,
  openSession,
  readSession,
  closeSession,
  tokenUser,
} from './sessions.js';

// Wrangler needs the Durable Object class exported from the entrypoint module.
export { Sessions };
import {
  DONE,
  delta,
  errorEvent,
  incompleteEvent,
  meta,
  sseData,
  upstreamError,
  finishReason,
  finishState,
  frameShape,
  fromOpenRouterChat,
  fromWorkersAI,
} from './normalize.js';

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
// A slow model can go quiet mid-answer for far longer than 15s; treating that as
// a stall killed the stream and left the card cut off wherever it got to.
const STREAM_IDLE_MS = 45000;
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
  // The shape the proxies' last rung posts; an alias of the same pipeline.
  if (path === '/api/generate' && method === 'POST') return generate(request, env, ctx);
  if (path === '/api/stt' && method === 'POST') return stt(request, env);
  if (path === '/api/tts' && method === 'GET') return tts(url, env, ctx);
  if (path === '/api/upload' && method === 'POST') return upload(request, env);
  if (path === '/api/engine' && method === 'GET') return engineView(env);
  if (path === '/api/engine' && method === 'POST') return switchEngine(request, env);
  // Login state lives in a Durable Object, one per user name.
  if (path === '/api/login' && method === 'POST') return loginRoute(request, env);
  if (path === '/api/logout' && method === 'POST') return logoutRoute(request, env);
  if (path === '/api/session' && method === 'GET') return sessionRoute(request, env);
  // Headless screenshots. Billed per browser-second, so one page, one shot, closed.
  if (path === '/api/shot' && method === 'GET') return shot(url, env, ctx);

  // The console reads the store; it still cannot write one. Every route below
  // needs ADMIN_KEY, and an unset key fails closed rather than open.
  if (path === '/api/admin/unlock' && method === 'POST') return adminUnlock(request, env);
  if (path === '/api/admin/keys' && method === 'GET') return adminListKeys(request, env, url);
  if (path === '/api/admin/key' && method === 'GET') return adminReadKey(request, env, url);
  if (path === '/api/admin/queue' && method === 'GET') return adminQueue(request, env, url);

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
    version: '1.3.1',
    engine: {
      workersAI: has(env, 'AI'),
      openrouterKey: has(env, 'OPENROUTER_API_KEY'),
      // The switch. "openrouter" means no Workers AI call is made at all.
      active: engine,
      cloudflare: useCf,
    },
    bindings: bindingReport(env),
    // Which prompt the Truth preset actually runs, and a hash of it: enough to
    // tell the store's text from the built-in copy without publishing either.
    truthPrompt: await truthPromptInfo(),
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
      screenshots: Boolean(browserBinding(env)),
      // Uploads are stored in R2; documents are read as text on the way in.
      documents: Boolean(bucket),
      // Login needs both the Durable Object and the shared password.
      login: Boolean(sessionsBinding(env)) && has(env, 'LOGIN_PASSWORD'),
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

/**
 * The engine switch changes how the app spends money, so an unset KEY fails
 * closed rather than open.
 */
function keyGate(request, env) {
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
  return null;
}

async function switchEngine(request, env) {
  // This is the one route that changes how the app spends money, so it is the
  // one route with a gate. An unset KEY fails closed rather than open.
  const denied = keyGate(request, env);
  if (denied) return denied;

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

/**
 * The output budget is a floor, not a ceiling. A "terse" classification used to
 * cap the answer at 1024 tokens whatever preset was in force, which cut long
 * reports off mid-sentence; depth may now widen an answer but never narrow it.
 */
// An ask that names a length cannot be answered by one stored sentence, however
// good that sentence is. Matched against the user's own words so a cache hit
// never stands in for a report.
const ASKS_FOR_LENGTH =
  /\b(?:essays?|reports?|articles?|dissertations?|theses|step[- ]by[- ]step|in detail|detailed|comprehensive|exhaustive|long[- ]form|blog posts?)\b|\b\d{1,4}\b[^.!?]{0,24}\b(?:paragraphs?|words?|bullets?|points?|steps?|sentences?|pages?|sections?|items?|lines?)\b|\b(?:two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty)\b[^.!?]{0,12}\b(?:paragraphs?|words?|bullets?|points?|steps?|sentences?|pages?|sections?|items?)\b/i;

function budgetFor(preset, decision) {
  const depth = DEPTH_TOKENS[decision?.depth] ?? 0;
  const cap = preset?.maxTokens ?? 0;
  return Math.max(depth, cap) || null;
}

/** An ask that names a length gets a long-answer budget whatever the preset says. */
function budgetForAsk(preset, decision, ask) {
  const budget = budgetFor(preset, decision);
  if (!ASKS_FOR_LENGTH.test(String(ask || ''))) return budget;
  return Math.max(budget ?? 0, DEPTH_TOKENS.deep);
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
  { messages, images, preset, decision, explicit, allowCloudflare = true, freeRouter = false, ask = '' },
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
          maxTokens: budgetForAsk(preset, decision, ask),
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
    // A prompt that came from the secret store is the single source of truth, so
    // it travels with the request and overrides the preset's own system turn.
    // OpenRouter shallow-merges messages over the preset, which is exactly the
    // intent here; the preset still supplies the model and sampling params.
    // Prompts written for one provider keep the old behaviour and are stripped.
    const ownPrompt = usesPreset && preset?.systemFrom === 'code' && preset?.system;
    const base =
      usesPreset && !ownPrompt ? messages.filter((message) => message.role !== 'system') : messages;
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

/**
 * Stage 3 is material, not decoration: whatever the browser found becomes its own
 * system turn, ahead of the question. Without this the browse stage ran, logged
 * `browse:ok`, and the model answered as if it had never happened.
 */
function withBrowse(messages, decision) {
  const material = typeof decision?.browse === 'string' ? decision.browse.trim() : '';
  if (!material) return messages;

  const note = {
    role: 'system',
    content: `Browsing material gathered for this request. Use it as the source for the answer and cite any URLs it contains:\n\n${material}`,
  };
  let at = 0;
  while (at < messages.length && messages[at].role === 'system') at += 1;
  return [...messages.slice(0, at), note, ...messages.slice(at)];
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

/**
 * POST /api/generate {prompt|messages, stream}.
 *
 * orproxy and ai-proxy fall back to this route when their own rungs fail, and a
 * 404 here is the `mind error: 404` in their error chain. It is an alias, not a
 * second generator: the body is rewritten into the chat contract and handed to
 * the same pipeline, so the truth cache, the presets, the store prompt and the
 * stream protocol all behave exactly as they do on /api/chat.
 */
async function generate(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return fail(400, 'body_required', 'Send { prompt | messages, stream }.');
  }

  const supplied = Array.isArray(body.messages) ? body.messages : [];
  // `prompt` is the proxy's name for a single user turn; `input` is its older one.
  const prompt = [body.prompt, body.input].find((value) => typeof value === 'string' && value.trim());
  const messages = supplied.length ? supplied : prompt ? [{ role: 'user', content: prompt }] : [];
  if (!messages.length) {
    return fail(400, 'prompt_required', 'Send a non-empty prompt, or messages: [{ role, content }].');
  }

  // The caller's address still decides the budget, so it is carried across; the
  // body is replaced, which is the only thing this alias rewrites.
  const headers = new Headers({ 'content-type': 'application/json' });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('cf-connecting-ip', ip);

  const rewritten = new Request(new URL('/api/chat', request.url).toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages,
      preset: body.preset,
      presetLocked: body.presetLocked === true || body.presetsLocked === true,
      stream: body.stream,
    }),
  });
  return chat(rewritten, env, ctx);
}

/** The protocol's own end-of-answer signals: the sentinel frame or a finish_reason. */
const isTerminal = (data) => data === '[DONE]' || Boolean(finishReason(data));

/**
 * The only truncation this app can see without a protocol marker is text that
 * stops inside a word — the observed failures ended at "scheduling a new" and
 * "08/26/202". A letter or digit as the last character is that signature; a
 * closing bracket, quote, period or markdown marker is not.
 */
function endsMidWord(text) {
  return /[\p{L}\p{N}]$/u.test(String(text || '').trimEnd());
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

  // A preset picked from the menu wins, truth included — the client marks those
  // with presetLocked. Truth is also the fallback prompt, so an *unlocked* truth
  // must not outrank the decision or clef could never route.
  const pinned =
    Boolean(requestedPreset) &&
    (requestedPreset.id !== DEFAULT_PRESET || body.presetLocked === true);

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
  const chosen = noneSelected
    ? null
    : pinned
      ? requestedPreset
      : (decision.preset && findPreset(decision.preset)) || requestedPreset || findPreset(DEFAULT_PRESET);
  // Every preset carries its own prompt from src/prompts, so a served truth and a
  // generated one see the same text and no store can substitute another.
  const preset = chosen;

  // Report the preset that actually ran, not the one the decision model named:
  // they diverge whenever it suggests a preset that no longer exists.
  const reported = { ...decision, preset: preset?.id ?? null };
  const wantsStream = body.stream !== false;

  // A curated (master) truth answers in place of the model, and instantly. A
  // provisional one is the truth service's own guess kept on the way past: still
  // a cache hit worth serving, but only when the ask is small enough for one
  // stored sentence to answer it. An ask that names a length, or one clef
  // classified deep, goes to the model, so a report is never replaced by a
  // one-liner. A preset picked from the menu also means "generate".
  const briefAsk = decision.depth !== 'deep' && !ASKS_FOR_LENGTH.test(lastUser);
  const cachedTruth = decision.truth?.answer && (decision.truth.layer === 'master' || briefAsk);
  // Picking Truth from the menu means "answer with the truth preset", and a
  // stored truth is that preset's answer - so the cache still serves. Picking
  // any other preset means generate with it, cache or no cache.
  const mayServeCache = !pinned || preset?.id === DEFAULT_PRESET;
  if (cachedTruth && mayServeCache) {
    const truth = decision.truth;
    // A candidate is the answer this question got last time. Serving it is what
    // makes a repeat free, so the repetition promotion counts has to be recorded
    // here: a served candidate never runs the write at the end of the turn, and
    // without this a question answered forever could never reach PROMOTE_AT.
    if (truth.layer === 'candidate') {
      await recordCandidate(
        env,
        {
          input: question,
          answer: truth.answer,
          preset: preset?.id,
          route: truth.route || 'truth',
          model: truth.model || 'candidate',
        },
        ctx,
      );
    }
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
  const grounded = withBrowse(system, decision);

  if (!wantsStream) {
    const { route, model, stream, extract } = await openUpstream(env, {
    ask: lastUser,
      messages: grounded,
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
    let sawTerminal = false;
    let cutReason = null;
    for await (const data of sseData(stream, { timeoutMs: STREAM_IDLE_MS })) {
      const problem = upstreamError(data);
      if (problem) throw explain(problem);
      if (isTerminal(data)) sawTerminal = true;
      if (finishState(data) === 'cut') cutReason = finishReason(data);
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
          messages: grounded,
          images,
          temperature: preset?.temperature,
          maxTokens: budgetForAsk(preset, reported, lastUser),
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
    // Text is not the same thing as a finished answer. A stream that closed
    // mid-word used to return 200 carrying half a report, which is how a
    // truncated audit reached its caller looking like a completed one. The
    // partial text is still handed back, under an error, so it can be read
    // without being trusted.
    // A length cut is the provider's own admission, so it outranks how the text
    // happens to end: a report cut at the ceiling can still stop at a full stop.
    if (cutReason) {
      return fail(
        502,
        'output_truncated',
        `${route} (${model}) stopped at its ${cutReason} limit after ${text.length} characters; the text is a prefix, not an answer.`,
        { partial: text, finishReason: cutReason },
      );
    }
    if (!sawTerminal && endsMidWord(text)) {
      return fail(
        502,
        'stream_incomplete',
        `${route} (${model}) closed the stream mid-answer after ${text.length} characters; the text is not a complete answer.`,
        { partial: text },
      );
    }
    await recordReview(env, ctx, reviewOf({ preset, decision: reported, route, model, lastUser, text }));
    // Every answer becomes a candidate, so nothing has to be retyped to promote it.
    await recordCandidate(env, { input: question, answer: text, preset: preset?.id, route, model }, ctx);
    return json({ text, route, model, decision: reported });
  }

  const { route, model, stream, extract } = await openUpstream(env, {
    ask: lastUser,
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
      let sawTerminal = false;
      let cutReason = null;
      try {
        send(meta({ route, model, preset: preset?.id, decision: reported }));
        for await (const data of sseData(stream, { timeoutMs: STREAM_IDLE_MS })) {
          const problem = upstreamError(data);
          if (problem) throw explain(problem);
          if (isTerminal(data)) sawTerminal = true;
          if (finishState(data) === 'cut') cutReason = finishReason(data);
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
              messages: grounded,
              images,
              temperature: preset?.temperature,
              maxTokens: budgetForAsk(preset, reported, lastUser),
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
        // The deltas are already on the wire, so this cannot become an HTTP
        // error; it is the stream admitting the answer stopped mid-thought.
        // The provider's `length` wins over the text heuristic because a prefix
        // can end on a full stop and still be a prefix.
        if (emitted && cutReason) {
          send(
            incompleteEvent({
              code: 'output_truncated',
              message: `${route} (${model}) stopped at its ${cutReason} limit after ${answer.length} characters. The text above is a prefix, not a complete answer.`,
              reason: cutReason,
              chars: answer.length,
            }),
          );
        } else if (emitted && !sawTerminal && endsMidWord(answer)) {
          send(
            incompleteEvent({
              code: 'stream_incomplete',
              message: `${route} (${model}) closed the stream mid-answer after ${answer.length} characters. The text above is not a complete answer.`,
              chars: answer.length,
            }),
          );
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

/**
 * A session is a cookie, or a bearer for anything that is not a browser. The
 * token names the account it belongs to, so the right object is asked directly.
 */
async function sessionRoute(request, env) {
  const token = tokenFrom(request, SESSION_COOKIE);
  const user = token ? tokenUser(token) : null;
  if (!token || !user) return json({ ok: true, user: null });

  const session = await readSession(env, token).catch(() => null);
  return json({
    ok: true,
    user: session ? user : null,
    expiresAt: session?.expiresAt ?? null,
    store: Boolean(sessionsBinding(env)),
  });
}

/**
 * One shared password gates every name, and the name is what the Durable Object
 * namespaces. Per-user passwords would replace the comparison below, not the
 * session plumbing.
 */
async function loginRoute(request, env) {
  const body = await request.json().catch(() => null);
  const user = String(body?.user || '')
    .trim()
    .toLowerCase()
    .slice(0, 64);
  const password = String(body?.password || '');

  if (!user || !password) return fail(400, 'credentials_required', 'Send { user, password }.');
  if (!/^[\w .@-]{1,64}$/.test(user)) {
    return fail(400, 'bad_user', 'Names may use letters, numbers, spaces and . _ @ -');
  }

  const expected = String(env?.LOGIN_PASSWORD || '');
  if (!expected) {
    return fail(
      503,
      'login_unset',
      'Set the LOGIN_PASSWORD secret (wrangler secret put LOGIN_PASSWORD) before anyone can sign in.',
    );
  }
  if (!sessionsBinding(env)) {
    return fail(503, 'no_sessions', 'The SESSIONS Durable Object binding is missing from wrangler.jsonc.');
  }
  if (!keyMatches(expected, password)) {
    return fail(401, 'bad_login', 'Wrong name or password.');
  }

  const session = await openSession(env, user, { ttl: SESSION_TTL_MS });
  if (!session) return fail(503, 'no_sessions', 'The session store did not answer.');

  const secure = new URL(request.url).protocol === 'https:';
  return json(
    { ok: true, user, expiresAt: session.expiresAt },
    {
      headers: {
        'set-cookie': sessionCookie(SESSION_COOKIE, session.token, {
          maxAge: Math.floor(SESSION_TTL_MS / 1000),
          secure,
        }),
      },
    },
  );
}

async function logoutRoute(request, env) {
  const token = tokenFrom(request, SESSION_COOKIE);
  if (token) await closeSession(env, token).catch(() => {});
  const secure = new URL(request.url).protocol === 'https:';
  return json(
    { ok: true, user: null },
    { headers: { 'set-cookie': clearCookie(SESSION_COOKIE, { secure }) } },
  );
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
  const contentType = (request.headers.get('content-type') || 'application/octet-stream')
    .split(';')[0]
    .trim()
    .toLowerCase();
  // Pictures go to a vision model as pictures; documents are turned into text
  // on the way in, because a model cannot look inside a PDF.
  // Anything the paperclip can offer. Pictures, audio and video are stored and
  // linked; PDF, Word, Excel and slides are turned into text; an unknown binary
  // is stored with no text rather than rejected, because "other files" is the
  // point of the attach button.
  const allowed =
    /^(image\/|audio\/|video\/|text\/|application\/(pdf|json|xml|rtf|zip|octet-stream|x-yaml|yaml|javascript|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)))/;
  if (!allowed.test(contentType)) {
    return fail(415, 'unsupported_type', `Unsupported content type: ${contentType}`);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return fail(400, 'empty_body', 'Upload was empty.');
  if (bytes.length > MAX_AUDIO_BYTES) return fail(413, 'file_too_large', 'Files must be under 12 MB.');

  const digest = await sha256Key(`${contentType}:${bytes.length}:${Date.now()}`);
  const id = `${digest.slice(0, 32)}${extensionFor(contentType)}`;
  await bucket.put(`uploads/${id}`, bytes, { httpMetadata: { contentType } });

  // Extraction happens once, here: the client sends the text with the prompt, so
  // a 40-page PDF costs one decode rather than one per turn.
  const extracted = await extractText(bytes, contentType).catch(() => null);
  const text = String(extracted?.text || '');

  return json({
    id,
    url: `/f/${id}`,
    contentType,
    size: bytes.length,
    kind: extracted?.kind || 'binary',
    chars: text.length,
    text: text.length > 20000 ? text.slice(0, 20000) : text,
    note: extracted?.note,
  });
}

function extensionFor(contentType) {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('markdown')) return '.md';
  if (contentType.includes('csv')) return '.csv';
  if (contentType.includes('plain')) return '.txt';
  if (contentType.includes('json')) return '.json';
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
