# Handoff — the truth console (`/admin`) and the store behind it

State: `main` at the console work, all checks green. Nothing here is deployed until
`npm run deploy` runs and the `ADMIN_KEY` secret exists; until then every console
route answers `503 admin_key_unset` by design.

Read this with `src/admin.js`, the three route lines in `src/index.js`, and the
`<script>` block in `public/admin.html`.

---

## 1. What exists right now

| Piece | Where | Status |
| --- | --- | --- |
| Keyed admin API | `src/admin.js` (new file) | done |
| Route wiring | `src/index.js` — `path === '/api/admin/…'` | done |
| Console page | `public/admin.html` → served at `/admin` | done |
| Store browser (list, filter, sort, export) | `public/admin.html` `<script>` | done |
| Tests | `test.mjs` — 6 tests under `ADMIN_KEY` | done, 71/71 overall |
| README section | `README.md` → "Truth layers" | done |

The page previously shipped a decorative "melody lock" whose hash was in its own
HTML, and had no routes behind it at all. Both are gone: the gate is server-side and
the list is real.

## 2. The gateway

`ADMIN_KEY` is a worker secret, same shape as `KEY` (the engine switch):

```bash
npx wrangler secret put ADMIN_KEY   # once, per deployment
```

Gate, verbatim from `src/admin.js`:

```js
export function adminGate(request, env) {
  const secret = String(env?.ADMIN_KEY || '');
  if (!secret) {
    return adminFail(
      503,
      'admin_key_unset',
      'Set the ADMIN_KEY secret (wrangler secret put ADMIN_KEY) before the console can be used.',
    );
  }
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = request.headers.get('x-admin-key') || bearer || '';
  if (!keyMatches(secret, provided)) {
    return adminFail(401, 'admin_key_required', 'Send the ADMIN_KEY in the x-admin-key header.');
  }
  return null;
}
```

`keyMatches` is in `src/util.js`: length-checked then constant-time XOR, so a wrong
key cannot be narrowed by timing. Unset fails **closed** — the console is the one
place that would hand out the whole store.

Wiring, in `src/index.js`:

```js
// The console reads the store; it still cannot write one. Every route below
// needs ADMIN_KEY, and an unset key fails closed rather than open.
if (path === '/api/admin/unlock' && method === 'POST') return adminUnlock(request, env);
if (path === '/api/admin/keys' && method === 'GET') return adminListKeys(request, env, url);
if (path === '/api/admin/key' && method === 'GET') return adminReadKey(request, env, url);
```

Note `/admin.html` 307s to `/admin` because of the assets layer's HTML handling —
give out `/admin`, not the file name.

## 3. The API

| Route | Params | Returns |
| --- | --- | --- |
| `POST /api/admin/unlock` | `x-admin-key` header | `{ ok, stores: ['MASTER','MEM'], limit: 200 }` |
| `GET /api/admin/keys` | `store`, `limit` (≤200), `cursor`, `q` | `{ rows, cursor, done, listed, matched, store }` |
| `GET /api/admin/key` | `store`, `name` | `{ raw, value, chars, truncated }` |

One row:

```json
{
  "key": "candidate:8f21c0…",
  "store": "MEM",
  "kind": "candidate",
  "question": "what is a cache",
  "preview": "A store of answers …",
  "chars": 1840,
  "bytes": 2017,
  "hits": 3,
  "saved": "2026-10-30T11:04:12.000Z"
}
```

`kind` comes from the key prefix: `master`, `provisional`, `candidate`, `decision`,
`review`, `budget`, `tts`, `upload`, `index`, `settings`, else `other`. `question`
falls back to the key name when the record has no `query`/`input`/`question`; that is
what makes an opaque slug like `ranger1189` readable at all.

Probe it after deploy:

```bash
curl -s https://mind.ai-n.workers.dev/api/admin/unlock -X POST -H "x-admin-key: $ADMIN_KEY"
curl -s "https://mind.ai-n.workers.dev/api/admin/keys?store=MASTER&limit=200" -H "x-admin-key: $ADMIN_KEY"
curl -s "https://mind.ai-n.workers.dev/api/admin/keys?store=MEM&q=cache" -H "x-admin-key: $ADMIN_KEY"
curl -s "https://mind.ai-n.workers.dev/api/admin/key?store=MEM&name=candidate%3A…" -H "x-admin-key: $ADMIN_KEY"
```

## 4. MEM vs MASTER — the thing to get right next

The two namespaces are **not** the same kind of thing and the UI should say so:

| Store | Contents | Rough size |
| --- | --- | --- |
| `MASTER` | curated truths — the ones that answer without a model | ~65 |
| `MEM` | candidates (every generated answer, with `hits`), plus `truth:provisional:*`, `settings:*`, `decision:*`, `review:*`, `budget:*`, `tts:*`, `upload:*` | ~2,000 |

`adminStores()` returns MASTER first, so the picker lists MASTER first and **the
first `Load all` loads MASTER** — which is a sane place to start curating, but it
means the big candidate pile is one pick away, not on screen.

Known gaps in this area (all small, all deliberate to leave for you):

