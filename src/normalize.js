/**
 * Three upstream dialects, one wire format. The client only ever has to
 * understand these four events, which is why switching providers is invisible
 * to the frontend.
 */

export const DONE = 'data: [DONE]\n\n';

export const event = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

export const meta = (fields) => event({ type: 'meta', ...fields });

export const delta = (text) => (text ? event({ type: 'delta', text }) : '');

export const errorEvent = (code, message) => event({ type: 'error', error: { code, message } });

/**
 * Iterate the `data:` payloads of an SSE stream, whatever produced them.
 *
 * `timeoutMs` is an idle budget, restarted on every chunk: a slow but living
 * stream is never cut off, while a stalled one is cancelled and reported instead
 * of holding the request open until the platform gives up on it.
 */
export async function* sseData(stream, { timeoutMs = 0 } = {}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let timer = null;
  let timedOut = false;

  const arm = () => {
    if (!timeoutMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      // Cancelling resolves the pending read as done, so the loop can exit.
      reader.cancel().catch(() => {});
    }, timeoutMs);
  };

  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
    }
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    if (timedOut) {
      const err = new Error(`Upstream stalled: no data for ${Math.round(timeoutMs / 1000)}s.`);
      err.code = 'upstream_timeout';
      err.status = 504;
      throw err;
    }
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock?.();
    } catch {
      /* the stream may already be cancelled */
    }
  }
}

/**
 * Workers AI can report a failure as a data frame rather than an HTTP status,
 * so a broken model looks like a successful empty answer unless this is checked.
 */
export function upstreamError(data) {
  if (!data || data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    const err = parsed?.error ?? parsed?.errors?.[0] ?? parsed?.result?.error;
    if (!err) return null;
    return typeof err === 'string' ? err : err.message || JSON.stringify(err);
  } catch {
    return null;
  }
}

/** Workers AI native stream: {"response":"..."} */
export function fromWorkersAI(data) {
  if (!data || data === '[DONE]') return '';
  try {
    const parsed = JSON.parse(data);
    return parsed.response || parsed.result?.response || '';
  } catch {
    return '';
  }
}

/** OpenRouter chat/completions: choices[0].delta.content */
export function fromOpenRouterChat(data) {
  if (!data || data === '[DONE]') return '';
  try {
    return JSON.parse(data).choices?.[0]?.delta?.content || '';
  } catch {
    return '';
  }
}
