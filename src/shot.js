import puppeteer from '@cloudflare/puppeteer';
import { fail, sha256Hex } from './util.js';
import { objects } from './bindings.js';

/**
 * Screenshot a page with Browser Rendering.
 *
 * One request, one browser: launch it, shoot it, close it in `finally`, so a
 * navigation that fails or hangs cannot leak a browser session and keep spending
 * the account's browser seconds after the response is gone.
 *
 * Browser Rendering bills per browser-second, so this route stays cheap on
 * purpose: a hard navigation timeout, a JPEG at quality 80 rather than a PNG,
 * and no full-page capture unless asked. And because a card grid re-requests the
 * same image on every render, a capture is kept in the bucket for ten minutes —
 * after that the page may have changed, so it is shot again.
 */

const NAV_TIMEOUT_MS = 20000;
const MAX_URL_CHARS = 2000;
const JPEG_QUALITY = 80;
const FRESH_MS = 10 * 60 * 1000;

/**
 * Puppeteer opens 800x600, which makes every desktop page look like a phone
 * turned sideways. A real desktop viewport is the whole point of the shot.
 */
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

function imageResponse(body, { url, cache }) {
  return new Response(body, {
    headers: {
      'content-type': 'image/jpeg',
      // Long enough that one card grid costs one capture, short enough that a
      // page which changed since lunch is not shown as current.
      'cache-control': 'public, max-age=600',
      'access-control-allow-origin': '*',
      'x-screenshot-url': url,
      'x-screenshot-cache': cache,
    },
  });
}

/** R2 keys are flat and content-addressed, so the same page reuses its frame. */
async function cacheKey(href, fullPage) {
  return `shot/${await sha256Hex(`${href}|${fullPage ? 'full' : 'viewport'}`)}.jpg`;
}

export async function shot(url, env, ctx = {}) {
  const target = url.searchParams.get('url');

  if (!target) {
    return fail(400, 'url_required', 'Add ?url=https://example.com to take a screenshot.');
  }
  if (target.length > MAX_URL_CHARS) {
    return fail(400, 'url_too_long', `Keep the URL under ${MAX_URL_CHARS} characters.`);
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return fail(400, 'url_invalid', 'That is not a URL.');
  }
  // file:// and friends would let a caller read the browser's own disk, and
  // there is nothing this route could usefully return for them anyway.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail(400, 'url_scheme', 'Only http and https URLs can be screenshotted.');
  }

  const fullPage = url.searchParams.get('full') === '1';
  const bucket = objects(env);
  const key = bucket ? await cacheKey(parsed.href, fullPage) : '';

  // A cached frame is served even when no browser is bound: the shot was already
  // paid for, and refusing it would help nobody.
  if (bucket) {
    try {
      const hit = await bucket.get(key);
      if (hit && Date.now() - new Date(hit.uploaded).getTime() < FRESH_MS) {
        return imageResponse(await hit.arrayBuffer(), { url: parsed.href, cache: 'hit' });
      }
    } catch {
      // A bucket that cannot be read must not cost the caller their screenshot.
    }
  }

  if (!env?.MYBROWSER) {
    return fail(
      501,
      'browser_unbound',
      'Add the Browser Rendering binding (MYBROWSER) to wrangler.jsonc and deploy again.',
    );
  }

  let browser = null;
  try {
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const img = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, fullPage });

    if (bucket) {
      // Storing must not delay or fail the answer the caller already has.
      const store = bucket
        .put(key, img, {
          httpMetadata: { contentType: 'image/jpeg' },
          customMetadata: { url: parsed.href, full: fullPage ? '1' : '0' },
        })
        .catch(() => {});
      if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(store);
      else await store;
    }

    return imageResponse(img, { url: parsed.href, cache: 'miss' });
  } catch (err) {
    // The page's own failure (DNS, cert, timeout) is a 502, not a 500: the
    // worker is fine, the thing it was asked to look at is not.
    return fail(502, 'screenshot_failed', err?.message || String(err), { url: parsed.href });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
