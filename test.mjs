import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from './src/index.js';
import { wrapWav, wavInfo, wavChunks } from './src/audio.js';
import { _resetBudget } from './src/budget.js';
import { LADDER } from './src/decide.js';
import { upsertBody, upsertPath, syncPlan } from './src/preset-sync.js';
import { PRESETS, findPreset } from './src/presets.js';
import { stateKv, objects, bindingReport } from './src/bindings.js';
import { upstreamError } from './src/normalize.js';

const ctx = { waitUntil() {}, passThroughOnException() {} };

function sse(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: chunk })}\n\n`));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function fakeAI(overrides = {}) {
  return {
    async run(model, body = {}) {
      if (model === '@cf/cloudflare/clef-flash') {
        return { response: JSON.stringify({ preset: 'operator', depth: 'deep', tone: 'precise' }) };
      }
      if (model.startsWith('@cf/openai/whisper')) return { text: `heard:${body.audio ? 'audio' : 'nothing'}` };
      if (model === '@cf/myshell-ai/melotts') return { audio: btoa('fake-mp3-bytes') };
      if (body.stream) return sse(['Hello', ' ', 'world']);
      return { response: 'Hello world' };
    },
    ...overrides,
  };
}

function makeEnv(over = {}) {
  _resetBudget();
  return { AI: fakeAI(), ...over };
}

async function call(env, path, init) {
  return worker.fetch(new Request(`https://example.com${path}`, init), env, ctx);
}

async function readSSE(response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((frame) => frame.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map((data) => (data === '[DONE]' ? '[DONE]' : JSON.parse(data)));
}

test('health reports which rungs and bindings are live', async () => {
  const res = await call(makeEnv(), '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, 'mind');
  assert.equal(body.engine.workersAI, true);
  assert.equal(body.engine.openrouterKey, false);
  assert.equal(body.bindings.kv.mem, false);
  assert.equal(body.bindings.r2.bucket, false);
  assert.equal(body.features.uploads, false);
  // Honest signal that the budget is per-isolate until MEM has an id.
  assert.equal(body.features.sharedBudget, false);
  assert.equal(body.features.chat, true);
});

test('presets never leak prompts or model slugs', async () => {
  const res = await call(makeEnv(), '/api/presets');
  const { presets } = await res.json();
  assert.equal(presets.length, 3);
  assert.deepEqual(presets.map((p) => p.id).sort(), ['mnl', 'operator', 'truth']);
  assert.deepEqual(Object.keys(presets[0]).sort(), ['id', 'name']);
});

test('chat streams meta, deltas and [DONE]', async () => {
  const res = await call(makeEnv(), '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const events = await readSSE(res);
  assert.equal(events[0].type, 'meta');
  assert.equal(events[0].route, 'workers-ai');
  // No preset pinned: clef's intent names the preset, and its task names the
  // model, so the rung follows the decision rather than the preset's own model.
  assert.equal(events[0].decision.preset, 'operator');
  assert.ok(events[0].decision.trace.includes('operator:operator'));
  assert.equal(events[0].model, '@cf/google/gemma-4-26b-a4b-it');

  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.equal(text, 'Hello world');
  assert.equal(events.at(-1), '[DONE]');
});

test('chat rejects an unknown preset instead of silently substituting', async () => {
  const res = await call(makeEnv(), '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: '@preset/nope' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'unknown_preset');
  assert.ok(body.error.available.includes('truth'));
});

test('chat requires messages', async () => {
  const res = await call(makeEnv(), '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'messages_required');
});

test('an explicit preset beats the decision model', async () => {
  const seen = [];
  const env = makeEnv({
    AI: fakeAI({
      async run(model, body = {}) {
        if (model === '@cf/cloudflare/clef-flash') return { response: '{"preset":"operator"}' };
        seen.push({ model, system: body.messages?.[0]?.role });
        if (body.stream) return sse(['ok']);
        return { response: 'ok' };
      },
    }),
  });

  await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'truth', stream: false }),
  });

  const generation = seen.at(-1);
  assert.equal(generation.model, '@cf/google/gemma-4-26b-a4b-it');
  assert.equal(generation.system, 'system');
});

test('decision ladder escalates when the smallest window refuses', async () => {
  const tried = [];
  const env = makeEnv({
    AI: {
      async run(model, body = {}) {
        tried.push(model);
        if (model === LADDER[0].id) throw new Error('context length exceeded');
        if (model === LADDER[1].id) return { response: '{"preset":"mnl","depth":"terse"}' };
        if (body.stream) return sse(['x']);
        return { response: 'x' };
      },
    },
  });

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });
  const body = await res.json();
  assert.equal(body.decision.preset, 'mnl');
  assert.equal(body.decision.source, 'clef-omni');
  assert.deepEqual(tried.slice(0, 2), [LADDER[0].id, LADDER[1].id]);
});

