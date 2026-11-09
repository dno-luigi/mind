# Incident — blank page on i.nspired.cc (2026-11-06)

**Symptom:** the page loads, the title shows, nothing renders. No visible error. Every URL still answers `200`.

**Cause:** the deployment is serving the **repository root** instead of the build output. `/` returns the Vite development entry:

```html
<script type="module" src="/src/main.jsx"></script>
```

and `/src/main.jsx` is served as a raw source file — `200`, `content-type: text/jsx`, 431 B:

```
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
```

Two independent reasons this cannot run:

1. A `type="module"` script is subject to strict MIME checking. `text/jsx` is not JavaScript, so the browser refuses it outright.
2. Even if it loaded, `import React from 'react'` is a bare specifier only Vite resolves; there is no import map in production.

So `<div id="root">` stays empty. Nothing is logged to the user — hence "blank".

A production build emits `dist/index.html`, which references hashed chunks:

```html
<script type="module" crossorigin src="/assets/index-IME96ftv.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-CHnYuqG7.css">
```

`dist/_redirects` is present, so this is a Pages-style static deploy whose output directory should be `dist` — not the repo root.

**What was NOT broken:** the worker. `/health` returned `healthy` for the whole incident; `/v1/audit` answered `200` in 1.9 s with `model: @cf/meta/llama-3.3-70b-instruct-fp8-fast`. The prompt edit was not the cause. The previous chunks still answer `200` (`/assets/index-IME96ftv.js`, `cf-cache-status: REVALIDATED`), so a rollback will render.

## Why this looked like "everything is down"

The host answers unknown paths with `index.html`, so a missing file returns `200`, not `404`. A broken site looks identical to a healthy one from the outside unless you inspect the body. That is exactly why it was hard to see.

## Fix, in order

1. **Roll back (fastest, no build).** Cloudflare dashboard → the project serving `i.nspired.cc` → Deployments → roll back to the deployment before this one. Assets still resolve, so the site renders in seconds.
2. **Then fix the deploy config and rebuild:**
   ```sh
   npm run build            # vite build -> dist/index.html + dist/assets/*
   ```
   - Pages: build command `npm run build`, **output directory `dist`**
   - Worker with static assets: `assets.directory = ./dist`
   - Never publish the repository root; never set the assets directory to `.`
3. **Verify the artifact before publishing:**
   ```sh
   grep -q '/assets/index-' dist/index.html || echo "STOP: dev entry in the artifact"
   ```

## Verify after publishing

```sh
curl -sS https://i.nspired.cc/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.(js|css)'
```

Expect two lines: one `.js`, one `.css`. Zero lines = the dev entry is live again. Then load the page — `200` proves nothing here.

## Exposure measured during the incident

| Path | Status | Content-Type | Bytes | Verdict |
|---|---|---|---|---|
| `/src/main.jsx` | 200 | `text/jsx` | 431 | source, readable |
| `/src/pages/Engine.jsx` | 200 | `text/jsx` | 17,975 | source, readable |
| `/src/lib/truthEngine.js` | 200 | `application/javascript` | 5,419 | source, readable |
| `/package.json` | 200 | `application/json` | 599 | metadata, readable |
| `/vite.config.js` | 200 | `application/javascript` | 136 | config, readable |
| `/wrangler.toml` | 200 | `text/html` | 1,958 | shell — file absent |
| `/.env` | 200 | `text/html` | 1,958 | shell — **file absent, nothing leaked** |
| `/.env.local` | 200 | `text/html` | 1,958 | shell — file absent |
| `/dist/index.html` | 200 | `text/html` | 1,958 | shell — build output not served |

**Read this rule carefully:** every unknown path returns `200` with the 1,958-byte shell, so status codes cannot detect exposure. Distinguish by `content-type` and size. Source files and `package.json` are genuinely public right now; `.env` is not. Nothing needs rotating. Fixing the deployed directory removes the source exposure.

