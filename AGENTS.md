Understood — `mind` is authoritative, and the other repo appears in that file as a capability inventory, not its own rulebook. Let me ground the mind half in what this repo actually is before I write it.

This changes the design in an important way: if one file governs both repos, it has to be the only place the rules live, and `cods` needs a one-line pointer here or an agent opened in that repo never sees it. Writing the file now, with `cods` as an inventory rather than a second rulebook.

My file-writing tools aren't available in this session right now (the workspace tools are unavailable), so here's the full draft inline — paste it as `AGENTS.md` at the root of `mind`, or switch this chat to Build and I'll write it directly and show it in the file panel.

```markdown
# AGENTS.md

Rules and map for this repository, written for an agent starting cold. Read this,
then read the code. This file holds invariants only: if a fact can change without
anyone editing this file, it does not belong here.

## 1. Hierarchy

- `mind` (this repo) is the authority. This file governs work in `mind` and in
  every sibling repo reached from it.
- `cods` appears in §7 as a capability inventory, not a second rulebook. These
  rules apply when working there too; its own `AGENTS.md` is a three-line pointer
  back to this one, so an agent opened in that repo still finds the rules.
- The code is the truth. When this file and the code disagree, say so and fix the
  file in the same change.

## 2. Hard rules

1. **Never deploy unless asked.** In this repo a push to `main` *is* a deploy:
   `.github/workflows/deploy.yml` runs `npm ci` → `npm test` → `npm run build` →
   `wrangler deploy`. Treat a push as a deploy. Cloudflare API writes, uploads and
   deletes are always off-limits without an explicit request.
2. **The brand and domain are `ai-nspired.com`.** One "i", never "inspired". Copy
   it from this line, never from memory.
3. **Do not create workers.** The account already has more than it needs; fix the
   ones that exist. `PROJECTS.md` has the current count and never drifts.
4. **Ask before changing code or stored data.** One question, then continue. Do not
   hand a decision back as a menu of options, and do not make an assumption in
   place of a question.
5. **Dictation is free for everyone, forever.** No plan check, no key, no login, in
   either repo.
6. **Never grade or critique the owner's legal or methodological output.** He is
   the method.
7. **Secrets by name only** — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `GITHUB_PAT`, `OPENROUTER_API_KEY`, `ADMIN_KEY`. Never echo a value, never write
   one into a file, command or reply.
8. **Model roles are decisions, not options.** §6. If a named model is unavailable,
   stop and ask. Never substitute a llama model for one of them.
9. **Verify before claiming.** Run the check; report failures as failures. Never
   loosen an assertion to make a change pass — if the behaviour changed on purpose,
   rename the expectation.

## 3. What this repo is

`mind` is a flip-card AI chat on Cloudflare Workers: the front end in `public/` and
the API in `src/` are served from one origin (no CORS), answers arrive as cards, and
knowledge is layered — the separate `truth` worker owns curated truth, `mind`
answers from it first and saves everything it produces as a candidate.

## 4. Verify

```bash
npm ci          # dependencies are not preserved between sessions
npm run check   # node --check over every source file, including public/script.js
npm test        # node --test test.mjs — 111 tests at the time of writing
```

A green `check` and `test` is the floor, not proof: the checks do not exercise the
network or the browser. Say what was verified and what was only read.

## 5. Map

| path | what lives there |
| --- | --- |
| `src/index.js` | worker entry, route table, chat pipeline |
| `src/decide.js` | clef decision ladder, decision cache |
| `src/engine.js` | model calls and timeouts |
| `src/truth.js` | truth layers, `promote()`, TTLs, candidates |
| `src/bindings.js` | which binding a store resolves to |
| `src/admin.js` | read-only admin API (`/api/admin/*`) |
| `src/providers/` | `workers-ai.js`, `openrouter.js` |
| `src/audio.js`, `extract.js`, `shot.js`, `sessions.js` | ASR slicing, attachments, screenshots, login state |
| `public/script.js` | the app |
| `public/admin.html` | the console at `/admin` |
| `test.mjs` | all tests |
| `PROJECTS.md` | every Worker and repo, plus which of them have README/AGENTS — generated, never hand-edited |
| `scripts/overview.mjs` | rebuilds `PROJECTS.md` from the account and GitHub |

## 6. Data and bindings

| binding | kind | target |
| --- | --- | --- |
| `ASSETS` | assets | `./public` |
| `AI` | Workers AI | vision, whisper, clef ladder |
| `BROWSER` | Browser Rendering | `/api/shot`, one page per shot |
| `BUCKET` | R2 | `r2-explorer-bucket` |
| `SESSIONS` | Durable Object | one per user, sqlite, migration tag `v1` |
| `MEM` | KV | `4a9bfbffb4d440cba86badc508e2045a` |
| `MASTER` | KV | `904eff3af4c14f06964e4f651cce9573` |
| `TEP` | Secrets Store | `7073bd5852014f83875874ae3ff0817e` / `TRUTH_ENGINE_PROMPT` |
| `TRUTH` | service | worker `truth` |

The same namespaces are bound under different names elsewhere. That is why an edit
in one place shows up in another:

- `904eff3a…` = `MASTER` (mind) = `TRUTHS` (cods) = `MASTER_TRUTHS` (truth worker)
- `4a9bfbff…` = `MEM` (mind, Memoria) = `PROV_TRUTH` (truth worker)

Truth worker facts that matter here: master records are written with **no TTL**,
provisional records carry a **24-hour** TTL, and all six write routes require
`ADMIN_KEY` in `x-admin-key`. Reads (`/api/truth/resolve`, `/debug/kv-status`) are
public. The console's Save writes master through that gate
(`public/admin.html`), so it must send the key.

Do not align the two `ADMIN_KEY`s to make a test pass. They are separate secrets on
purpose: `mind`'s key governs the console and its read API, the truth worker's governs
writes to stored truth, and holding one is not holding the other.

## 7. Sibling repo `cods`

Capability inventory, not policy. Read its code before changing it; these notes come
from its 2026-10-31 handoff.

- A second card app that solves the same problem differently. Worker `cods`, repo
  `dno-luigi/cods`, catalogued by `tools/build-catalogue.mjs`.
- `POST /stt` — free dictation, no key, 8 MB cap, 120 clips per address per day,
  both models and both shapes tried.
- Truth path: `truthStore()` prefers `TRUTHS` → `ARCHIVE` → `KV`; every answer is
  stored as a candidate with confidence 0.4–0.85; `POST /truths/<id>/approve` with
  `x-truth-key` promotes to master at 0.9; `GET /truths?status=candidate` lists.
- OpenRouter work: `openRouterCall()` returns `{text, citations}`; `OR_WEB_PLUGIN`
  grounds the main call only, so card sub-calls do not pay for a search.
  `use_web:false` opts out.
- Tools: `tools/pull-worker.mjs <name> [outDir]` pulls a deployed worker read-only.
- Checks: `npm run check`, `npm test` (`node test.mjs`).

## 8. Open conflicts — fix, do not copy

1. **llama.** The rule forbids llama in any ladder or picker, but `mind` still
   names it twice: `src/index.js:69` and `src/index.js:73`, plus
   `src/providers/workers-ai.js:16`. `cods` documents llama-3.2-1b in
   `CF_TEXT_MODELS`. Either the rule or those entries is wrong; resolve before
   adding more.
2. **DeepSeek id.** `mind` uses `@cf/deepseek-ai/deepseek-v4.1-flash-1017`; the
   `cods` doc says `deepseek-v4-flash-0731`. One id is canonical; the other is drift.
3. **The truth worker's gate** is enforced today (`adminGated: true`). Older notes
   describing those routes as open are stale.

4. **Save and erase share one key inside the truth worker.** `adminRequired` compares a
   single `ADMIN_KEY` against every path in `ADMIN_WRITE_PATHS` — create, update, delete
   and promote — so the least-privilege split exists between the two workers, not inside
   the truth worker. That function also returns unguarded when `ADMIN_KEY` is unset,
   where `mind`'s `adminGate` fails closed with 503. Decide whether erase and promotion
   each need their own key before calling the split done.

## 9. Stop and ask

- The change is irreversible, or it touches stored truth, KV or R2 contents.
- It needs a deploy or a push to `main`.
- It would create a worker, or change a binding or namespace.
- A named model is unavailable, or a check fails for a reason you cannot explain.
- Two instructions conflict, or this file disagrees with the code.

## 10. Maintaining this file

Invariants only, one line each, no line numbers, no counts that drift, no open
questions (those belong in `HANDOFF.md`). Delete a rule when it stops being true —
a stale rule is worse than no rule.
```

Two things about the hierarchy mechanism, since it decides whether this actually works:

- An agent opened **in** `cods` never sees a file in `mind`. That repo needs its own three-line `AGENTS.md`: "Rules live in `dno-luigi/mind` `AGENTS.md`; read it first. This repo is described in §7 there. Nothing here overrides it."
- I can't read `cods` from this workspace (separate repo, separate worktree), so §7 is built from your handoff text, and I've labelled it that way rather than presenting it as verified.