test('chat falls back to OpenRouter when the AI binding is absent', async () => {
  const original = globalThis.fetch;
  let called = '';
  globalThis.fetch = async (url) => {
    called = String(url);
    // OpenRouter dialect: choices[0].delta.content, not {"response": ...}
    const body = ['from', ' openrouter']
      .map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      .join('');
    return new Response(`${body}data: [DONE]\n\n`, { status: 200 });
  };

  try {
    const res = await call(
      { OPENROUTER_API_KEY: 'test-key' },
      '/api/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      },
    );
    const events = await readSSE(res);
    assert.equal(events[0].route, 'openrouter');
    assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'from openrouter');
    assert.match(called, /chat\/completions$/);
  } finally {
    globalThis.fetch = original;
  }
});

test('the openrouter rung references the preset and leaves its config alone', async () => {
  const original = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response('data: [DONE]\n\n', { status: 200 });
  };

  try {
    const res = await call(
      { OPENROUTER_API_KEY: 'test-key' },
      '/api/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'truth', stream: false }),
      },
    );
    await res.text();

    // Bare slugs are ignored upstream, so the @preset/ prefix is load-bearing.
    assert.equal(sent.model, '@preset/truth');
    // Request fields shallow-merge over the preset, so ours must be absent.
    assert.equal(sent.temperature, undefined);
    assert.equal(sent.max_tokens, undefined);
    assert.equal(sent.messages.some((m) => m.role === 'system'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('the workers-ai rung still uses the local prompt and sampling', async () => {
  const seen = [];
  const env = makeEnv({
    AI: fakeAI({
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) return { response: '{}' };
        seen.push(body);
        if (body.stream) return sse(['ok']);
        return { response: 'ok' };
      },
    }),
  });

  await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'truth', stream: false }),
  });

  const body = seen.at(-1);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /verified fact/);
  assert.equal(body.temperature, 0.1);
});

test('no engine at all is a 503, not a hang', async () => {
  const res = await call({}, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'no_engine');
});

test('budget exhaustion returns 429 with the ceiling named', async () => {
  const env = makeEnv({ DAILY_NEURONS: '10' });
  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'budget_exhausted');
});

test('stt transcribes an uploaded wav', async () => {
  const pcm = new Uint8Array(16000 * 2); // 1 s of silence at 16 kHz mono 16-bit
  const wav = wrapWav(pcm, { channels: 1, rate: 16000, bits: 16 });
  const res = await call(makeEnv(), '/api/stt', { method: 'POST', body: wav });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.engine, 'workers-ai');
  assert.equal(body.chunks, 1);
  assert.ok(body.text.startsWith('heard:'));
});

test('stt rejects an empty body', async () => {
  const res = await call(makeEnv(), '/api/stt', { method: 'POST', body: new Uint8Array() });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'audio_required');
});

test('wav parsing and chunking stay sample aligned', () => {
  const rate = 16000;
  const pcm = new Uint8Array(rate * 2 * 95); // 95 s
  const wav = wrapWav(pcm, { channels: 1, rate, bits: 16 });

  const info = wavInfo(wav);
  assert.equal(info.rate, rate);
  assert.equal(info.channels, 1);
  assert.equal(Math.round(info.seconds), 95);

  const chunks = wavChunks(wav, info, 30);
  assert.equal(chunks.length, 4);
  for (const chunk of chunks) {
    const parsed = wavInfo(chunk);
    assert.ok(parsed, 'every chunk must be a valid wav');
    assert.equal(parsed.rate, rate);
    assert.ok(parsed.dataLength % 2 === 0, 'must not split a 16-bit sample');
    assert.ok(parsed.seconds <= 30);
  }
});

