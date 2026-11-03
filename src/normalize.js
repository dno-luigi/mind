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

/** Iterate the `data:` payloads of an SSE stream, whatever produced them. */
export async function* sseData(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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
  } finally {
    reader.releaseLock?.();
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
