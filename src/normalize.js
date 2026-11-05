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
 * Text arrived, but the upstream never said it had finished. This is its own
 * event rather than an error: the deltas already painted are real, they are just
 * not the whole answer, and a card that shows them as complete is lying.
 */
export const incompleteEvent = (fields) => event({ type: 'incomplete', complete: false, ...fields });

/**
 * The provider's own end-of-answer signal, when it sends one. OpenAI-shaped
 * streams put a `finish_reason` on the last choice; the sentinel frame is the
 * other spelling of the same claim. Neither means "the socket closed".
 */
export function finishReason(data) {
  if (!data || data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    const choice = parsed.choices?.[0] ?? parsed.result?.choices?.[0];
    const reason =
      choice?.finish_reason ??
      choice?.finishReason ??
      parsed.finish_reason ??
      parsed.result?.finish_reason;
    return typeof reason === 'string' && reason ? reason : null;
  } catch {
    return null;
  }
}

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

/**
 * Workers AI streams either its native {"response":"..."} shape or an
 * OpenAI-compatible one ({"choices":[{"delta":{"content"}}]}) depending on the
 * model family. Reading only the native shape makes a perfectly good answer
 * look like an empty one, which surfaces as "returned no text".
 */
export function fromWorkersAI(data) {
  if (!data || data === '[DONE]') return '';
  try {
    const parsed = JSON.parse(data);
    const choice = parsed.choices?.[0] ?? parsed.result?.choices?.[0];
    return (
      parsed.response ??
      parsed.result?.response ??
      choice?.delta?.content ??
      choice?.message?.content ??
      choice?.text ??
      ''
    );
  } catch {
    return '';
  }
}

/** The top-level keys of a frame, so an empty answer can say what it received. */
export function frameShape(data) {
  if (!data || data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return null;
    const keys = Object.keys(parsed);
    return keys.length ? keys.join(',') : null;
  } catch {
    return null;
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
