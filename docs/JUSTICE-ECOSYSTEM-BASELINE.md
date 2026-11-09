# Justice ecosystem baseline

Discovery record, 2026-11-09. Read-only: no deployment, migration, secret change,
KV/D1/R2 write or script upload was performed to produce this document.

Every claim below is marked one of three ways:

- **Confirmed** — read from the live Cloudflare API, the deployed bundle, or an HTTP
  probe whose result is quoted.
- **Inferred** — follows from confirmed facts but the deciding source is not in this
  workspace.
- **Unknown** — nobody has looked yet. Named so it is not mistaken for a gap in the
  system.

Evidence on disk: `evidence/justice-discovery/` holds `justice.worker.mjs` (the
deployed bundle, extracted and syntax-checked), `inventory.json` (70 Workers),
`bindings-all.json` (every Worker's bindings) and `resources.json` (46 KV, 16 D1,
23 R2, 46 Durable Object namespaces).

Credential constants found in the bundle (`MASTER_HASH` and the two group keys) are
replaced with `<redacted>` markers in that extracted copy, so it is the deployed
code minus its secrets rather than byte-identical. No value is reproduced anywhere
in this document.

What Justice is *meant* to become is a separate document:
[JUSTICE-ARCHITECTURE.md](JUSTICE-ARCHITECTURE.md). This one records only what is.

## 1. Historical Justice

The Justice Worker was last deployed **2025-10-27** — 378 days before this
discovery. **Confirmed.**

There is no source repository for it. Of the 147 repos on the account, none is
named `justice` and none mentions it in its description. **Confirmed.** So the
deployed bundle is the only surviving copy of the code, and the historical
`wrangler.jsonc`, its git history and its original binding declarations are gone.
Anything this document says about *intent* comes from reading that one artifact.

It is a single 8 KB ES module, POST-only, with no router beyond a `task` field in
the request body. Five behaviours:

| task / route | what it does | state today |
| --- | --- | --- |
| `validate_group` | looks a group id up in a hardcoded `MELODIC_KEYS` map, writes `group:<id>:hash` to `GROUP_LEDGER`, **returns the group key to the caller** | works |
| `unlock` | reads `speakeasy_code:<input>` from `IDENTITY_LEDGER`, returns the stored reward | works (403 probed) |
| `edit_truth` | the EITL path: checks `vetted_hash:<userId>`, then writes `truth:<truthId>` at confidence 100 | broken |
| `follow_up` | loads history from a Durable Object, forwards a composed prompt to the truth engine, caches the answer | broken |
| `/api/ai/truth`, `useTruthEngine` | forwards the whole request to the truth engine | broken |

The three broken paths are broken for the same mundane reason: the code addresses
bindings that do not exist on the Worker. See §5.

**Provenance is visible in the source.** The bundle's own comments record an agent
patching itself into a working state:

- `// FIX 1: Renamed from ContextManager to Chat to match implied binding 'justice_chat'`
- `// FIX 2: Assumed binding is JUSTICE_CHAT based on the error.`
- `// FIX 3: Export the renamed Chat class`

That is guesswork committed to production, labelled as such, and still serving
requests a year later. Treat the bundle as an artifact of debugging, not as a
design.

## 2. Current Cloudflare inventory

**Confirmed**, account `771ee2cc20f09248129114b7535b2cc9`:

| resource | count |
| --- | --- |
| Worker scripts | 70 |
| KV namespaces | 46 |
| D1 databases | 16 |
| R2 buckets | 23 |
| Durable Object namespaces | 46 |

The Worker is still live at `https://justice.ai-n.workers.dev`, with no custom
domain and no zone route. Probes **Confirmed**:

- `GET /` → `405` (the handler refuses everything but POST)
- `POST {"task":"unlock","input":"probe-no-such-code"}` → `403 {"error":"Invalid Speakeasy Code"}`
- `POST {"task":"nope"}` and `POST {}` → `400 {"error":"Invalid task or route"}`

No request authentication was involved in any of those three. The endpoint answers
anonymous callers, and its CORS policy is `Access-Control-Allow-Origin: *`.

## 3. Resource-ID crosswalk

