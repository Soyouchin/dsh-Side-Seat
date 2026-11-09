# Changelog

## 0.6.1

- Move the per-message entry from the turn tail into the assistant action row
  (beside copy / like / dislike / share).
- Add `sideSeat/anchor`: the host resolves a durable `messageId` to the event
  sequence, because that row does not receive the sequence.
- Read the right-bar controller through `ctx.get('sidebarRight')`. Direct
  property access throws "without inject", and a `try`/`catch` around it made
  the click silently do nothing.

## 0.6.0

- Per-message "ask about this one" entry with an anchor chip in the panel.

## 0.5.1

- The Remote service is a class instance with a plain `handlers` property.
  A `#private` field cannot be read when Cordis invokes the method through its
  service proxy; the gateway folded that `TypeError` into an opaque
  `gateway/internal`.
- Handler failures are returned as `{ ok: false, error }` instead of thrown, so
  the panel can show the real reason.

## 0.5.0

- The side panel: question box, level and mode controls, recorded turns, and
  the anchor chip. It talks to the plugin's own Remote endpoints, so nothing
  appears in the transcript.
- Endpoints `sideSeat/ask` and `sideSeat/threads`.

## 0.4.5

- Fix `gateway/binding-invalid`: the service must be a class instance whose
  methods live on the prototype and that carries a `typertRemote` binding.

## 0.4.4

- Fix `cannot get property "remote.sideSeat" without inject`: the namespace only
  exists after `$mount`, so it is read through `ctx.get` and polled until ready.

## 0.4.3

- Fix `strict codec has no create() factory`: every strict codec in the client
  contribution needs a `create()` factory.

## 0.4.2

- Fix the unreachable panel: a page tab type needs a `guide` entry to appear in
  the right bar, and `title` must be a function.

## 0.4.1

- **Do not register the typert face manually.** Exporting `./typert` already
  makes `dsh-typert-loader` register it; a second registration is a duplicate
  package face, the loader's batch fails on the next start, and every strict
  endpoint (including `settings/describe`) loses its definition — the Desktop
  client then fails to boot.

## 0.4.0

- Remote channel probe: a hand-written `typert` manifest and a client
  contribution, ending in a `ping → pong` round trip.

## 0.3.1

- Two-step `to-main` (preview, then `yes`), because an injected message cannot
  be withdrawn from an append-only log.
- `/seat here` lists the recent outputs with their event numbers.
- The explainer is told how the answer is rendered: plain text, conclusion on
  the first line, ≤ 50 characters per line, ≤ 25 lines, no markdown.

## 0.3.0

- Plain-text output that fits the 260 px command-result box.

## 0.2.0

- `/seat export`, `/seat selftest`, and a compact one-line footer.
- Fix the context pack reading only one of the two message shapes in the
  session log (`user/message` and `tool/result` store content at `data.content`),
  which silently dropped every question.
- Anchor windows are measured in events, not turns: `data.turn` resets within a
  session, and a turn-based window swallowed the whole budget (29 043 tokens
  against a 12 000 budget).

## 0.1.0

- `/seat`: ask the current session a question; the answer never enters it.
- Layered context pack, four explanation levels, challenge mode, `to-main`
  distillation card, per-session thread storage.
