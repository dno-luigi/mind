import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from './src/index.js';
import { wrapWav, wavInfo, wavChunks } from './src/audio.js';
import { _resetBudget } from './src/budget.js';
import { _resetEngine } from './src/engine.js';
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
import { questionOf } from './src/truth.js';
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
  // The engine switch is cached per isolate; a test that flips it must not turn
  // Cloudflare off for every test after it.
  _resetEngine();
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

test('the bound truth worker answers the first cache check', async () => {
  const { kv } = kvStore();
  const paths = [];
  const env = {
    MEM: kv,
    TRUTH: {
      async fetch(request) {
        paths.push(new URL(request.url).pathname);
        return new Response(
          JSON.stringify({
            status: 'ok',
            layer: 'master',
            id: 'curated-id',
            query: 'ranger1189',
            answer: 'from the console',
            source: 'master_truth',
            verified: true,
            provisional: false,
            meta: { confidence: 0.97, citations: [{ title: 'Source', url: 'https://example.com' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  };

  const hit = await resolveTruth(env, 'ranger1189');
  assert.equal(hit.layer, 'master');
  assert.equal(hit.answer, 'from the console');
  assert.equal(hit.id, 'curated-id');
  assert.equal(hit.citations.length, 1);
  assert.equal(hit.source, 'truth-service');
  assert.deepEqual(paths, ['/api/truth/resolve']);
});

test('a truth worker that misses or fails falls through to the local store', async () => {
  const { kv } = kvStore();

  const missing = {
    MEM: kv,
    TRUTH: {
      async fetch() {
        return new Response(
          JSON.stringify({
            status: 'miss',
            layer: 'none',
            answer: null,
            meta: { reason: 'no_master_or_provisional' },
          }),
          { status: 200 },
        );
      },
    },
  };
  await promote(missing, { input: 'who are you', answer: 'mind' });
  const hit = await resolveTruth(missing, 'who are you');
  assert.equal(hit.layer, 'master');
  assert.equal(hit.answer, 'mind');

  const broken = {
    MEM: kv,
    TRUTH: {
      async fetch() {
        throw new Error('down');
      },
    },
  };
  const fallback = await resolveTruth(broken, 'who are you');
  assert.equal(fallback.answer, 'mind');
});

test('the question is lifted out of the prompt that carries it', () => {
  assert.equal(questionOf('You are a helpful assistant.\n\nUser: ranger1185'), 'ranger1185');
  assert.equal(questionOf('ranger1185'), 'ranger1185');
  assert.equal(questionOf(''), '');
});

test('step 0 gets a second attempt after a failure', async () => {
  const { kv } = kvStore();
  let calls = 0;
  const env = {
    MEM: kv,
    TRUTH: {
      async fetch() {
        calls += 1;
        if (calls === 1) throw new Error('cold start');
        return new Response(
          JSON.stringify({ status: 'ok', layer: 'master', id: 'k', answer: 'second try', meta: { citations: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  };

  const hit = await resolveTruth(env, 'ranger1185');
  assert.equal(calls, 2);
  assert.equal(hit.answer, 'second try');
});

test('a clean miss is not retried', async () => {
  const { kv } = kvStore();
  let calls = 0;
  const env = {
    MEM: kv,
    TRUTH: {
      async fetch() {
        calls += 1;
        return new Response(
          JSON.stringify({ status: 'miss', layer: 'none', answer: null }),
          { status: 200 },
        );
      },
    },
  };

  const hit = await resolveTruth(env, 'nobody home');
  assert.equal(calls, 1);
  assert.equal(hit.layer, 'none');
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

const ADMIN_KEY = 'console-secret';
const adminHeaders = { 'x-admin-key': ADMIN_KEY };

function pagedKv(entries, pageSize = 2) {
  const store = new Map(entries);
  return {
    store,
    kv: {
      async get(key) { return store.get(key) ?? null; },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
      async list({ prefix = '', limit = 1000, cursor } = {}) {
        const all = [...store.keys()].filter((k) => k.startsWith(prefix));
        const start = Number.parseInt(cursor || '0', 10) || 0;
        const size = Math.min(limit, pageSize);
        const keys = all.slice(start, start + size).map((name) => ({ name }));
        const next = start + size;
        return next < all.length
          ? { keys, list_complete: false, cursor: String(next) }
          : { keys, list_complete: true };
      },
    },
  };
}

const ADMIN_ROUTES = [
  ['/api/admin/unlock', 'POST'],
  ['/api/admin/keys', 'GET'],
  ['/api/admin/key?name=x', 'GET'],
];

test('the console is locked without ADMIN_KEY', async () => {
  const { kv } = kvStore();

  // Unset fails closed: the console would otherwise hand out the whole store.
  const unset = makeEnv({ MEM: kv });
  for (const [path, method] of ADMIN_ROUTES) {
    const res = await call(unset, path, { method, headers: adminHeaders });
    assert.equal(res.status, 503, method + ' ' + path + ' must fail closed');
    assert.equal((await res.json()).error.code, 'admin_key_unset');
  }

  const env = makeEnv({ MEM: kv, ADMIN_KEY });
  for (const [path, method] of ADMIN_ROUTES) {
    const anon = await call(env, path, { method });
    assert.equal(anon.status, 401, method + ' ' + path + ' must need the key');
    assert.equal((await anon.json()).error.code, 'admin_key_required');

    const wrong = await call(env, path, { method, headers: { 'x-admin-key': 'not-the-key' } });
    assert.equal(wrong.status, 401);
  }
});

test('the key unlocks the console and names the stores', async () => {
  const env = makeEnv({ MEM: kvStore().kv, MASTER: kvStore().kv, ADMIN_KEY });

  const res = await call(env, '/api/admin/unlock', { method: 'POST', headers: adminHeaders });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.stores, ['MASTER', 'MEM']);
  assert.equal(body.limit, 200);

  // Only MEM bound is still one store, not the same one listed twice.
  const single = await (
    await call(makeEnv({ MEM: kvStore().kv, ADMIN_KEY }), '/api/admin/unlock', { method: 'POST', headers: adminHeaders })
  ).json();
  assert.deepEqual(single.stores, ['MEM']);

  const bearer = await call(env, '/api/admin/unlock', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ADMIN_KEY },
  });
  assert.equal(bearer.status, 200);
});

test('the console lists stored pairs with their question and a preview', async () => {
  const { kv, store } = kvStore();
  store.set('candidate:abc', JSON.stringify({ query: 'what is a cache', answer: 'A store of answers.', hits: 3 }));
  store.set('truth:master:def', JSON.stringify({ query: 'who are you', answer: 'mind' }));
  store.set('settings:engine', JSON.stringify({ cloudflare: false }));
  const env = makeEnv({ MEM: kv, ADMIN_KEY });

  const res = await call(env, '/api/admin/keys?store=MEM', { method: 'GET', headers: adminHeaders });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.done, true);
  assert.equal(body.cursor, null);
  const byKey = Object.fromEntries(body.rows.map((row) => [row.key, row]));

  // A key name alone cannot be curated, so the row carries what it answers.
  assert.equal(byKey['candidate:abc'].question, 'what is a cache');
  assert.equal(byKey['candidate:abc'].preview, 'A store of answers.');
  assert.equal(byKey['candidate:abc'].kind, 'candidate');
  assert.equal(byKey['candidate:abc'].chars, 'A store of answers.'.length);
  assert.equal(byKey['candidate:abc'].hits, 3);
  assert.equal(byKey['truth:master:def'].kind, 'master');
  // A record with no answer field still lists, by its own key.
  assert.equal(byKey['settings:engine'].question, 'settings:engine');
  assert.equal(byKey['settings:engine'].chars, 0);

  const filtered = await (
    await call(env, '/api/admin/keys?store=MEM&q=candidate', { headers: adminHeaders })
  ).json();
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].key, 'candidate:abc');

  const unknown = await call(env, '/api/admin/keys?store=NOPE', { headers: adminHeaders });
  assert.equal(unknown.status, 404);
});

test('the console reads one key in full', async () => {
  const { kv, store } = kvStore();
  const raw = JSON.stringify({ query: 'who are you', answer: 'mind', citations: [] });
  store.set('truth:master:def', raw);
  const env = makeEnv({ MEM: kv, ADMIN_KEY });

  const res = await call(env, '/api/admin/key?store=MEM&name=truth%3Amaster%3Adef', {
    headers: adminHeaders,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.value.answer, 'mind');
  assert.match(body.raw, /who are you/);
  assert.equal(body.chars, raw.length);
  assert.equal(body.truncated, false);

  assert.equal((await call(env, '/api/admin/key?store=MEM&name=nope', { headers: adminHeaders })).status, 404);
  assert.equal((await call(env, '/api/admin/key?store=MEM', { headers: adminHeaders })).status, 400);
});

test('the console pages through a store larger than one page', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => [
    'candidate:k' + i,
    JSON.stringify({ query: 'q' + i, answer: 'a' + i }),
  ]);
  const { kv } = pagedKv(entries, 2);
  const env = makeEnv({ MEM: kv, ADMIN_KEY });

  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const qs = 'store=MEM&limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const res = await call(env, '/api/admin/keys?' + qs, { headers: adminHeaders });
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const row of body.rows) {
      assert.ok(!seen.has(row.key), row.key + ' must not repeat across pages');
      seen.add(row.key);
    }
    cursor = body.cursor;
    pages += 1;
    if (body.done) break;
    assert.ok(cursor, 'a page that is not done names the next cursor');
    assert.ok(pages < 10, 'paging must terminate');
  } while (true);

  assert.equal(seen.size, 5);
  assert.equal(pages, 3);
});

test('nothing over HTTP can still write a truth', async () => {
  const env = makeEnv({ MEM: kvStore().kv, ADMIN_KEY });
  for (const [path, method] of [
    ['/api/truth/save', 'POST'],
    ['/api/truth/candidates', 'GET'],
    ['/api/truth/resolve', 'POST'],
    ['/api/admin/save', 'POST'],
    ['/api/admin/put', 'POST'],
  ]) {
    const res = await call(env, path, { method, headers: adminHeaders });
    assert.equal(res.status, 404, method + ' ' + path + ' must not exist');
  }
});

test('candidates keep accumulating with no write route at all', async () => {
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


const ENGINE_KEY = 'engine-secret';

async function flip(env, cloudflare, headers = {}) {
  return call(env, '/api/engine', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ cloudflare }),
  });
}

const keyed = { 'x-engine-key': ENGINE_KEY };

test('the engine switch defaults to Cloudflare and reads without a key', async () => {
  const { kv } = kvStore();
  _resetEngine();
  const res = await call(makeEnv({ MEM: kv, KEY: ENGINE_KEY }), '/api/engine');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.engine, 'cloudflare');
  assert.equal(body.cloudflare, true);
  assert.equal(body.bound.store, true);
});

test('writing the switch needs the KEY', async () => {
  const { kv } = kvStore();
  _resetEngine();
  const env = makeEnv({ MEM: kv, KEY: ENGINE_KEY, OPENROUTER_API_KEY: 'test-key' });

  const anon = await flip(env, false);
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error.code, 'key_required');

  const wrong = await flip(env, false, { 'x-engine-key': 'wrong-key-here' });
  assert.equal(wrong.status, 401);

  // A refused write must not move the switch.
  const view = await (await call(env, '/api/engine')).json();
  assert.equal(view.cloudflare, true);

  // The bearer form works too, so curl stays usable.
  const ok = await flip(env, false, { authorization: `Bearer ${ENGINE_KEY}` });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).engine, 'openrouter');
});

test('the switch fails closed when KEY is unset', async () => {
  const { kv } = kvStore();
  _resetEngine();
  const env = makeEnv({ MEM: kv, OPENROUTER_API_KEY: 'test-key' });
  const res = await flip(env, false, keyed);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'key_unset');

  const view = await (await call(env, '/api/engine')).json();
  assert.equal(view.cloudflare, true);
});

test('switching Cloudflare off sends chat to the free router', async () => {
  const { kv, store } = kvStore();
  _resetEngine();
  let aiCalls = 0;
  const env = makeEnv({
    MEM: kv,
    KEY: ENGINE_KEY,
    OPENROUTER_API_KEY: 'test-key',
    AI: {
      async run() {
        aiCalls += 1;
        return { response: 'from workers ai' };
      },
    },
  });

  const off = await flip(env, false, keyed);
  assert.equal(off.status, 200);
  assert.equal((await off.json()).engine, 'openrouter');
  assert.match(store.get('settings:engine'), /"cloudflare":false/);

  const original = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(
      'data: {"choices":[{"delta":{"content":"free answer"}}]}\n\ndata: [DONE]\n\n',
      { status: 200 },
    );
  };
  try {
    const res = await call(env, '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], preset: 'truth' }),
    });
    const events = await readSSE(res);
    assert.equal(events[0].route, 'openrouter');
    assert.equal(events[0].model, 'openrouter/free');
    assert.equal(sent.model, 'openrouter/free');
    // A preset reference would point at the paid preset; the local prompt is sent
    // instead so the answer keeps the preset's character.
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.temperature, 0.1);
    // Neither clef nor the chat rung may touch Workers AI while it is off.
    assert.equal(aiCalls, 0);
    assert.ok(events[0].decision.trace.includes('intent:fallback'));
    assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'free answer');
  } finally {
    globalThis.fetch = original;
  }

  const health = await (await call(env, '/api/health')).json();
  assert.equal(health.engine.active, 'openrouter');
  assert.equal(health.engine.cloudflare, false);
  assert.equal(health.engine.workersAI, true);
  assert.equal(health.models.openrouterFree, 'openrouter/free');
});