Justice's live bindings, with the account-level title for each ID. **Confirmed.**
Titles come from the Cloudflare API, not from the binding names.

| binding on Justice | type | account title | resource ID | bound by |
| --- | --- | --- | --- | --- |
| `CONTEXT_KV` | KV | **Ming** | `7e8c18ff…c93af` | only `justice` |
| `GROUP_LEDGER` | KV | `group_ledger` | `4c4ccb71…de5a9` | only `justice` |
| `IDENTITY_LEDGER` | KV | `identity_ledger` | `c2dc3d53…115f2` | only `justice` |
| `memy` | KV | **Memoria** | `4a9bfbff…2045a` | **10 Workers** (below) |
| `CONTEXTMANAGER` | Durable Object | `justice_Chat`, class `Chat`, script `justice` | `ed87d2a9…8eb7c` | only `justice` |
| `TRUTH_ENGINE` | — | **does not exist** | — | — |
| `AI` | Workers AI | — | — | many |

Three of the six rows contradict the working assumption that these names are
Justice-specific:

1. **`MEMY` is not Justice's store.** Its ID is `Memoria`, shared by ten Workers
   under nine different binding names: `ai-proxy.MEM`, `ara.KV`, `cards.KV`,
   `cods.KV`, `ingenium-veritas.memy`, `justice.memy`, `mind.MEM`,
   `neo-te.memy`, `truth.PROV_TRUTH`, `truthengine.memy`. Any Justice write to
   `memy` lands in the same namespace `mind` treats as Memoria and `truth` treats
   as provisional truth with a 24-hour TTL.
2. **`CONTEXT_KV` is ambiguous between Workers, and this is the trap.** Justice's
   `CONTEXT_KV` is `Ming` (`7e8c18ff`). The `tew` Worker binds a namespace *also
   named* `CONTEXT_KV` that is `CONTEXT_STORE` (`b78a25e9`) — a different
   namespace, shared with `ai-proxy.CONTEXT_STORE` and `cods.CONTEXT`. Same
   binding name, two resources. Name matching would have produced a false positive
   here; only the ID separates them.
3. **`TRUTH_ENGINE` was never a binding on Justice.** The name exists elsewhere in
   three unrelated forms, which is why it looks familiar:
   - the `editor` Worker has a service binding literally called `TRUTH_ENGINE`,
     pointing at **`truth-engine-workspace`** (deployed 2026-09-03);
   - `mind` resolves a Secrets Store secret named `TRUTH_ENGINE_PROMPT`;
   - a Worker named **`truthengine`** exists, last deployed **2025-11-23**.

   Justice's code calls `env.TRUTH_ENGINE.fetch` with no such binding, so that
   call throws. **Inferred** target if it ever had one: `truthengine`, the only
   candidate contemporaneous with the 2025-10-27 deploy that (a) lives in the same
   truth lineage and (b) exposes `AI_SYSTEM_PROMPT` as a plain-text binding — the
   exact variable Justice's `follow_up` interpolates into its prompt. Not provable
   without the client that used to call Justice.

The shared-state map, for the namespaces that matter here. **Confirmed:**

| namespace | ID | bound by |
| --- | --- | --- |
| Memoria | `4a9bfbff` | 10 Workers, listed above |
| master truths | `904eff3a` | `ai-proxy.MASTER_TRUTHS`, `cods.TRUTHS`, `ingenium-veritas.MASTER_TRUTHS`, `mind.MASTER`, `truth.MASTER_TRUTHS` |
| CONTEXT_STORE | `b78a25e9` | `ai-proxy.CONTEXT_STORE`, `cods.CONTEXT`, `tew.CONTEXT_KV` |
| AUDITS | `8c19918f` | `ai-proxy.AUDITS`, `cods.AUDITS`, `tew.AUDITS_KV` |
| orp | `145a30ed` | `ai-proxy.ORP`, `tew.ORP_KV` |
| truth-engine-kv | `c09c7cc2` | `tew.KV_NAMESPACES`, `truth-engine-workspace.KV` |

