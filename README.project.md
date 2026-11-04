# ai-Ncards — project brief

A one-page summary of what this app does and how it is wired, short enough to
paste into a new project as a starting brief. The long-form documentation is
[README.md](README.md).

- **Live:** <https://mind.ai-n.workers.dev> — worker `mind`, account `ai-nspired`
- **Stack:** one Cloudflare Worker (ES modules, no framework) serving both the API
  and the static `public/` on the same origin, so the client calls `/api/chat` and
  there is no CORS and no proxy URL to configure
- **Inference:** Workers AI first (free daily neurons), OpenRouter as escalation
  and as the whole-engine fallback
- **State:** cards live in the browser; KV / R2 / Durable Objects hold server state
- **Checks:** `npm run check` (syntax), `npm test` (95 offline tests, no network),
  `npm run build` (bundle only), `npx wrangler deploy` (live)

## UX features

### Board and cards

| Feature | How it behaves |
|---|---|
| Flip cards | Tap flips request ↔ answer; long-press opens the card menu. Answers render as sanitized markdown (marked + DOMPurify) with streaming. |
| Card menu | Continue, Split, Merge, AI Edit, Create Preset Card, AI Theme, Manual Style, Copy, Share Card, Export PDF, Screenshot Page, Fullscreen, Undo, Delete. |
| Multi-select | Selection bar with split, merge, delete and "share selected". |
| Views | List / grid / fullscreen, plus a fullscreen overlay with flip, native fullscreen and read-aloud. |
| Styling per card | Bold/italic/underline, text/background/border colours, padding, radius, border width, custom CSS, style lock — or describe a vibe in **AI Stylist** and let the model pick the theme. |
| Undo | One-step undo of the last destructive action, on the top bar. |
| Page on a card | Name a URL in a prompt (or **Screenshot Page**) and the card shows a live `/api/shot` thumbnail linked to the page; only the URL is stored, and shots are cached in R2 for ten minutes. |
| Data | `localStorage` persistence, export/import JSON, export PDF, clear all, factory reset, shareable links. |

### Composer

- One input that takes all three input kinds: **type**, **say**, **attach**.
- **Paperclip** → images (`png/jpeg/webp/gif`), PDF, DOCX, text, markdown, CSV,
  JSON. Files upload immediately into an attachment tray, then attach on send, so
  a prompt never waits on a 10 MB upload. Cards keep a *link* to each file.
- **Mic** → records with `MediaRecorder` and transcribes through `/api/stt`. This
  replaced `SpeechRecognition`, which is Chrome-only.
- **Preset selector** in the bar picks the preset for the next query; presets can
  be managed in Settings.
- **Auto TTS** reads each answer back; every card also has a speaker button. TTS
  is a cacheable `GET`, so repeats cost nothing.

### Settings

| Section | Contents |
|---|---|
| Engine | `Cloudflare: On/Off` switch (server state, needs `KEY`) + key field kept on the device |
| API configuration | Proxy URL, pre-filled with this site's own `/api/chat` |
| Data management | Export JSON, export PDF, import, share, clear all, factory reset |
| Theme & view | Light/dark, theme lock, list/grid/fullscreen |
| Voice | ASR toggle, Auto TTS toggle |
| Account | Name + password sign-in / sign-out, status line |
| Presets | Manage presets, preset cards |

### Admin console

`/admin` (`public/admin.html`), gated by `ADMIN_KEY` with the key kept in
`sessionStorage` for the tab. It pages through `MEM`/`MASTER`, sorts and filters in
the browser, opens a pair in an editor, and lists the review queue
(`GET /api/admin/queue`, most-repeated candidates first). No route writes a curated
truth: promotion is a script, and a stored pair is never overwritten — a different
answer is kept beside it as an `alternatives[]` entry.

## Cloudflare, binding by binding

Everything is declared in `wrangler.jsonc` — never only in the dashboard, because
a config deploy wipes dashboard-only bindings.

| Binding | Type | Used for | Without it |
|---|---|---|---|
| `AI` | Workers AI | gemma chat, whisper ASR, melotts/aura TTS, clef decisions | falls back to OpenRouter |
| `BROWSER` | Browser Rendering | `/api/shot` headless JPEG | route answers `501 browser_unbound` |
| `ABROWSER` / `AGENT-BROWSING` | service → `agent-browsing` | browse stage for `extract`/`compare`/deep | browsing skipped |
| `TRUTH` | service → `truth` | first cache check via `/api/truth/resolve` | falls through to local KV layers |
| `BUCKET` | R2 `r2-explorer-bucket` | `/api/upload`, `/f/:id`, TTS and screenshot caches | uploads 503, TTS regenerates |
| `MEM` | KV `4a9bfbff…` | daily budget, decision cache, candidates, both switches | per-isolate memory, resets |
| `MASTER` | KV `904eff3a…` | master truths + review records of every exchange | falls back to `MEM` |
| `SESSIONS` | Durable Object `Sessions` | login sessions, one instance per user name | no sign-in |
| `ASSETS` | static assets | serves `public/` | no frontend |

- **Do not touch** `migrations` (`tag: "v1"`, `new_sqlite_classes: ["Sessions"]`) —
  Wrangler refuses the deploy if the tag changes.
- `vars` stays `{}`: every value the code uses has the same default baked in.
- `compatibility_date: 2026-11-03`. Keep the worker name `mind`; the `workers.dev`
  URL is the deployment.
