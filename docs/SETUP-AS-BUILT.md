# Setup as built — i.nspired.cc Truth Engine (replication + recovery)

**Purpose:** explain what is actually running right now, in enough detail to rebuild it or diagnose it when something breaks. Everything here is grounded in source (`/tmp/*-src` clones), a read-only live probe, and one logged audit. Nothing here was inferred from intent.

**Evidence:** `evidence/snapshot-2026-11-06/` (read-only capture), `evidence/snapshot-2026-11-06/live-audit/` (one logged audit, end to end).

---

## 1. The shape of it

```
browser (i.nspired.cc, React SPA)
   |  POST /v1/audit        {messages, type:"docket", stream:true}
   |  POST /v1/audit/store  {content, type, fullText, messages}
   |  GET  /v1/audit/:id
   v
orproxy.ai-n.workers.dev        <- the only public entry point
   |
   v
ai-proxy worker (service binding env.PROXY)
   |         |              |
   |         |              +--> env.TRUTH (truth worker)
   |         +--> env.AI  (Cloudflare Workers AI, llama-3.3-70b)   + fallback OR
   +--> KV: AUDITS, MASTER_TRUTHS, MEM, CONTEXT_STORE, ORP / R2: TRUTH_BUCKET / D1: CHAT_DB
```

Three facts that matter:

1. **The frontend talks to one host only:** `https://orproxy.ai-n.workers.dev`. It appears exactly once in the shipped bundle. Nothing else is hardcoded.
2. **`orproxy` is a pass-through.** Its own root page is ai-proxy's root page, and `/health` reports `service: "ai-proxy"` — so what you reach at the orproxy hostname is the ai-proxy router. Path routing, no intent routing.
3. **ai-proxy owns the prompt, the model choice, the gate, and the storage.** The frontend is a transport plus a text renderer.

**Deployed frontend build this document describes:** `index-IME96ftv.js`, 424,298 B, sha256 `a5d4c8e0d27c6c4fa4574441d3fdeee58b5d4a5bb4cca93c7243b93a43ce300e`; CSS `index-CHnYuqG7.css`, 16,880 B, sha256 `d8baf929a1c2a9bcd2b0d41fe24d9c9c127c2cab4d2a9b628a12cbc95d3e69ff`. Full headers and hashes in `evidence/snapshot-2026-11-06/manifest.json`.

---

## 2. What happens on one audit (observed)