**Your safeguard is confirmed by the data, not just plausible.** `Memoria` carries
an ID match with ten Workers and at least three different application-level
purposes: `mind`'s long-term memory, `truth`'s 24-hour provisional store, and
Justice's confidence-100 EITL ledger. Infrastructure identity is shared; purpose
is not. A crosswalk that stops at matching IDs would have called those the same
thing.

## 4. Authentication

| surface | mechanism | state |
| --- | --- | --- |
| Justice — every task | none on the request; only `IDENTITY_LEDGER` content checks | **Confirmed** live, anonymous, CORS `*` |
| Justice — EITL | `vetted_hash:<userId> === MASTER_HASH` | **Confirmed** in source |
| Justice — `MASTER_HASH` value | hardcoded in the bundle; redacted here because it is a live credential | **Confirmed** |
| Justice — group keys | hardcoded `MELODIC_KEYS` for `group1`/`group2`, returned to the caller on success | **Confirmed** |
| `truth` Worker — six write paths | `ADMIN_KEY` secret, `x-admin-key` or bearer, constant-time compare; fails **open** when unset | **Confirmed** (401 on all six, probed previously) |
| `mind` — `/api/admin/*` | `ADMIN_KEY` secret; fails **closed**, `503 admin_key_unset` | **Confirmed** |

Two consequences worth stating plainly:

- The EITL gate is a bearer comparison against a value that shipped inside the
  Worker. Anyone with API read access to this account can read it from the bundle;
  the bundle is also the only copy of the code, so it must be read to restore the
  system at all.
- Justice holds **ten secrets**, including `CLOUDFLARE_API_KEY` and
  `CLOUDFLARE_ID` — an account API key on a Worker that never calls the Cloudflare
  API. Two of them, `"MASTER _HASH "` and `"MASTER _MELODY"`, contain spaces, which
  makes them unreachable as `env.X` and therefore dead weight that is nonetheless
  exposed. Names only; no value was read.

## 5. EITL capabilities

The intended EITL ("edit the truth layer") path, **Confirmed** from the bundle:

1. caller supplies `userId`, `truthId`, `input`;
2. the Worker reads `vetted_hash:<userId>` from `IDENTITY_LEDGER`;
3. if it equals `MASTER_HASH`, it writes `truth:<truthId>` into the stringified
   JSON `{answer, confidence: 100, editedBy, editedAt}`;
4. anything else is `403 Access Denied`.

Three defects, all **Confirmed** by comparing source to live bindings:

| defect | evidence |
| --- | --- |
| `env.MEMY` but the binding is `memy` | binding names are case-sensitive; `MEMY` is undefined, so the write throws before touching KV |
| `env.JUSTICE_CHAT` but the binding is `CONTEXTMANAGER` | the Durable Object is correctly bound and exported as class `Chat`; the code asks for a name that does not exist |
| `env.AI_SYSTEM_PROMPT` | no such binding on Justice, so `follow_up` would compose the literal string `undefined` into the prompt even if reached |

So the EITL write path is inert today — nothing is being written to Memoria by
Justice. That is luck, not design: the failure is a casing mistake, and the path
becomes live the moment someone "fixes" it without a policy decision.

If it were repaired as written, the effect would be a permanent, confidence-100
record in the namespace `truth` treats as provisional and expires after 24 hours.
Justice writes no TTL; `truth`'s provisional records do. Same namespace, opposite
lifetime semantics.

## 6. Dependencies and service relationships

Justice has **zero outbound service bindings** and is nonetheless still a
dependency of two live Workers. **Confirmed:**

- `ai-proxy` (deployed 2026-11-06) binds `JUSTICE` → `justice`
- `truth` (deployed 2026-11-09, i.e. today) binds `JUSTICE` → `justice`

The year-old Worker is wired into the current truth pipeline. Removing it is not a
cleanup of dead code; it is a breaking change to two live Workers whose call sites
this workspace cannot see.

The family it belongs to, by deploy date:

