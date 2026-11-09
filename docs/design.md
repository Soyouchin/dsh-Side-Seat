# Design notes

Why the plugin is shaped the way it is. Written after the fact, from the decisions that actually survived contact
with the harness.

## The problem, stated as three costs

Asking a running agent "what did you mean by this?" costs context (the exchange stays in the transcript forever),
attention (the agent drops its task and comes back), and judgement (asking in a fresh session means deciding what
to copy over first — and that step is why most doubts are never asked).

The plugin's job is to remove all three, not to save tokens.

## Four designs that were rejected

| Candidate | Why not |
|---|---|
| Use a subagent / `agents.create` | A subagent is a real session: it shows up in the session list, it needs a hardcoded tool allow-list, and every step is a model call. A "what does this mean" question should be one call. |
| Fork the session | A fork is "the whole conversation again". The cost is the full context, and the answer is still not anchored to the step you doubted. |
| Put the whole session in the prompt | A 1 800-event session is ~100 k tokens. It does not make the answer more correct; it makes it slower, dearer, and easier to derail. |
| Ask the main agent to re-explain | That *is* the pollution. |

The consequence: the side channel **creates no session and runs no agent loop**. It is one `ctx.llm.stream()` call
with a prepared context pack.

## The context pack

Three layers, one hard budget:

- **L0 — anchor window.** The messages around the anchor, verbatim. Measured in **event sequence distance**, not
  turns: `data.turn` resets within a session, so a turn-based window can swallow the entire budget.
- **L1 — skeleton.** One line per message, with the event number: `[187] assistant: …`.
- **L2 — index.** How many turns, how many messages, and every question the user asked.

The budget is a promise, not an estimate. Three degradation plans (full → skeleton tightened → minimal) and then a
character-level hard truncation; the footer reports which one ran. Measured on a real 1 800-event session: ~4 200 of
12 000 tokens.

Layers were chosen over "give the explainer a search tool" because 80 % of questions are about the step in front of
you, and a tool loop costs seconds per hop.

## The explainer's contract

A seven-part system prompt, but three parts carry the weight:

1. It is a **throwaway side seat**: its output is discarded unless promoted, and it must not assume otherwise.
2. **Citations or it didn't happen**: any claim about what the session said needs `[seq]`; without one it must be
   marked as inference.
3. **Uncertainty is stated, not smoothed**: `⚠️不确定：…` rather than fluent hedging.

The four explanation levels are written as *checkable* constraints (which terms may appear, a length ceiling,
whether a counter-example is mandatory), because "please explain simply" is not a constraint — a model's idea of
"simple" is a tone, not a shape.

## Promotion

`to-main` is the only channel back, and it is deliberately annoying:

`preview → user types yes → one framed card is injected`

The framing is load-bearing. `agent.inject()` delivers a **user-role** message with no wrapper of its own, so the
card opens with `【旁听席提炼 · 非用户原话 · 未经主会话验证】` and closes with "whether to adopt it is your call".
The card itself is five fields (claim / evidence / caveat / disagreement / suggestion) capped at 600 characters,
and an over-long card is refused rather than truncated.

## The Remote channel

The panel talks to the host through endpoints the plugin owns. Doing that from an out-of-tree bundle needs no
generator and no vendored packages: `createTypertRemoteInfo` only reshapes `{ package, methods }`, so a hand-written
manifest is enough — provided the loader is the **only** thing that registers it.

The rest of the recipe, and the eight failures that produced it, are listed in the README's "Notes for DSH plugin
authors" table. The short version:

- the service must be a class instance with a `typertRemote` binding;
- every strict codec needs `create()`;
- namespaces and controllers created after `$mount` are read with `ctx.get(...)`;
- calls must match the descriptor's arity exactly;
- failures should be returned as data, because the gateway folds thrown errors into an opaque `gateway/internal`.