- Never add `routes` here. A past `routes` entry broke `workers.dev` with code
  `1042`.

Secrets (all optional except the OpenRouter key when it is used):

| Secret | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | escalation rung, whole-engine fallback, STT/TTS fallback |
| `KEY` | writing the Engine switch (`x-engine-key`) |
| `ADMIN_KEY` | the admin console |
| `LOGIN_PASSWORD` | one shared password for all sign-ins; unset ⇒ `/api/login` 503 |

## OpenRouter, call by call

Base `https://openrouter.ai/api/v1`, `Authorization: Bearer $OPENROUTER_API_KEY`,
plus `x-title` and `http-referer` headers.

| Path | Purpose | Default model |
|---|---|---|
| `POST /chat/completions` (`stream: true`) | chat, normalized to our SSE | `google/gemini-2.5-flash`, or `@preset/<slug>` for a preset, or `openrouter/free` when the Cloudflare switch is off |
| `POST /audio/transcriptions` (`input_audio: {data, format}`) | speech to text | `openai/whisper-large-v3` |
| `POST /audio/speech` | text to speech | `elevenlabs/eleven-flash-v2.5`, `response_format: mp3` (**defaults to PCM** if omitted) |

- A preset must be `@preset/<slug>`. A bare slug is silently ignored by
  OpenRouter and falls back to the plain model.
- Preset rung sends **only** the model: request fields shallow-merge over preset
  config, so sending our own temperature or system prompt would defeat the preset.
- `npm run presets:sync -- --model <slug> [--apply]` pushes the local preset table
  into the account (dry run by default).
- Images travel as `image_url` content parts — the one shape both providers
  accept.
- Upstream failures become `UpstreamError` → `502 upstream_error`, never a silent
  empty answer.

## The wiring, in one snippet

```jsonc
{
  "name": "mind",
  "main": "src/index.js",
  "compatibility_date": "2026-11-03",
  "assets": { "directory": "./public", "binding": "ASSETS" },
  "ai": { "binding": "AI" },
  "browser": { "binding": "BROWSER" },
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "r2-explorer-bucket" }],
  "unsafe": {
    "bindings": [
      { "name": "ABROWSER", "type": "service", "service": "agent-browsing", "environment": "production" },
      { "name": "TRUTH", "type": "service", "service": "truth", "environment": "production", "entrypoint": "default" }
    ]
  },
  "durable_objects": { "bindings": [{ "name": "SESSIONS", "class_name": "Sessions" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sessions"] }],
  "kv_namespaces": [
    { "binding": "MEM", "id": "<kv-id>" },
    { "binding": "MASTER", "id": "<kv-id>" }
  ],
  "observability": { "enabled": true },
  "vars": {}
}
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | version, engines, bindings, feature flags |
| `GET` | `/api/presets` | preset ids and names only — no prompts or model slugs |
| `POST` | `/api/chat` | `{ messages, preset, stream }` → normalized SSE (`meta`, `delta`, `error`, `[DONE]`) |
| `POST` | `/api/stt` | WAV body or `{ audio: base64 }` → `{ text }` |
| `GET` | `/api/tts?t=&v=&m=` | streamed mp3, cached immutably |
| `POST` | `/api/upload` | bytes → R2 + extracted text (`kind`, `chars`, `text`, `note`) |
| `GET` | `/f/:id` | serve an uploaded object from R2 |
| `GET`/`POST` | `/api/engine` | Cloudflare on/off (write needs `KEY`) |
| `POST` | `/api/login` | `{ user, password }` → HttpOnly cookie |
| `GET` | `/api/session` | who the cookie or bearer belongs to |
| `POST` | `/api/logout` | drop the session and clear the cookie |
| `GET` | `/api/shot?url=&full=` | headless JPEG screenshot |

## Patterns worth copying

1. **Same-origin everything.** Assets and API in one Worker removes CORS, cookies
   work with `SameSite=Lax`, and there is one URL to deploy.
2. **Normalize the upstreams, not the client.** Three provider dialects become four
   SSE events, so swapping engines never touches the frontend.
3. **Switches are server state.** `settings:engine` lives in KV and is read per
   request (10 s isolate cache), so one tap changes every browser instead of one
   tab.
4. **Every binding is optional.** A missing binding skips its stage and records a
   trace entry (`cache:miss, intent:fallback, browse:skipped`), so the app degrades
   instead of failing.
5. **Gates fail closed.** An unset `KEY`/`ADMIN_KEY`/`LOGIN_PASSWORD` answers 503
   rather than opening the route; comparisons are constant-time.
6. **Offline tests.** `env.AI` and `fetch` are stubbed, so the ladder, fallback,
   budget, WAV chunking and PDF/docx extraction are all verifiable with no network
   and no credentials.
7. **KV for a switch is eventually consistent** — up to 60 s. That is why every
   read is cached for only 10 s and the writer updates its own isolate immediately.

## Cost and limits

Daily neurons per IP per UTC day: `DAILY_NEURONS`, default 8000 of the 10 000 free
allowance, shared across chat, STT and TTS. Roughly: whisper ~46.6 neurons/audio
min, melotts ~18.6/audio min, aura ~2727/1k chars, gemma ~9091/M input tokens.
melotts is ~130× cheaper than aura, which is why it is the default.