| Worker | last deploy | distinguishing bindings |
| --- | --- | --- |
| `justice` | 2025-10-27 | `Ming`, `group_ledger`, `identity_ledger`, `memy`, DO `justice_Chat` |
| `truthengine` | 2025-11-23 | `memy`, plain-text `AI_SYSTEM_PROMPT`, services to ai-proxy/aura/avs/matrix/session/truth, DO `CHAT` |
| `truth-engine-workspace` | 2026-09-03 | `truth-engine-kv`, R2 `truth-engine-assets`, DO `WORKSPACE` |
| `editor` | 2026-08-28 | `TRUTH_ENGINE` → `truth-engine-workspace`, `EDITOR_KV` |
| `tew` | 2026-11-03 | `CONTEXT_STORE` as `CONTEXT_KV`, `AUDITS_KV`, `ORP_KV`, `truth-engine-kv`, R2 `truth-engine-assets`, DO `WORKSPACE` |
| `ai-proxy` | 2026-11-06 | 18 bindings incl. `OG` → `truthengine`, `JUSTICE` → `justice`, `TRUTH` → `truth` |
| `truth-engine` | 2026-11-08 | no bindings at all |
| `truth` | 2026-11-09 | `MASTER_TRUTHS`, `PROV_TRUTH`, R2 `ai-nspired`, services `AI-PROXY`/`JUSTICE`/`ORPROXY`, `ADMIN_KEY` |

Two observations fall out of the dates. `truth-engine` (2026-11-08) is a Worker
with no bindings, no routes proven here, and a name that collides with the
`TRUTH_ENGINE` binding name used by `editor` — it is the most likely source of
"renamed versus genuinely different" confusion in this family. And `tew` and
`truth-engine-workspace` are two deploy generations of one application, sharing
`truth-engine-kv` and the `truth-engine-assets` bucket while each holds its own
`WORKSPACE` Durable Object.

## 7. Confirmed gaps

1. **No recoverable source.** No repo, no Wrangler config, no history. The only
   copy of Justice is a deployed bundle whose comments admit guessed bindings.
2. **No authentication.** Anonymous POSTs are answered; CORS is `*`; the EITL
   secret and group keys are hardcoded in that bundle.
3. **Four binding references are wrong**, three to names that never existed and one
   a casing error. Two of Justice's five behaviours and both of its outbound calls
   are dead.
4. **`CONTEXT_KV` is bound but never referenced** anywhere in the code — the Ming
   namespace is attached for no reason the artifact explains.
5. **A live dependency on a year-old Worker**, from both `ai-proxy` and `truth`.
6. **Ten secrets, at least two of them dead and two of them account-level API
   credentials** on a Worker with no Cloudflare API usage.

## 8. Unresolved questions

1. What do `ai-proxy` and `truth` actually send to `JUSTICE`, and is that path
   exercised? Needs both Workers' source, which is not in this workspace.
2. Was `TRUTH_ENGINE` ever `truthengine`? The `AI_SYSTEM_PROMPT` match is strong
   circumstantial evidence, not proof.
3. Do `Ming`, `group_ledger` and `identity_ledger` contain records? Counting keys
   is a KV read API call, not taken here. If `identity_ledger` holds
   `vetted_hash:*` entries, they are the EITL whitelist and are worth knowing about
   before anything is deleted.
4. What are `"MASTER _HASH "` and `"MASTER _MELODY"`, and do they correspond to
   `SPK_HASH`/`SPK_MELODY`/`SVG_HASH`/`SVG_MELODY`? Names suggest a hash/melody
   pairing per surface, duplicated once in error.
5. Is `justice` meant to be retired, or restored? Its two live callers suggest
   retired is not currently true.

## 9. Method, and what was not done

Inventories came from the Cloudflare API (accounts → Workers → per-script
`settings` → KV/D1/R2/DO namespace listings) and the GitHub API (all 147 repos,
root listing per repo). The bundle was downloaded read-only, unwrapped from its
`multipart/form-data` envelope to `justice.worker.mjs`, and syntax-checked with
`node --check`.

Not done, deliberately: no deploy, no script upload, no migration, no route or
binding change, no secret value read, no KV/D1/R2 read or write beyond what the
listing endpoints return, and no request that would write — the three probes were
chosen because they read and refuse.

The same investigation is scriptable against any Worker name. That is the
generalisation this document is meant to prove: three inventories, one ID
crosswalk, and a source-versus-binding comparison, which is what turned "Justice is
old" into six specific defects.