1. **No per-kind filter.** MEM is ~95% noise (`decision:`, `review:`, `budget:`)
   next to the candidates worth curating. A `kind` chip set or `&kind=candidate`
   server-side filter (map it onto `prefix` in `store.list`, which KV does natively
   and free) would cut the page count by an order of magnitude.
2. **No counts until loaded.** `list()` gives no total; the page prints "N keys
   loaded" as it walks. A `prefix` head-count or a cached count would let the picker
   show "MEM · 1,940" before the walk.
3. **One store at a time.** Rows are kept per store, so switching clears
   (`clearRows()` then `loadAll()`). A combined view needs a per-store cursor map;
   `loaded[store]` is already keyed that way, so it is mostly a render change.
4. **Default store is MASTER.** If curation should start on candidates, set
   `keyStoreEl.value = 'MEM'` after populating options, or have `adminStores()`
   return MEM first.
5. **Render cap 500.** `RENDER_LIMIT` in the page; beyond it the status line says
   "Showing the first 500 of N". Sorting and filtering still see every loaded row.

## 5. How the page loads the whole store

`public/admin.html`, `loadAll()` — the cursor walk, which is the part worth reusing:

```js
async function loadAll() {
  if (scanning || !adminKey) return;
  const store = keyStoreEl.value || 'MEM';
  scanning = true;
  if (!loaded[store]) loaded[store] = { cursor: undefined, done: false, seen: new Set() };
  const state = loaded[store];
  say(keysStatus, 'Loading ' + store + '…');
  try {
    while (scanning && !state.done) {
      const params = new URLSearchParams({ store: store, limit: '200' });
      if (state.cursor) params.set('cursor', state.cursor);
      const data = await adminFetch('/api/admin/keys?' + params.toString());
      for (const row of data.rows) storeRows.push(row);
      renderRows();
      if (data.cursor) {
        if (state.seen.has(data.cursor)) { state.done = true; break; }  // never loop
        state.seen.add(data.cursor);
        state.cursor = data.cursor;
      } else {
        state.done = true;
      }
    }
  } finally {
    scanning = false;
  }
}
```

Why 200 and not 1000: every row needs a `get()`, and KV allows 1,000 operations per
invocation. 200 reads + 1 list leaves headroom. ~2,000 keys = 10 requests.

Sorting is pure client-side over `storeRows` (`sortValue` + `visibleRows`):

```js
function sortValue(row, sort) {
  if (sort === 'question') return (row.question || '').toLowerCase();
  if (sort === 'length') return row.chars;
  if (sort === 'kind') return (row.kind || '') + '\u0000' + row.key;
  if (sort === 'saved') return row.saved || '';
  return row.key;
}
```

Search matches `key + question + preview`, so a pair is findable by what it *says*,
not only by its key. That is the feature that replaces "I have to remember 2,000 key
names".

Key handling on the client: `sessionStorage['mind-admin-key']`, sent as `x-admin-key`
on every request through `adminFetch`, never `localStorage`, and **Forget Key** clears
it. Stored answers are rendered through `renderPreview()`, which sanitises with
DOMPurify (CDN, added in `<head>`) and falls back to `textContent` — do not put
`marked.parse()` output straight into `innerHTML` again; this page holds a key.

## 6. What still cannot happen (by design)

- `mind` exposes **no route that writes a truth** — `POST /api/truth/save`,
  `/api/admin/save`, `/api/admin/put` etc. all 404 even with a valid key. A test
  asserts this.
- Editing in the console still calls the **truth worker** directly
  (`https://truth.ai-n.workers.dev/api/truth/master/update` and
  `/provisional/update`), exactly as before. `ADMIN_KEY` does not protect those
  routes; if that worker's endpoints are open, they are open to anyone who knows the
  URL. Gating them is a change in *that* worker.
- Writes never replace a stored pair: `promote()` returns `{ saved: false, conflict:
  true }` unless called with `overwrite: true`, master records carry no TTL, and a
  different answer is kept as an `alternatives[]` entry. Keep that property if you
  add bulk curation.
- `wrangler.jsonc` `vars` stays `{}`; every value is a secret or a code default.
  Never write a key into a file, a commit or a chat.

## 7. Verify it

```bash
npm run check      # syntax gate, now includes src/admin.js
npm test           # 71 tests; the console ones start at "the console is locked"
npm run build      # wrangler dry-run bundle
```

The console tests (in `test.mjs`) cover:

- `the console is locked without ADMIN_KEY` — 503 unset, 401 anon, 401 wrong key
- `the key unlocks the console and names the stores` — MASTER+MEM, single store
  listed once, bearer form accepted
- `the console lists stored pairs with their question and a preview` — row fields,
  `q` filter, unknown store 404
- `the console reads one key in full` — 200 / 404 / 400
- `the console pages through a store larger than one page` — 3 pages, no repeats
- `nothing over HTTP can still write a truth` — the write routes stay 404

There is also a jsdom probe of the real page (not committed; it needs
`npm i -D jsdom`). Save as `scripts/probe-admin.mjs` if useful:

