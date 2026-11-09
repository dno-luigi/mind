# SIS — Intelligence Workflow Schema

**Status:** draft v1, for review. Nothing in this document is implemented.
**Date:** 2026-11-06
**Scope:** the four layers that serve `i.nspired.cc` — Truth, AI-PROXY, OR-PROXY, frontend.

This document defines *what decides what*, before any worker is touched. It exists
because the last incident was not a model failure; it was an ownership failure.
The frontend authored a system prompt, AI-PROXY accepted it, and Truth's authority
was bypassed without anyone editing Truth.

---

## 0. Boundary law

Six invariants. Any proposed change that breaks one is rejected regardless of how
well it performs.

| # | Invariant |
|---|---|
| **I1** | **Truth owns knowledge.** Only Truth decides what is known, at what confidence, with what provenance. No other layer asserts a fact into the knowledge store. |
| **I2** | **AI-PROXY owns intelligence.** Only AI-PROXY composes prompts, chooses inference models, and generates conclusions. |
| **I3** | **OR-PROXY owns transport.** It forwards. It never classifies, never prompts, never reasons. |
| **I4** | **The frontend owns presentation only.** It sends the user's material and renders the result. It never constructs a system message, never selects a workflow, never names a model. |
| **I5** | **One prompt authority per operation.** Exactly one layer assembles the instruction set for a given operation, and it is AI-PROXY. |
| **I6** | **Retrieved knowledge is data, not instruction.** A retrieved record may inform an answer; it may never act as a directive, and no retrieved record may instruct the system to change its rules. |

I6 is the invariant that was quietly violated in production: retrieved context was
injected as a `system`-role message reading *"Prefer verified master truths over
memory."* A contaminated record therefore spoke with instruction authority.

---

## 1. The pipeline

```
                      ┌─────────────────────────────────────────┐
   user material ───► │ 01 INTAKE      normalise, classify      │
   text / doc /       │                modality, identity       │
   image / id         └───────────────────┬─────────────────────┘
                                          ▼
                      ┌─────────────────────────────────────────┐
                      │ 02 DECISION    intent + confidence      │
                      │                domain + operation       │
                      │                → routing               │
                      └───────────────────┬─────────────────────┘
                            ┌─────────────┴─────────────┐
                            ▼                           ▼
                   ┌──────────────────┐        ┌──────────────────┐
                   │ 03 DOMAIN        │        │ recall path      │
                   │    AWARENESS     │        │ (KV, no model)   │
                   │  principles,     │        └────────┬─────────┘
                   │  methodology     │                 │
                   └────────┬─────────┘                 │
                            ▼                           │
                   ┌──────────────────┐                 │
                   │ 04 TRUTH         │                 │
                   │    RETRIEVAL     │◄────────────────┘
                   │  master, prov.,  │
                   │  provenance      │
                   └────────┬─────────┘
                            ▼
                   ┌──────────────────┐
                   │ 05 INTELLIGENCE  │
                   │  AI-PROXY: the   │
                   │  full operation  │
                   └────────┬─────────┘
                            ▼
                   ┌──────────────────┐
                   │ 06 RESPONSE      │
                   │  validate, gate, │
                   │  deliver         │
                   └──────────────────┘
```

Three properties of this shape matter more than the boxes:

1. **Cards 02–05 all live in AI-PROXY.** OR-PROXY is a forwarder and cannot host a
   stage without becoming a second intelligence layer (I3). Truth is reachable from
   card 04 as a service binding, not as a call the caller makes.
2. **Every arrow carries the same envelope** (§2), so no stage can silently widen
   the operation's scope or authority.
3. **The recall path is a branch, not a shortcut.** Recall is a legitimate terminal
   workflow (card 02 → 04 → 06), not a failure of the audit path.

---

## 2. The operation envelope

One record flows through all six cards. Stages append; none rewrites a field it does
not own. This is the schema the workers would actually exchange.