test('tts returns playable audio with an immutable cache header', async () => {
  const res = await call(makeEnv(), '/api/tts?t=hello&v=&m=melotts');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.equal((await res.arrayBuffer()).byteLength, 'fake-mp3-bytes'.length);
});

test('tts rejects oversized text rather than truncating it silently', async () => {
  const res = await call(makeEnv(), `/api/tts?t=${'a'.repeat(2001)}`);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'text_too_long');
});

test('uploads are refused without R2 instead of failing open', async () => {
  const res = await call(makeEnv(), '/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'no_storage');
});

test('preset upserts send the prompt as a system message', () => {
  const body = upsertBody(findPreset('truth'), { model: 'openai/gpt-4o' });
  assert.equal(body.model, 'openai/gpt-4o');
  assert.equal(body.temperature, 0.1);
  // messages is ignored for storage, but a system message is extracted as system_prompt
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /verified fact/);
  // Not part of preset config, so it must not be sent
  assert.equal(body.max_tokens, undefined);
});

test('preset upserts refuse to invent a model', () => {
  const noModel = PRESETS.find((p) => !p.or && p.orPreset);
  assert.ok(noModel, 'expected a preset with a slug but no explicit model');
  assert.throws(() => upsertBody(noModel), /No OpenRouter model/);
});

test('the sync plan covers every slugged preset and skips local-only ones', () => {
  const plan = syncPlan({ model: 'openai/gpt-4o' });
  const slugged = PRESETS.filter((p) => p.orPreset);
  assert.equal(plan.length, slugged.length);
  assert.deepEqual(plan.map((item) => item.slug).sort(), ['mnl', 'operator', 'truth']);
  assert.equal(upsertPath('truth'), '/presets/truth/chat/completions');
});

test('stores resolve to the deployed names, with the generic ones as fallback', () => {
  assert.equal(stateKv({ MEM: 'memoria', KV: 'old' }), 'memoria');
  assert.equal(stateKv({ KV: 'old' }), 'old');
  assert.equal(stateKv({}), null);
  assert.equal(objects({ BUCKET: 'r2-explorer-bucket', R2: 'old' }), 'r2-explorer-bucket');
  assert.equal(objects({}), null);
});

test('health reports the deployment binding names', () => {
  const report = bindingReport({ AI: 1, ASSETS: 1, MEM: 1, BUCKET: 1, 'AGENT-BROWSING': 1 });
  assert.equal(report.kv.mem, true);
  assert.equal(report.kv.master, false);
  assert.equal(report.r2.bucket, true);
  assert.equal(report.services.agentBrowsing, true);
});

test('in-stream provider errors are detected instead of read as empty text', () => {
  assert.equal(upstreamError('{"error":"Model not found"}'), 'Model not found');
  assert.equal(upstreamError('{"error":{"message":"bad model"}}'), 'bad model');
  assert.equal(upstreamError('{"response":"ok"}'), null);
  assert.equal(upstreamError('[DONE]'), null);
  assert.equal(upstreamError('not json'), null);
});

test('a stream carrying an error frame surfaces it as an error event', async () => {
  const encoder = new TextEncoder();
  const env = makeEnv({
    AI: fakeAI({
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) return { response: '{}' };
        if (body.stream) {
          return new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"error":"Model not found"}\n\n'));
              controller.close();
            },
          });
        }
        return { response: 'should not be reached' };
      },
    }),
  });

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'truth' }),
  });

  const events = await readSSE(res);
  const failure = events.find((e) => e.type === 'error');
  assert.ok(failure, 'expected an error event, not a silent empty answer');
  assert.equal(failure.error.code, 'upstream_error');
  assert.match(failure.error.message, /Model not found/);
});

