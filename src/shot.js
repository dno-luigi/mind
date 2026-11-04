import puppeteer from '@cloudflare/puppeteer';
import { fail } from './util.js';

/**
 * Screenshot a page with Browser Rendering.
 *
 * One request, one browser: launch it, shoot it, close it in `finally`, so a
 * navigation that fails or hangs cannot leak a browser session and keep spending
 * the account's browser seconds after the response is gone.
 *
 * Browser Rendering bills per browser-second, so this route stays cheap on
 * purpose: a hard navigation timeout, a JPEG at quality 80 rather than a PNG,
 * and no full-page capture. Ask for `full=1` only if you need the whole page and
 * accept the cost.
 */

const NAV_TIMEOUT_MS = 20000;
const MAX_URL_CHARS = 2000;
const JPEG_QUALITY = 80;

/**
 * Puppeteer opens 800x600, which makes every desktop page look like a phone
 * turned sideways. A real desktop viewport is the whole point of the shot.
 */
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

export async function shot(url, env) {
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

  if (!env?.MYBROWSER) {
    return fail(
      501,
      'browser_unbound',
      'Add the Browser Rendering binding (MYBROWSER) to wrangler.jsonc and deploy again.',
    );
  }

  const fullPage = url.searchParams.get('full') === '1';

  let browser = null;
  try {
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const img = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, fullPage });

    return new Response(img, {
      headers: {
        'content-type': 'image/jpeg',
        // A screenshot is of a moment; caching it would serve a stale page.
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'x-screenshot-url': parsed.href,
      },
    });
  } catch (err) {
    // The page's own failure (DNS, cert, timeout) is a 502, not a 500: the
    // worker is fine, the thing it was asked to look at is not.
    return fail(502, 'screenshot_failed', err?.message || String(err), { url: parsed.href });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
