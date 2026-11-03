import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from './src/index.js';
import { wrapWav, wavInfo, wavChunks } from './src/audio.js';
import { _resetBudget } from './src/budget.js';
import { LADDER, within, decide, _resetDecisionCache } from './src/decide.js';
import { upsertBody, upsertPath, syncPlan } from './src/preset-sync.js';
import { PRESETS, findPreset } from './src/presets.js';
import { stateKv, objects, bindingReport } from './src/bindings.js';
import {
  truthKey,
  resolveTruth,
  recordCandidate,
  promote,
  listCandidates,
  PROMOTE_AT,
} from './src/truth.js';
import { upstreamError, sseData, frameShape, fromWorkersAI } from './src/normalize.js';

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
  _resetDecisionCache();
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
  assert.ok(events[0].decision.trace.includes('rung:operator'));
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
        if (model === '@cf/cloudflare/clef-flash') return { response: '{"preset":"mnl"}' };
        seen.push({ model, system: body.messages?.[0]?.role });
        if (body.stream) return sse(['ok']);
        return { response: 'ok' };
      },
    }),
  });

  await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'operator', stream: false }),
  });

  const generation = seen.at(-1);
  // clef said mnl; the deliberate pick wins, model and prompt both.
  assert.equal(generation.model, '@cf/qwen/qwen3.8-27b');
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
  // user hands back, then the generation rung runs. Truth is the default when
  // the intent names no preset.
  assert.ok(trace.indexOf('user:handoff') < trace.indexOf('rung:truth'));
  assert.equal(body.decision.preset, 'truth');
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

test('sending the default preset still lets clef steer the rung', async () => {
  const env = makeEnv({
    AI: fakeAI({
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) return { response: '{"preset":"mnl"}' };
        if (body.stream) return sse(['steered']);
        return { response: 'steered' };
      },
    }),
  });

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'truth' }),
  });

  const events = await readSSE(res);
  // truth is the default rather than a choice, so the decision still routes.
  assert.equal(events[0].preset, 'mnl');
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'steered');
});

test('selecting no preset drops the preset prompt but keeps the decision', async () => {
  const seen = [];
  const env = makeEnv({
    AI: fakeAI({
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) return { response: '{"task":"transform","depth":"deep"}' };
        seen.push({ model, body });
        if (body.stream) return sse(['bare']);
        return { response: 'bare' };
      },
    }),
  });

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'none', stream: false }),
  });
  const body = await res.json();
  const generation = seen.at(-1);

  assert.equal(res.status, 200);
  assert.equal(body.decision.preset, null);
  // No preset prompt, but clef still decides the model and the budget.
  assert.equal(generation.model, '@cf/qwen/qwen3.8-27b');
  assert.equal(generation.body.messages.some((m) => m.role === 'system'), false);
  assert.equal(generation.body.max_tokens, 8192);
  assert.equal(body.text, 'bare');
});

test('no preset on the openrouter rung never sends a @preset/ slug', async () => {
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
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'none', stream: false }),
      },
    );
    await res.text();

    assert.equal(sent.model, 'google/gemini-2.5-flash');
    assert.equal(String(sent.model).startsWith('@preset/'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('the worker serves static assets when it has no API route', async () => {
  const env = makeEnv({ ASSETS: { fetch: async () => new Response('<h1>ai-Ncards</h1>') } });
  const res = await worker.fetch(new Request('https://example.com/'), env, ctx);
  assert.equal(await res.text(), '<h1>ai-Ncards</h1>');
});

// A stalled engine must fail as a named timeout, not as an empty card after a minute.
test('a stalled upstream stream is reported as a timeout', async () => {
  const stalled = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"response":"Hi"}\n\n'));
      // Deliberately never closes: this is the shape of a hung model.
    },
  });

  const seen = [];
  await assert.rejects(async () => {
    for await (const data of sseData(stalled, { timeoutMs: 30 })) seen.push(data);
  }, /stalled/i);

  assert.deepEqual(seen, ['{"response":"Hi"}']);
});

test('within rejects anything that never settles', async () => {
  await assert.rejects(() => within(20, 'some-model', () => new Promise(() => {})), /timed out after/);
});

test('within leaves a slow call that finishes in time alone', async () => {
  assert.equal(await within(200, 'some-model', async () => 'ok'), 'ok');
});