| Step | Request | Observed result |
|---|---|---|
| 1 | `POST /v1/audit` — 200, `text/event-stream` | 250 SSE `data:` lines, 2,713 chars, **2 s**, `model: @cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| 2 | `POST /v1/audit/store` — 200 | `{"audit_id":"audit-1793947164736-ui05ii","evidentiary_gate":"completed","structural_score":0.85,"violations":0,"missing_sections":[]}` |
| 3 | `GET /v1/audit/audit-1793947164736-ui05ii` — 200 | 6,179 B JSON: `id, type, messages, lastResponse, rawText, status, overallConfidence, createdAt`; `status:"completed"`, `overallConfidence:null`, `lastResponse` 2,713 chars |

### The two behaviours that make it work — and that a rebuild must copy

**(a) The worker deletes every `system` message the client sends, then inserts its own.**

Source: `040-handleAudit.js`

```js
chat = chat.filter((m) => m && m.role !== "system");
if (!chat.length) { ... chat = [{ role: "user", content: String(content) }]; }
chat.unshift({ role: "system", content: AUDIT_SYSTEM_PROMPT });
```

This is why the site is better than it was, and why the frontend still shipping `"…I am justice."` does not matter: **the client's system line is discarded before the model is called.** The model never sees it. Prompt authority is server-side by deletion, not by trust.

**(b) Storing runs the deterministic gate, not a model.**

Source: `041-handleAuditStore.js` + `019b-evidence-gate.js`

```js
const egResult = EG.gate(String(fullText || content || ""), "completed");
record.status = egResult.status;            // "completed" | "insufficient_evidence"
record.overallConfidence = null;            // never a model-supplied number
```

The gate is a pure function: 9 required sections in order, source attribution on every Verified Findings bullet, and 8 assertion families refused unless explicitly stated as non-assertions. `overallConfidence` is always `null` because the gate cannot estimate truth — it only checks structure and attribution.

### The behaviour you should know about, because it writes

If the gate returns `ok`, the store step also fires `learnFromAnswer(...)` and `pushProvisional(...)`. So **a passing audit promotes its own text into provisional knowledge and the curation queue.** The test audit I logged did exactly this: it passed, so it may now exist as a provisional entry. It is labelled `SETUP VERIFICATION RECORD - fictional, no real person or entity` for that reason.

The gate is structural. It does not check facts. In the logged run the model wrote `dated-01-15` (it dropped the year), and the gate still returned `completed` with `0 violations` — correct by its own contract, and proof that "gate passed" must never be read as "factually right".

**One provenance detail, observed in the stored record.** `messages` is persisted verbatim, so the permalink's system line is the *client's* `"This is the architect … I am justice."` even though the model never received it. The record preserves what the client sent, not what the model was run under. If you ever need to prove which prompt produced a report, the prompt of record is the worker's `AUDIT_SYSTEM_PROMPT`, not the stored `messages[0]`.

---

## 3. Model routing, as configured

```
AUDIT_MODEL        = @cf/meta/llama-3.3-70b-instruct-fp8-fast   (primary)
AUDIT_BACKUP_MODEL = openrouter/free                            (only on primary failure)
AUDIT_MAX_TOKENS   = 4000
temperature        = 0.35
```

The fallback is used only inside a `catch`, with `preferOpenRouter: true, strictOpenRouter: true`. The observed run used the Cloudflare model, no OpenRouter involved. `openrouter/free` returns a different model per request, which is fine for a rescue path and unacceptable as the primary for a decision path.

---

## 4. Bindings and what each one is for

From `045-bindingReport.js`, and confirmed live:

| Binding | Role | Live |
|---|---|---|
| `AI` | Workers AI | up |
| `OPENROUTER_API_KEY` | fallback provider | up |
| `AUDITS` (KV) | `audit:<id>` records | up |
| `MASTER_TRUTHS` (KV) | authoritative master truths | up |
| `MEM` (KV) | Memoria | up |
| `ORP` (KV) | knowledge / ORP index | up |
| `CONTEXT_STORE` (KV) | conversation context | up |
| `TRUTH` | truth worker service binding | up |
| `TRUTH_BUCKET` (R2) | objects | up |
| `CHAT_DB` (D1) | chat data | up |
| `ADMIN_SECRET` | `/api/admin/*` gate | **down — `adminSecret: false`** |

That last one is the only broken piece, and it is not on the audit path. `/v1/pipeline` uses it for nothing; only admin routes need it.

---

## 5. Routes that exist today

```
GET  /health
POST /api/chat          {message|messages, stream}
POST /api/generate      {prompt|messages, stream}
POST /api/code          {prompt}
POST /candidate         {id, query, model, instruction, schema}
POST /api/embed         {text}
POST /api/context       {context_id, message}
POST /api/context/clear
GET  /api/elevated
POST /v1/audit          {content|messages, type, stream}
POST /v1/audit/store    {content, fullText, messages, audit_id} -> {audit_id}
GET  /v1/audit/:id
POST /v1/pipeline       {audit_id, action, contact}
ANY  /api/admin/*       X-Admin-Secret
```

`POST /api/mcp` deliberately answers `501 mcp_not_implemented`. `GET /v1/audit` answers `404 not_found` because the route is POST-only — that is not a fault.

`POST /v1/pipeline` takes `action` of `speakeasy_review`, `counsel_doc_prep`, or `counsel_consult`. It reads the audit from KV, so a pipeline call needs a real `audit_id`.

---

## 6. If it breaks, check in this order

1. **Is the worker alive?** `curl -sS https://orproxy.ai-n.workers.dev/health` → expect `"status":"healthy"` and the binding map. A `false` in `bindings` names the exact missing binding — that is what this endpoint is for.
2. **Is it the model?** A `502 model_failed` means both the CF model and `openrouter/free` failed. Check `OPENROUTER_API_KEY` and whether the CF model id still exists.
3. **Is it the frontend build?** Hash the JS, do not trust the name: assets are served `max-age=14400` and can lag a deploy by up to four hours.
4. **Is the report being refused?** `insufficient_evidence` with `missing_sections` means the model did not produce all 9 headings; with `violations` it means it asserted something the gate refuses. Both are the gate working, not a crash.
5. **Is the permalink empty?** The `audit_id` only exists after `/v1/audit/store` succeeds. A streamed answer with no store call has no permalink.

---

## 7. Rebuild checklist

- [ ] Deploy the ai-proxy worker with all 11 bindings above; `AUDITS` is mandatory for permalinks.
- [ ] Keep `AUDIT_SYSTEM_PROMPT` in the worker (`005-AUDIT_SYSTEM_PROMPT.js`), and keep the `filter(m => m.role !== "system")` line. Removing either returns prompt authority to the client.
- [ ] Keep the gate server-side (`019b-evidence-gate.js`, port of `audit-hardening/evidence-gate.mjs`); re-run `node --test audit-hardening/` (22 tests) after any change to it.
- [ ] Point the SPA at the single entry host; it needs no other URL.
- [ ] Do not enable `openrouter/free` as the primary audit model.
- [ ] Bind `ADMIN_SECRET` before relying on any `/api/admin/*` route.
- [ ] Reconcile `PAYMENT_INFO` (`$50-100` doc prep, `$500-750` consult, Chime `chime.me/@ai-nspired`, CashApp `$AINspired`) with the current published services before taking any payment through `/v1/pipeline`.

## 8. Reproduce the whole path in three commands

```sh
curl -sS https://orproxy.ai-n.workers.dev/health
curl -sS -N -X POST https://orproxy.ai-n.workers.dev/v1/audit \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"YOUR RECORD TEXT"}],"type":"docket","stream":true}'
curl -sS -X POST https://orproxy.ai-n.workers.dev/v1/audit/store \
  -H 'content-type: application/json' \
  -d '{"content":"<answer text>","type":"docket","fullText":"<answer text>"}'
```

The first prints the report; the second returns the `audit_id` and the gate verdict. Note that the second also promotes the answer into provisional knowledge when the gate passes.
