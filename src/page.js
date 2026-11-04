import puppeteer from '@cloudflare/puppeteer';
import { browserBinding } from './bindings.js';

/**
 * Read a page with Browser Rendering.
 *
 * The agent-browsing service is the preferred way to look something up, but it
 * only answers its own request shapes and it is a DevTools gateway, not a text
 * extractor. When it cannot answer and the question named a page, rendering that
 * page here is the difference between "I can't browse" and an answer grounded in
 * the page. One launch, one close, capped text, so it costs what a screenshot costs.
 */

const NAV_TIMEOUT_MS = 20000;
const MAX_TEXT = 4000;

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

/** The first http(s) URL in a question, if it named one. */
export function firstUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[),.;:]+$/, '') : null;
}

export async function readPage(env, url) {
  // The URL is checked before the binding: a file:// path is refused whether or
  // not this deployment happens to have a browser, and the message should say so.
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, error: 'bad_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'bad_scheme' };
  }

  const binding = browserBinding(env);
  if (!binding) return { ok: false, error: 'no_browser' };

  let session = null;
  try {
    session = await puppeteer.launch(binding);
    const page = await session.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Main content when the page marks it, the body otherwise: nav and footers
    // are most of a naive innerText and none of the answer.
    const captured = await page.evaluate(() => {
      const root = document.querySelector('main, article') || document.body;
      return { title: document.title || '', text: (root && root.innerText) || '' };
    });

    const text = `${captured.title}\n\n${captured.text}`
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_TEXT);

    if (!text) return { ok: false, error: 'empty_page', via: 'rendering' };
    return { ok: true, text, via: 'rendering', url: parsed.href };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), via: 'rendering' };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}