test('the truth cache still answers first with Cloudflare off', async () => {
  const { kv, store } = kvStore();
  _resetEngine();
  store.set('truth:master:hi', JSON.stringify({ query: 'hi', answer: 'curated answer' }));

  const env = makeEnv({ MEM: kv, KEY: ENGINE_KEY, OPENROUTER_API_KEY: 'test-key' });
  await flip(env, false, keyed);

  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response('{}', { status: 200 });
  };
  try {
    const res = await call(env, '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const events = await readSSE(res);
    assert.equal(events[0].route, 'truth');
    assert.equal(
      events.filter((e) => e.type === 'delta').map((e) => e.text).join(''),
      'curated answer',
    );
    // Cache before model: nothing reached OpenRouter at all.
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('switching Cloudflare back on restores the Workers AI rung', async () => {
  const { kv } = kvStore();
  _resetEngine();
  let aiCalls = 0;
  const env = makeEnv({
    MEM: kv,
    KEY: ENGINE_KEY,
    OPENROUTER_API_KEY: 'test-key',
    AI: {
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) return { response: '{}' };
        aiCalls += 1;
        return body.stream ? sse(['from cf']) : { response: 'from cf' };
      },
    },
  });

  const on = await flip(env, true, keyed);
  assert.equal((await on.json()).engine, 'cloudflare');

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  const events = await readSSE(res);
  assert.equal(events[0].route, 'workers-ai');
  assert.ok(aiCalls > 0);
});

test('stt follows the switch to OpenRouter', async () => {
  const { kv } = kvStore();
  _resetEngine();
  let aiCalls = 0;
  const env = makeEnv({
    MEM: kv,
    KEY: ENGINE_KEY,
    OPENROUTER_API_KEY: 'test-key',
    AI: {
      async run() {
        aiCalls += 1;
        return { text: 'from workers ai' };
      },
    },
  });
  await flip(env, false, keyed);

  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ text: 'from openrouter' }), { status: 200 });
  try {
    const pcm = new Uint8Array(16000 * 2);
    const wav = wrapWav(pcm, { channels: 1, rate: 16000, bits: 16 });
    const res = await call(env, '/api/stt', { method: 'POST', body: wav });
    const body = await res.json();
    assert.equal(body.engine, 'openrouter');
    assert.equal(body.text, 'from openrouter');
    assert.equal(aiCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('tts follows the switch to OpenRouter', async () => {
  const { kv } = kvStore();
  _resetEngine();
  let aiCalls = 0;
  const env = makeEnv({
    MEM: kv,
    KEY: ENGINE_KEY,
    OPENROUTER_API_KEY: 'test-key',
    AI: {
      async run() {
        aiCalls += 1;
        return { audio: btoa('cf-mp3') };
      },
    },
  });
  await flip(env, false, keyed);

  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('mp3-bytes', { status: 200 });
  try {
    const res = await call(env, '/api/tts?t=hello');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-tts-source'), 'generated');
    assert.equal(await res.text(), 'mp3-bytes');
    assert.equal(aiCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});


test('screenshot route refuses a missing, malformed or non-http url', async () => {
  const env = makeEnv({ MYBROWSER: {} });

  const missing = await call(env, '/api/shot');
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'url_required');

  const bad = await call(env, '/api/shot?url=not+a+url');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'url_invalid');

  // file:// would read the browser's own disk, and no scheme but http(s) is useful here.
  const scheme = await call(env, '/api/shot?url=file%3A%2F%2F%2Fetc%2Fpasswd');
  assert.equal(scheme.status, 400);
  assert.equal((await scheme.json()).error.code, 'url_scheme');
});

test('screenshot route says so when Browser Rendering is not bound', async () => {
  const res = await call(makeEnv(), '/api/shot?url=https://example.com');
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error.code, 'browser_unbound');
});

test('health only advertises screenshots when the browser is bound', async () => {
  const off = await (await call(makeEnv(), '/api/health')).json();
  assert.equal(off.features.screenshots, false);
  assert.equal(off.bindings.browser, false);

  const on = await (await call(makeEnv({ MYBROWSER: {} }), '/api/health')).json();
  assert.equal(on.features.screenshots, true);
  assert.equal(on.bindings.browser, true);
});

function fakeBucket(bytes = new Uint8Array([1, 2, 3]), uploaded = new Date()) {
  return {
    async get() {
      return { uploaded, async arrayBuffer() { return bytes.buffer; } };
    },
    async put() {},
  };
}

test('a fresh cached shot is served without launching a browser', async () => {
  // No MYBROWSER in this env, so the answer can only have come from the cache.
  const res = await call(makeEnv({ BUCKET: fakeBucket() }), '/api/shot?url=https://example.com');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('x-screenshot-cache'), 'hit');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test('a stale cached shot is not passed off as current', async () => {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const res = await call(
    makeEnv({ BUCKET: fakeBucket(new Uint8Array([1]), old) }),
    '/api/shot?url=https://example.com',
  );
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error.code, 'browser_unbound');
});

test('BROWSER is accepted as the browser binding name', async () => {
  const health = await (await call(makeEnv({ BROWSER: {} }), '/api/health')).json();
  assert.equal(health.features.screenshots, true);
  assert.equal(health.bindings.browser, true);

  // A stub is not a browser session, so the route has to fail cleanly, not crash.
  const res = await call(makeEnv({ BROWSER: {} }), '/api/shot?url=https://example.com');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'screenshot_failed');
});

