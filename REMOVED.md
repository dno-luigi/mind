# clef → ARA in mind: what was removed, and why

Written 2026-11-15 on the owner's instruction to replace clef with ARA.

## Deleted from src/decide.js

- `LADDER` (clef-flash 24,576 → clef-omni 64,000 → clef 65,536) and `QUESTIONS`
  (task, preset, depth, tone).
- `parseDecision()` — the JSON reader for clef's reply.
- `intentFor()` — the ladder walk itself, including images passed to clef.
- `budgetState()` — the state shrinker that existed to fit clef's window.
- `RUNG_TIMEOUT_MS`, `BROWSE_WORTHY` (nothing was left to classify into it).

## Added in its place

- `fromAra(ara, presetId)` — her action is the preset (`truth`, `operator`,
  `mnl`, `doc`, `micro`), `style` is the Stylist task, `browse` reads the page
  first. Unbound, the old `operator` default stands.
- Her action is known before the cache is consulted, so a stored truth can no
  longer answer a request she routed somewhere else. Only `truth` (and the
  unbound default) may be served from the store.

## Behaviour that was lost with clef

- clef used to pick a preset by reading the ask. Now the preset is her action,
  or the client's pick, or `operator`.
- clef's `depth` and `tone` are fixed at `normal`/`plain`; nothing asks for them.
- clef's image reading is gone; images still go to the model that answers.

## Tests (test.mjs)

Deleted, because they measured clef: "decision ladder escalates when the
smallest window refuses", "the openrouter rung references the preset…", "the
same Truth prompt is what openrouter sends", "the pipeline traces cache, intent,
browse, user and operator in order", "clef picks the model when no preset is
pinned…", "a style request never takes the stored answer", "selecting no preset
drops the preset prompt but keeps the decision", "a repeat decision is served
from memory…", "a KV hit is labelled as such…", "switching Cloudflare off sends
chat to the free router".

Rebound to her: 13 tests that pinned no preset now bind `araStub('<action>')`,
and the trace source reads `intent:ara` instead of `intent:clef-flash`.

At the time of writing: 111 passed, 0 failed (was 120 before the removal).