// Workers AI answers in either its native shape or an OpenAI-compatible one.
// Reading only the native one made a good answer look like an empty one.
test('extracts text from native and openai-shaped frames', () => {
  assert.equal(fromWorkersAI('{"response":"hi"}'), 'hi');
  assert.equal(fromWorkersAI('{"result":{"response":"hi"}}'), 'hi');
  assert.equal(fromWorkersAI('{"choices":[{"delta":{"content":"hi"}}]}'), 'hi');
  assert.equal(fromWorkersAI('{"choices":[{"message":{"content":"hi"}}]}'), 'hi');
  assert.equal(fromWorkersAI('{"choices":[{"text":"hi"}]}'), 'hi');
  assert.equal(fromWorkersAI('{"unexpected":true}'), '');
  assert.equal(fromWorkersAI('not json'), '');
});

test('frameShape names what arrived when no text was found', () => {
  assert.equal(frameShape('{"response":"hi"}'), 'response');
  assert.equal(frameShape('{"choices":[{"delta":{"content":"hi"}}]}'), 'choices');
  assert.equal(frameShape('not json'), null);
});

// KV reads are edge-cached and lag a fresh write by up to 60s, so a repeat of the
// same turn misses unless something sits in front of KV.
test('a repeat decision is served from memory while KV still reports nothing', async () => {
  const env = makeEnv({
    MEM: {
      async get() {
        return null; // the write is real, the read is still stale
      },
      async put() {},
    },
  });
  const messages = [{ role: 'user', content: 'explain the decision cache' }];

  const first = await decide(env, { messages });
  assert.equal(first.source, 'clef-flash');
  assert.ok(first.trace.includes('cache:miss'));

  const second = await decide(env, { messages });
  assert.equal(second.source, 'cache');
  assert.equal(second.cacheSource, 'memory');
  // The trace is this request's: a hit is one step, not a replay of the first
  // run's intent and browse stages.
  assert.deepEqual(second.trace, ['cache:hit']);
  assert.ok(second.cachedTrace.includes('intent:clef-flash'));
});

test('a KV hit is labelled as such and seeds the memory layer', async () => {
  const store = new Map();
  const kv = {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
  const messages = [{ role: 'user', content: 'seeded from kv' }];

  const warm = await decide(makeEnv({ MEM: kv }), { messages });
  assert.equal(warm.source, 'clef-flash');

  // A new env (a different isolate) shares the KV but starts with empty memory.
  const cold = await decide(makeEnv({ MEM: kv }), { messages });
  assert.equal(cold.source, 'cache');
  assert.equal(cold.cacheSource, 'kv');
  assert.equal(cold.preset, warm.preset);
});

test('the cache key follows the prompt, the images and the pinned preset', async () => {
  const store = new Map();
  const kv = {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
  const env = makeEnv({ MEM: kv });
  const a = await decide(env, { messages: [{ role: 'user', content: 'first' }] });
  const b = await decide(env, { messages: [{ role: 'user', content: 'second' }] });
  const c = await decide(env, { messages: [{ role: 'user', content: 'first' }], presetId: 'mnl' });
  assert.equal(new Set([a.cacheKey, b.cacheKey, c.cacheKey]).size, 3);
});

function kvStore() {
  const store = new Map();
  return {
    store,
    kv: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix = '', limit = 1000 } = {}) {
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
        return { keys: keys.map((name) => ({ name })), list_complete: true };
      },
    },
  };
}

test('the hit formula folds case, spacing and trailing punctuation', () => {
  assert.equal(truthKey('  What IS a  cache? '), 'what is a cache');
  assert.equal(truthKey('what is a cache'), 'what is a cache');
  assert.equal(truthKey("Who's asking?!"), 'whos asking');
  assert.equal(truthKey(''), '');
});

test('every answer becomes a candidate and a repeat raises its hits', async () => {
  const { kv } = kvStore();
  const env = { MEM: kv };
  const first = await recordCandidate(env, { input: 'What is a cache?', answer: 'A store.', preset: 'truth' });
  const second = await recordCandidate(env, { input: 'what is  a cache', answer: 'A store.', preset: 'truth' });

  assert.equal(first.hits, 1);
  assert.equal(second.hits, 2);
  assert.equal(first.id, second.id);
  assert.equal(second.suggested, PROMOTE_AT <= 2);

  const list = await listCandidates(env);
  assert.equal(list.length, 1);
  assert.equal(list[0].answer, 'A store.');
});

test('truth resolves master, then provisional, then the candidate', async () => {
  const { kv } = kvStore();
  const env = { MEM: kv };

  await recordCandidate(env, { input: 'what is truth', answer: 'generated' });
  assert.equal((await resolveTruth(env, 'what is truth')).layer, 'candidate');

  await promote(env, { input: 'what is truth', answer: 'provisional answer', layer: 'provisional' });
  assert.equal((await resolveTruth(env, 'what is truth')).layer, 'provisional');

  await promote(env, { input: 'What is truth?', answer: 'master answer', layer: 'master' });
  const hit = await resolveTruth(env, 'what is truth');
  assert.equal(hit.layer, 'master');
  assert.equal(hit.answer, 'master answer');
});