```js
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dir = process.argv[2] || '.';
const html = readFileSync(dir + '/public/admin.html', 'utf8');
const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
new Function(script);                       // syntax + duplicate-declaration check
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const OWN = ['admin-gate','admin-container','adminKey','adminStatus','keyStore',
  'keysBody','keysStatus','keySearch','keySort','adminUnlockBtn','adminForgetBtn',
  'keysLoadAll','keysStop','keysExport'];
const missing = OWN.filter((id) => !ids.has(id));
if (missing.length) throw new Error('missing ids: ' + missing.join(', '));

const dom = new JSDOM(html, { url: 'https://mind.test/admin.html', runScripts: 'outside-only' });
const { window } = dom;
const rows = [
  { key: 'candidate:a', store: 'MEM', kind: 'candidate', question: 'what is a cache', preview: 'A store of answers.', chars: 8, hits: 2, saved: null },
  { key: 'candidate:b', store: 'MEM', kind: 'candidate', question: 'who are you', preview: 'b', chars: 1, hits: 0, saved: null },
];
const calls = [];
window.fetch = async (url, init = {}) => {
  const href = String(url);
  calls.push({ href, key: (init.headers || {})['x-admin-key'] || null });
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  if (href.includes('/api/admin/unlock')) {
    return (init.headers || {})['x-admin-key'] === 'console-secret'
      ? ok({ ok: true, stores: ['MEM'] })
      : { ok: false, status: 401, json: async () => ({ error: { code: 'admin_key_required' } }) };
  }
  if (href.includes('/api/admin/keys')) return ok({ ok: true, store: 'MEM', rows, cursor: null, done: true });
  if (href.includes('/api/admin/key')) return ok({ ok: true, chars: 19, truncated: false, raw: '{"answer":"A store of answers."}', value: { answer: 'A store of answers.' } });
  return ok({ status: 'miss', layer: 'none' });
};
window.eval(script);
await new Promise((r) => setTimeout(r, 40));
const $ = (id) => window.document.getElementById(id);
const order = () => [...$('keysBody').querySelectorAll('tr')].map((tr) => tr.children[0].textContent);
const pass = [];
pass.push(['starts locked', window.getComputedStyle($('admin-container')).display === 'none']);
pass.push(['no request before a key', calls.length === 0]);
$('adminKey').value = 'wrong';
$('adminUnlockBtn').click();
await new Promise((r) => setTimeout(r, 40));
pass.push(['wrong key stays locked', window.getComputedStyle($('admin-container')).display === 'none']);
$('adminKey').value = 'console-secret';
$('adminUnlockBtn').click();
await new Promise((r) => setTimeout(r, 60));
pass.push(['key opens the console', window.getComputedStyle($('admin-container')).display !== 'none']);
pass.push(['two rows listed', order().length === 2]);
$('keySort').value = 'length';
$('keySort').dispatchEvent(new window.Event('change'));
pass.push(['length sort reorders', order()[0] === 'candidate:b']);
$('keySearch').value = 'cache';
$('keySearch').dispatchEvent(new window.Event('input'));
pass.push(['filter narrows', order().length === 1]);
for (const [label, ok2] of pass) console.log((ok2 ? 'PASS ' : 'FAIL ') + label);
if (pass.some(([, ok2]) => !ok2)) process.exit(1);
console.log('ADMIN_PAGE_OK');
```

Run it: `node scripts/probe-admin.mjs "$PWD"` after `npm i -D jsdom`.

## 8. Order of work, if you pick this up cold

1. `npm ci`, `npm test`, `npm run build` — must be green before touching anything.
2. Deploy and set secrets: `npx wrangler secret put ADMIN_KEY` (and `KEY`,
   `OPENROUTER_API_KEY` if the engine switch is in use), then `npm run deploy`.
3. Open `/admin`, unlock, `Load all` on MASTER (~65) — check the question and
   preview columns are readable for every row.
4. Switch the picker to MEM and load it (~2,000, ~10 requests). Confirm sort and
   filter stay responsive and that clicking a row fills the editor.
5. Then do the curation UX in the order listed in §4, starting with the kind filter
   (biggest win: it removes ~95% of the noise and most of the pages).

Ready-to-paste brief for the next agent:

> A Cloudflare Worker (`mind`) serves a flip-card AI chat plus a keyed admin console
> at `/admin`. `src/admin.js` has `ADMIN_KEY`-gated read routes: `POST
> /api/admin/unlock`, `GET /api/admin/keys?store=MEM|MASTER&limit=&cursor=&q=`,
> `GET /api/admin/key?store=&name=`. `public/admin.html` unlocks with the key, walks
> every page, sorts and filters client-side, and opens a row in the editor. MASTER
> holds ~65 curated truths, MEM ~2,000 candidates plus internal keys. Next: separate
> candidates from internal keys (server-side `prefix`/kind filter), show per-store
> counts, and add bulk curation (promote/delete from the list) without ever
> overwriting a stored pair. `mind` must not gain a truth-write route; the console
> edits through the separate `truth` worker. Keep `npm test` (71) and `npm run build`
> green.