test('ABROWSER is the account name for the browsing service', async () => {
  const env = makeEnv({ ABROWSER: { fetch: async () => new Response('ok') } });
  const health = await (await call(env, '/api/health')).json();
  assert.equal(health.bindings.services.browsing, true);
  // The rendering binding stays separate: a service binding is not a browser.
  assert.equal(health.features.screenshots, false);
});

function fakeKv(entries) {
  return {
    async get(key) {
      return entries[key] ?? null;
    },
    async put() {},
    async list({ prefix = '' } = {}) {
      return {
        keys: Object.keys(entries).filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

test('browsed material reaches the model instead of stopping at the trace', async () => {
  let seen = null;
  const env = makeEnv({
    ABROWSER: { fetch: async () => new Response('BROWSED-MARKER: example.com is a documentation domain.') },
    AI: {
      async run(model, body = {}) {
        if (model.startsWith('@cf/cloudflare/clef')) {
          return {
            response: JSON.stringify({ preset: 'operator', depth: 'deep', tone: 'precise', task: 'extract' }),
          };
        }
        seen = body.messages;
        return body.stream ? sse(['ok']) : { response: 'ok' };
      },
    },
  });

  const res = await call(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'extract the title of https://example.com' }],
      stream: false,
    }),
  });

  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.decision.trace.includes('browse:ok'), body.decision.trace.join(','));
  assert.ok(seen, 'the model should have been called');
  assert.match(JSON.stringify(seen), /BROWSED-MARKER/);
});

test('the review queue is gated and lists the most repeated candidate first', async () => {
  const env = makeEnv({
    ADMIN_KEY: 'secret',
    MEM: fakeKv({
      'candidate:a': JSON.stringify({ id: 'a', query: 'one', answer: 'alpha', hits: 5, suggested: true }),
      'candidate:b': JSON.stringify({ id: 'b', query: 'two', answer: 'beta', hits: 1, alternatives: [{ answer: 'x' }] }),
      'truth:master:c': JSON.stringify({ query: 'ignored', answer: 'not a candidate' }),
    }),
  });

  const denied = await call(env, '/api/admin/queue');
  assert.equal(denied.status, 401);

  const res = await call(env, '/api/admin/queue', { headers: { 'x-admin-key': 'secret' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 2);
  assert.equal(body.ready, 1);
  assert.equal(body.promoteAt, PROMOTE_AT);
  assert.deepEqual(body.rows.map((row) => row.question), ['one', 'two']);
  assert.equal(body.rows[1].alternatives, 1);
});