## Guard against a repeat

- Published artifact is `dist/`, always.
- Pre-deploy: `grep -q '/assets/index-' dist/index.html || echo STOP`.
- Post-deploy: require two `/assets/` references in `/`, then open the page.
- Hashing the chunk is not enough — a wrong or missing script tag yields a perfect chunk nobody loads.
- Add a check that `/src/main.jsx` returns `404` in production. If it returns `200`, you are serving source again.

## Not the cause, but worth knowing

`POST /v1/audit` with `stream:false` answers with `@cf/google/gemma-4-26b-a4b-it`, because the non-streaming path calls `complete()` and ignores `AUDIT_MODEL`. Streamed audits — what the site uses — run `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Two different models on one route depending on `stream`.

---

## Resolution (applied 2026-11-06)

**Root cause, precisely:** Cloudflare Pages project `i-nspired` (git-connected to `dno-luigi/i.nspired`, production branch `main`) had an **empty build configuration**:

```json
{"build_command":"","destination_dir":"","root_dir":""}
```

With no build command and no output directory, a push to `main` publishes the **repository root** as-is. That works only by accident: it ships `index.html` (the Vite dev entry pointing at `/src/main.jsx`), the whole `src/` tree, and `package.json`.

The site had been working because two earlier deployments were `ad_hoc` uploads of a real `dist/` (`f9c3a30a` at 04:17 and `d58fa4d1` at 04:11). Commit `9ef2780` ("Update Engine.jsx") pushed at 06:45, built once (`fb27d51d`, `build/failure`), then produced `5ed9b7a2` at 06:47 as `deploy/success` — a successful *upload of source*. That deployment replaced the good one and produced the blank page.

**Actions taken:**

1. Rolled production back to the last known-good deployment:
   `POST /accounts/771ee2cc20f09248129114b7535b2cc9/pages/projects/i-nspired/deployments/f9c3a30a-26e0-4de9-b194-d9781c7f42c8/rollback`
2. Set the build configuration so this cannot recur:
   `PATCH /accounts/…/pages/projects/i-nspired` with `{"build_config":{"build_command":"npm run build","destination_dir":"dist","root_dir":""}}`

**Verified after the change:** `/` returns the built shell (2,056 B) referencing `/assets/index-IME96ftv.js` and `/assets/index-CHnYuqG7.css`; the served JS hashes to `a5d4c8e0d27c6c4fa4574441d3fdeee58b5d4a5bb4cca93c7243b93a43ce300e` and the CSS to `d8baf929a1c2a9bcd2b0d41fe24d9c9c127c2cab4d2a9b628a12cbc95d3e69ff` — byte-identical to the build captured in `evidence/snapshot-2026-11-06/`. `/engine` and other client routes answer `200` through the `_redirects` rule. The worker stayed `healthy` throughout and was never part of this.

**Still open, stated plainly:** `/src/main.jsx`, `/src/pages/Engine.jsx`, `/package.json` and `/vite.config.js` still return their real contents from the restored deployment. This was checked against the edge cache and is **not** cache — a cache-busted request (`?bust=…`) also returned `200` with real content, so those files are inside that deployment. The rollback restored a working *site*, not a clean *artifact*.

Two ways to close it, both requiring a new deployment:

1. Push to `main`. With the build config now set, Pages runs `npm run build` and publishes only `dist/`.
2. Retry the `9ef2780` build, which now has a working config.

Until one of those happens, the source stays readable. A targeted cache purge was attempted and rejected (`401`, the token has no cache-purge scope); it was not needed, because the files are not cached.

**Consequence for future pushes:** `git push` to `main` now runs `npm run build` and publishes `dist/`. A failed build leaves the previous deployment serving — the failure mode that existed before (publishing source on success) is gone.

**The commit that caused the outage (`9ef2780`) is still not deployed.** It will build correctly on its next push now that the config is fixed. It was not deployed during the repair, because it had not been validated.