```jsonc
{
  "op_id": "op-7f3a…",              // set by 01, immutable
  "created_at": "2026-11-06T12:00:00Z",

  "input": {                         // 01 — Intake
    "kind": "text | document | image | identifier | mixed",
    "chars": 8421,
    "modality": ["text"],
    "material": "<normalised user material>",
    "identifiers": ["MSB26006196"],
    "truncated": false
  },

  "decision": {                      // 02 — Decision Model
    "intent": "truth_audit | recall | generate | unknown",
    "confidence": 0.95,
    "domain": "civil_litigation",
    "subdomains": ["docket", "service"],
    "operation": "full_audit | targeted_query | kv_lookup | none",
    "routing": "audit | recall | clarify | refuse",
    "basis": "multi-question case summary with procedural history",
    "model": "@cf/…",
    "needs_clarification": false
  },

  "domain": {                        // 03 — Domain Awareness
    "principles_ref": "domain:civil_litigation@3",
    "methodology": ["timeline reconstruction", "burden analysis"],
    "patterns": [                      // similar, not identical — see §5
      { "ref": "audit:…", "shareable": true, "pii": "none" }
    ],
    "excluded": [                      // records withheld from this op
      { "ref": "audit:…", "reason": "pii" }
    ]
  },

  "evidence": {                      // 04 — Truth Retrieval
    "authoritative": [
      { "ref": "truth:master:<sha>", "layer": "master", "provenance": "…",
        "verified": true, "weight": "authoritative" }
    ],
    "provisional": [],
    "conflicts": [],
    "gaps": ["no docket entry for 2026-03-14"],
    "status": "resolved | partial | miss"
  },

  "result": {                        // 05 — Intelligence
    "text": "<the report>",
    "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "route": "workers-ai | openrouter",
    "tokens": { "in": 0, "out": 0 }
  },

  "verdict": {                       // 06 — Response
    "status": "completed | insufficient_evidence",
    "claimed_status": "completed",
    "status_refused": false,
    "structural_score": 0.85,
    "confidence": null,              // never a probability — see §4
    "violations": [],
    "missing_sections": [],
    "delivered": true
  }
}
```

`confidence: null` in `verdict` is deliberate and non-negotiable: the gate measures
structural compliance, not factual accuracy, and must never be presented as an
evidence probability. Numeric confidence belongs in `decision` (a routing
confidence, which is measurable) and nowhere else.

---

## 3. The six cards

Each card has one owner, one input, one output, one failure mode and one gate. A card
that fails its gate degrades the operation; it does not fabricate a pass.

### 01 — Intake

| | |
|---|---|
| **Function** | Capture and normalise user input |
| **Owner** | AI-PROXY (edge of card 02) |
| **Input** | Raw request body from the frontend |
| **Output** | `input` block |
| **Selects model by** | modality — text-only intake needs a cheap text model; image input needs a multimodal one |
| **Failure mode** | Oversized material is truncated with `truncated: true` and the truncation is stated in the final output, never hidden |
| **Gate** | `material` non-empty; kind determined; if `truncated`, downstream is told |

Rules:
- Discards any `system` message supplied by the caller (I4, I5). This is already
  implemented and must remain.
- Does not interpret. Classification is card 02's job — mixing them is how a keyword
  table ends up masquerading as a decision model.

### 02 — Decision Model

