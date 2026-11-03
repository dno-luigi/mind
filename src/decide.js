import { sha256Hex } from './util.js';

/**
 * The clef ladder: smallest window first, escalate only when the state does not
 * fit. Platform rules this encodes — `model` must be the short name, not the
 * @cf id, and the window is enforced upstream rather than trimmed for us.
 */
export const LADDER = [
  { id: '@cf/cloudflare/clef-flash', model: 'clef-flash', context: 24576 },
  { id: '@cf/cloudflare/clef-omni', model: 'clef-omni', context: 64000 },
  { id: '@cf/cloudflare/clef', model: 'clef', context: 65536 },
];

const CHARS_PER_TOKEN = 3;
const SAFETY = 0.8;

export const QUESTIONS = {
  task: { type: 'choice', choices: ['chat', 'transform', 'generate', 'extract', 'compare'] },
  preset: {
    type: 'choice',
    choices: ['default', 'truth-engine', 'coding', 'legal', 'creative', 'analysis'],
  },
  depth: { type: 'choice', choices: ['terse', 'normal', 'deep'] },
  tone: { type: 'choice', choices: ['plain', 'precise', 'playful'] },
};

function budgetState(messages, context) {
  const budget = Math.floor(context * SAFETY * CHARS_PER_TOKEN);
  const joined = messages
    .map((m) => (m.role === 'system' ? `[system] ${m.content}` : `${m.role}: ${m.content}`))
    .join('\n');
  return joined.length <= budget ? joined : `…${joined.slice(-budget)}`;
}

function parseDecision(out) {
  const candidates = [out?.response, out?.result?.response, out?.answers, out?.result];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let value = candidate;
    if (typeof value === 'string') {
      const match = value.match(/\{[\s\S]*\}/);
      if (!match) continue;
      try {
        value = JSON.parse(match[0]);
      } catch {
        continue;
      }
    }
    if (typeof value === 'object') {
      const pick = (field) => {
        const raw = value[field];
        const answer = typeof raw === 'object' && raw !== null ? raw.answer ?? raw.value ?? raw.choice : raw;
        return typeof answer === 'string' ? answer.toLowerCase() : null;
      };
      const result = {};
      for (const field of Object.keys(QUESTIONS)) {
        const answer = pick(field);
        if (answer) result[field] = answer;
      }
      if (result.preset || result.depth || result.task) return result;
    }
  }
  return null;
}

/**
 * A decision is an optimisation, never a single point of failure: any missing
 * binding, refusal, or unparseable answer falls back to a static decision.
 */
export async function decide(env, { messages, images = [], presetId = null } = {}) {
  const fallback = { preset: presetId || 'default', depth: 'normal', tone: 'plain', task: 'chat', source: 'fallback' };
  if (!env?.AI || env.DECIDE === 'off') return fallback;

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const cacheKey = `decision:${await sha256Hex(`${lastUser.slice(-4000)}|${images.length}|${presetId || ''}`)}`;

  if (env.KV) {
    try {
      const hit = await env.KV.get(cacheKey);
      if (hit) return { ...JSON.parse(hit), source: 'cache' };
    } catch {
      /* cache is optional */
    }
  }

  for (const rung of LADDER) {
    try {
      const payload = {
        model: rung.model,
        state: budgetState(messages, rung.context),
        questions: QUESTIONS,
      };
      // clef reads images itself, but only as data URIs, never remote URLs.
      if (images.length) payload.images = images.slice(0, 4);

      const out = await env.AI.run(rung.id, payload);
      const parsed = parseDecision(out);
      if (parsed) {
        const decision = { ...fallback, ...parsed, source: rung.model };
        if (env.KV) {
          try {
            await env.KV.put(cacheKey, JSON.stringify(decision), { expirationTtl: 3600 });
          } catch {
            /* ignore */
          }
        }
        return decision;
      }
    } catch {
      // Window refused or model unavailable — escalate to the next rung.
    }
  }

  return fallback;
}