test('a pair stored under an opaque key name is found by that name', async () => {
  const { store, kv } = kvStore();
  const env = { MEM: kv };
  store.set('ranger1189', JSON.stringify({ query: 'ranger1189', answer: 'curated' }));

  const hit = await resolveTruth(env, 'ranger1189');
  assert.equal(hit.layer, 'master');
  assert.equal(hit.answer, 'curated');
});

test('a stored pair in another key shape and another field is still read', async () => {
  const { store, kv } = kvStore();
  const env = { MEM: kv };
  store.set('truth:master:what is truth', JSON.stringify({ html: '<p>hand written</p>' }));

  const hit = await resolveTruth(env, 'What is truth?');
  assert.equal(hit.layer, 'master');
  assert.equal(hit.answer, '<p>hand written</p>');
});

test('a second opinion never replaces the stored answer and is reported', async () => {
  const { kv } = kvStore();
  const notices = [];
  const waits = [];
  const env = {
    MEM: kv,
    ALERTS: {
      async fetch(request) {
        notices.push(await request.json());
        return { ok: true };
      },
    },
  };
  const waiter = { waitUntil(promise) { waits.push(promise); } };

  await recordCandidate(env, { input: 'what is truth', answer: 'first' }, waiter);
  const second = await recordCandidate(env, { input: 'what is truth', answer: 'second' }, waiter);
  await Promise.all(waits);

  assert.equal(second.answer, 'first');
  assert.equal(second.hits, 2);
  assert.equal(second.alternatives.length, 1);
  assert.equal(second.alternatives[0].answer, 'second');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, 'candidate_divergence');
  assert.equal(notices[0].existing, 'first');
});

test('promotion reports a clash instead of overwriting a truth', async () => {
  const { kv } = kvStore();
  const notices = [];
  const waits = [];
  const env = {
    MEM: kv,
    ALERTS: {
      async fetch(request) {
        notices.push(await request.json());
        return { ok: true };
      },
    },
  };
  const waiter = { waitUntil(promise) { waits.push(promise); } };

  const first = await promote(env, { input: 'who are you', answer: 'mind' }, waiter);
  const second = await promote(env, { input: 'who are you', answer: 'not mind' }, waiter);
  await Promise.all(waits);

  assert.equal(first.saved, true);
  assert.equal(second.saved, false);
  assert.equal(second.conflict, true);
  assert.equal((await resolveTruth(env, 'who are you')).answer, 'mind');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, 'promote_conflict');
});

test('a promoted truth answers the chat without calling a model', async () => {
  const { kv } = kvStore();
  let calls = 0;
  const env = makeEnv({
    MEM: kv,
    AI: {
      async run() {
        calls += 1;
        return sse(['model']);
      },
    },
  });
  await promote(env, { input: 'who are you', answer: 'mind', layer: 'master' });

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Who are you?' }] }),
  });
  const events = await readSSE(res);
  const text = events.filter((event) => event.type === 'delta').map((event) => event.text).join('');

  assert.equal(text, 'mind');
  assert.equal(events.find((event) => event.type === 'meta').route, 'truth');
  // clef never ran and no generation happened: the MEM hit ended it.
  assert.equal(calls, 0);
});

test('a generated answer is stored as a candidate', async () => {
  const { kv } = kvStore();
  const env = makeEnv({ MEM: kv });
  await (
    await call(env, '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello there' }] }),
    })
  ).text();

  const list = await listCandidates(env);
  assert.equal(list.length, 1);
  assert.equal(list[0].hits, 1);
  assert.equal(list[0].answer, 'Hello world');
});

test('the admin is gone: nothing over HTTP writes a truth', async () => {
  const env = makeEnv({ MEM: kvStore().kv, ADMIN_KEY: 'was-once-set' });
  const headers = { 'x-admin-key': 'was-once-set' };

  for (const [path, method] of [
    ['/api/admin/unlock', 'POST'],
    ['/api/truth/candidates', 'GET'],
    ['/api/truth/resolve', 'POST'],
    ['/api/truth/save', 'POST'],
  ]) {
    const res = await call(env, path, { method, headers });
    assert.equal(res.status, 404, `${method} ${path} must not exist`);
  }
});

test('candidates keep accumulating with no admin route at all', async () => {
  const { kv } = kvStore();
  const env = makeEnv({ MEM: kv });

  for (let i = 0; i < PROMOTE_AT; i += 1) {
    await (
      await call(env, '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'same question' }] }),
      })
    ).text();
  }

  const [candidate] = await listCandidates(env);
  assert.equal(candidate.hits, PROMOTE_AT);
  assert.equal(candidate.suggested, true);
});