| | |
|---|---|
| **Function** | Determine intent and workflow |
| **Owner** | AI-PROXY |
| **Input** | `input` block |
| **Output** | `decision` block |
| **Model** | Cheap, fast, strict-JSON. A 70B is not required and should not be the default; an 8B-class model returning a schema-validated object is the target (to be verified against the account's catalogue) |
| **Gate** | Output parses as JSON and validates against the `decision` contract; unparseable → `routing: "clarify"` |
| **Failure mode** | Model unreachable → **do not guess**. Route to `unknown` and answer the question directly without an audit claim |

The decision model **routes; it does not answer.** It is the one place a cheap model
belongs, and the one place a wrong answer is cheap: misrouting an audit to recall
loses fidelity, but misrouting recall to audit burns tokens and can produce an
unsupported report.

Confidence bands — the rubric the model is asked to apply, not a keyword table:

| Confidence | Intended | Behaviour |
|---|---|---|
| ≥ 0.80 | clear | route silently |
| 0.50–0.80 | plausible | route, and say so in the response metadata |
| < 0.50 | ambiguous | `routing: "clarify"` — ask one question instead of guessing |
| — | `generate` with no audit claim | answer directly; no gate, no `completed` status |

This is the distinction your draft makes and it is the important one: a short
identifier is **not** a failed audit, it is a recall.

### 03 — Domain Awareness

| | |
|---|---|
| **Function** | Identify relevant domains and principles |
| **Owner** | AI-PROXY, reading Truth for the principle set |
| **Input** | `input` + `decision` |
| **Output** | `domain` block |
| **Gate** | `principles_ref` resolves to a known version, or the op proceeds with universal principles only and records the absence |
| **Failure mode** | No domain match → universal principles alone, `domain.principles_ref: null`. Never invent domain rules |

Two rules that need to be in the schema because they have security consequences:

1. **Similar ≠ identical.** A prior audit of a different case contributes
   *methodology* (how to reconstruct a timeline, how to test a burden) and never
   *facts*. Records carry `shareable` and `pii` so the selector can exclude rather
   than rely on good intentions.
2. **Domain principles are subordinate.** A domain rule can refine how universal
   principles are applied. It can never override them (§4).

### 04 — Truth Retrieval

| | |
|---|---|
| **Function** | Find authoritative and similar records |
| **Owner** | Truth, via service binding. AI-PROXY calls it; it does not read the store directly |
| **Input** | `input` + `decision` + `domain` |
| **Output** | `evidence` block |
| **Gate** | Every returned record carries `ref`, `layer`, `provenance`, `verified` |
| **Failure mode** | Truth unreachable → `status: "miss"`, `evidence` empty, and the operation continues *as an audit that states it had no authoritative input*. A missing Truth must never look like a clean record |

**Matching records are evidence inputs, not conclusions.** Card 04 assembles; card 05
weighs. If a matched master truth could terminate the operation early, that is the
recall path (card 02), not this one.

This is also where I6 is enforced mechanically: `evidence` reaches card 05 as
*data* — a labelled block in the user turn, or a delimited data section — never as a
`system` role. Converting retrieved text into an instruction is the single change
that would re-create the original fault.

### 05 — Intelligence

| | |
|---|---|
| **Function** | AI-PROXY performs the selected analysis |
| **Owner** | AI-PROXY |
| **Input** | the whole envelope |
| **Output** | `result` block |
| **Model** | Selected per operation. Audit needs a strong instruct model; recall needs none; generation needs a middle tier |
| **Gate** | Produces text conforming to the operation's output contract (for audit: the nine required sections) |
| **Failure mode** | Primary model fails → fallback model with the **same** message array, so the prompt authority is unchanged. A fallback that changes the prompt is a second authority |

The audit instruction set is fixed at this layer and comes from exactly one source:
the versioned `AUDIT_SYSTEM_PROMPT_V2`. The nine sections are:

`Executive Summary` · `Case Particulars` · `Docket Events` · `Verified Findings` ·
`Procedural Analysis` · `Evidentiary Gaps` · `Unresolved Questions` ·
`Recommended Records Verification` · `Conclusion`

### 06 — Response

| | |
|---|---|
| **Function** | Validate and deliver the completed result |
| **Owner** | AI-PROXY (gate is deterministic, not a model) |
| **Input** | `result` + envelope |
| **Output** | `verdict` block, then transport via OR-PROXY to the frontend |
| **Gate** | `evidence-gate.mjs`: sections present and in order, every verified finding sourced, no unsupported criminal/procedural/enforcement assertion |
| **Failure mode** | Gate passes → `completed`. Gate fails → `insufficient_evidence`, the claimed status is refused and recorded in `status_refused` |

The gate never repairs a report into a narrative. It refuses. A refused report is
delivered as `insufficient_evidence` — the user still gets the analysis, minus the
false completion claim.

**Storage rule:** only `completed` results may be written as learn/provisional
records. Both the create and update paths must check the gate. A gated write is how a
bad report would otherwise become tomorrow's authority.

---

## 4. The three rule sets

| Set | Mutability | Owner | Precedence |
|---|---|---|---|
| **Universal Principles** | Immutable | Truth, versioned, never edited in place | 1 (highest) |
| **Behavioural & Ethical Principles** | Immutable | Truth, versioned | 2 |
| **Domain-Specific Principles** | Versioned, extensible | Truth, versioned per domain (`domain:civil_litigation@3`) | 3 |

Precedence is lexical in the literal sense: a lower set can never relax a higher one.
A domain principle may say *how* to apply an evidentiary standard; it may not say
that an unsupported assertion is acceptable in this domain. If a domain rule
appears to conflict with a universal rule, the domain rule is wrong and the
operation proceeds under the universal rule, with the conflict recorded.

Why immutable matters operationally: an immutable set is a thing a gate can cite. A
mutable set is a thing a prompt can drift away from. If these three sets are edited
per-case, the gate in card 06 has nothing stable to enforce and the schema degrades
into a style guide.

---

## 5. Model selection, explicitly separated

Three roles, three different cost/fidelity trade-offs. Conflating them is what the
previous design did.

| Role | Card | Characteristic | Failure cost |
|---|---|---|---|
| **Intake / decision** | 01–02 | cheap, fast, strict JSON, multimodal if needed | low — a misroute, recoverable |
| **Intelligence** | 05 | strong instruct model, long context | high — this is the answer |
| **Validation** | 06 | *no model* — deterministic | n/a |

Two consequences worth stating:

- **The intake model need not be the audit model.** They are selected by different
  criteria and can be different vendors. Your draft is right about this.
- **Primary/fallback is not model selection.** Fallback is resilience: same prompt,
  same contract, different vendor. Selection is a decision made *before* generation.

Current proven positions, for reference: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
as primary, `openrouter/free` as fallback with the identical message array. Neither
is a decision model, and neither should be used as one.

---

## 6. What this schema requires that does not exist yet

An honest gap list, from the audit of the four repos as they stand.

| Card | Today | Gap |
|---|---|---|
| 01 Intake | `handleAudit` accepts messages, strips client `system` | no kind/modality/identifier detection, no truncation reporting |
| 02 Decision | **absent** — every request on `/v1/audit` is treated as an audit | the whole card. No intent classification, no confidence, no clarify path |
| 03 Domain | **absent** — the audit prompt is domain-agnostic | domain registry, principle versioning, methodology/PII separation |
| 04 Truth | `contextBlock` retrieval, `MASTER_TRUTHS` | retrieval exists but reaches the model as a `system` turn (I6 violation), and returns text, not `evidence` records with `verified`/`provenance` |
| 05 Intelligence | working: V2 prompt, model honoured, fallback, 4000 cap | server-side model selection per operation |
| 06 Response | working: deterministic gate, 9 sections | gate exists; the envelope around it does not |

So the picture is: **cards 05 and 06 are built, 01 and 04 are partial, 02 and 03 do
not exist.** That is a much smaller build than the diagram suggests, and it is
sequenced — card 02 is the hinge, because without it card 03 has no domain to look up
and card 06 has no `claimed_status` to refuse.

There is also a working precedent worth reusing rather than inventing: the `mind`
worker already runs a `decide()` ladder that classifies task/depth/preset and degrades
to `intent:fallback` when the model is unavailable. Card 02 is that pattern with a
different contract.

---

## 7. Non-goals (v1)

Stated to keep scope from creeping:

- **Not a multi-agent system.** Six cards, one of which is a model call. No planners,
  no critic agents.
- **Not a memory rewrite.** KV/D1/R2 layout is untouched; card 04 adapts to what
  exists.
- **Not a UI redesign.** The frontend sends material and renders a verdict. Card 06
  gains a visible `insufficient_evidence` state; that is the only UI consequence.
- **Not a confidence score.** `verdict.confidence` stays `null`. If a numeric
  evidence probability is ever wanted, it needs a calibrated model of its own and a
  separate document.
- **Not multilingual, not streaming-first, not custom.** Audit is a single
  non-streamed response; the streaming path stays for chat.

---

## 8. Open questions

Decisions I should not make on your behalf:

1. **Who owns the decision prompt?** If card 02's instructions live in AI-PROXY, they
   are code. If they live in Truth, they are knowledge. I would put them in AI-PROXY
   (they are operational, not factual), but that is a boundary call.
2. **Where does the domain registry live?** Truth is the natural owner (versioned
   knowledge), which makes card 03 a retrieval card rather than an inference card.
   The alternative — a static table in AI-PROXY — is faster and drifts.
3. **What happens on `routing: "clarify"`?** One question, or a best-effort answer
   labelled as unclassified? The former is more honest and adds a round trip.
4. **Is `insufficient_evidence` a hard stop or a warning?** Today it is delivered with
   the analysis. Whether the user may then re-run with more material is a product
   decision.
5. **Does recall also need card 06?** A KV record can be stale or contradicted. I
   would gate recall on `verified: true` and skip the full gate.

---

## 9. Order of work, if this is approved

Each step is independently testable offline, and each has one test that must exist
before the next step starts.

1. **Envelope + card 01.** Introduce the record; make `/v1/audit` build one. Test:
   a request with a client `system` message produces an envelope whose `input` block
   is clean and whose `material` is intact.
2. **Card 02.** Classification with the confidence bands, JSON-validated. Test: the
   long case summary from your draft classifies `truth_audit` ≥ 0.80; a bare
   identifier classifies `recall`; garbage produces `routing: "clarify"`, never an
   audit.
3. **Card 06 wired to the envelope.** The gate already works; make it read
   `result.text` and write `verdict`, and make storage conditional on it. Test: the
   incident fixture yields `insufficient_evidence` with `status_refused: true` and is
   not written to KV.
4. **Card 04 as records.** Replace the `system`-role injection with an `evidence`
   block carrying `verified`/`provenance`. Test: a record whose content reads like an
   instruction does not change the operation's instruction set.
5. **Card 03.** Domain registry in Truth, principles by version, methodology/PII
   separation. Test: two cases in the same domain share methodology and share no
   PII reference.

Steps 1–3 fix the incident. Steps 4–5 make the diagram true. The order matters: 4
depends on the envelope from 1, and 5 is the only step that requires a Truth change —
which is the one thing worth doing last, deliberately, with its own review.