test('an empty stream retries without streaming instead of returning nothing', async () => {
  let streamed = 0;
  const encoder = new TextEncoder();
  const env = makeEnv({
    AI: fakeAI({
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) return { response: '{}' };
        if (body.stream) {
          streamed += 1;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
        }
        return { response: 'recovered' };
      },
    }),
  });

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'truth' }),
  });

  const events = await readSSE(res);
  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.equal(text, 'recovered');
  assert.equal(streamed, 1);
  assert.equal(events.some((e) => e.type === 'error'), false);
});

test('the pipeline traces cache, intent, browse, user and operator in order', async () => {
  const cached = [];
  const env = makeEnv({
    MEM: {
      async get() {
        return null;
      },
      async put(key, value) {
        cached.push(key);
      },
    },
    'AGENT-BROWSING': {
      async fetch() {
        return new Response('browsed material');
      },
    },
    AI: fakeAI({
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) return { response: '{"task":"extract","depth":"deep"}' };
        if (body.stream) return sse(['ok']);
        return { response: 'ok' };
      },
    }),
  });

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'compare these two' }], stream: false }),
  });
  const body = await res.json();
  const { trace } = body.decision;

  assert.equal(trace[0], 'cache:miss');
  assert.match(trace[1], /^intent:clef-/);
  // extract is browse-worthy, so the service binding is consulted.
  assert.ok(trace.includes('browse:ok'));
  assert.ok(trace.indexOf('browse:ok') < trace.indexOf('user:handoff'));
  // user hands back, then the operator rung generates.
  assert.ok(trace.indexOf('user:handoff') < trace.indexOf('operator:operator'));
  assert.equal(body.decision.preset, 'operator');
  assert.equal(body.decision.browse, 'browsed material');
  // extract -> qwen, deep -> large budget.
  assert.equal(body.model, '@cf/qwen/qwen3.8-27b');
  assert.ok(cached.some((key) => key.startsWith('decision:')), 'the decision should be cached in MEM');
});

test('a failing browse stage is recorded, not fatal', async () => {
  const env = makeEnv({
    'AGENT-BROWSING': {
      async fetch() {
        throw new Error('browser offline');
      },
    },
    AI: fakeAI({
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) return { response: '{"task":"compare"}' };
        if (body.stream) return sse(['still works']);
        return { response: 'still works' };
      },
    }),
  });

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.decision.trace.includes('browse:error'));
  assert.equal(body.text, 'still works');
});

test('review records are written to MASTER', async () => {
  const reviews = [];
  const env = makeEnv({
    MASTER: {
      async put(key, value) {
        reviews.push({ key, record: JSON.parse(value) });
      },
    },
  });

  const pending = [];
  const localCtx = { waitUntil(promise) { pending.push(promise); } };
  const res = await worker.fetch(
    new Request('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'remember this' }], stream: false }),
    }),
    env,
    localCtx,
  );

  assert.equal(res.status, 200);
  await Promise.all(pending);

  assert.equal(reviews.length, 1);
  assert.match(reviews[0].key, /^review:/);
  assert.equal(reviews[0].record.preset, 'operator');
  assert.equal(reviews[0].record.route, 'workers-ai');
  assert.equal(reviews[0].record.prompt, 'remember this');
});

test('clef decides the model and output budget when no preset is pinned', async () => {
  const seen = [];
  const env = makeEnv({
    AI: fakeAI({
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) return { response: '{"task":"transform","depth":"terse"}' };
        seen.push({ model, body });
        if (body.stream) return sse(['ok']);
        return { response: 'ok' };
      },
    }),
  });

  await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });

  const generation = seen.at(-1);
  assert.equal(generation.model, '@cf/qwen/qwen3.8-27b');
  assert.equal(generation.body.max_tokens, 1024);
});

test('the worker serves static assets when it has no API route', async () => {
  const env = makeEnv({ ASSETS: { fetch: async () => new Response('<h1>ai-Ncards</h1>') } });
  const res = await worker.fetch(new Request('https://example.com/'), env, ctx);
  assert.equal(await res.text(), '<h1>ai-Ncards</h1>');
});
