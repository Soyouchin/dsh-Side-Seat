# Side Seat

> Ask this DSH session a question without putting the answer into it.

A [DSH](https://github.com/deepseek-ai) (DeepSeek Harness) plugin. It opens a **side channel** next to a running
session: a place that remembers what the session said, answers your questions about it, and — unless you explicitly
say otherwise — never writes a single word into the main conversation.

中文说明：[README.zh-CN.md](./README.zh-CN.md)

---

## Why this exists

You are working with an agent. Somewhere in its output a detail bothers you: a p-value that looks off, a step you
don't follow, a claim you don't buy. Asking in the main session costs three things at once:

1. **Context** — the exchange stays in the transcript forever, and every later request carries it.
2. **Attention** — the agent has to drop what it was doing to explain, then get back to it.
3. **Judgement** — to ask in a *new* session you have to decide what to copy over. That effort is the real cost,
   and it is why most doubts are silently swallowed.

Those swallowed doubts are usually what you have to redo later. This plugin makes them cheap to ask.

## What you get

**A right-bar panel.** Open it from the right bar's start page → *旁听席*. Ask in the box (Ctrl+Enter),
switch the explanation level (L1 layperson … L4 rigorous) and the mode (explain / challenge). Answers are kept per
session and reappear when you reopen the panel. Nothing appears in the transcript.

**A per-message entry.** Every finalized assistant message gets a small speech-bubble button in its action row
(next to copy / like / dislike / share). Click it and the panel opens **anchored to that message**, so the next
question is about that exact step rather than the session at large.

**Slash commands** for the same thing without the panel:

```
/seat 这个 p 值 0.03 是怎么算出来的？     # ask (any language)
/seat l1 什么是多重检验校正？              # L1 … L4 explanation level
/seat ? 这个结论站得住吗                   # challenge mode
/seat @187 这一步的 df 怎么估的？          # pin the anchor to event 187
/seat here                                 # list recent outputs with their event numbers
/seat ls | show 1 | use 1 | del 1 | new
/seat export 1                             # write the thread out as markdown
/seat selftest                             # diagnostics: model, snapshot, pack size, threads
/seat to-main 1                            # preview the distillation card (sends nothing)
/seat to-main 1 yes                        # send it into the main session (add `wake` to resume it)
```

## Install

Until it is on npm, install it from a local checkout or a git URL.

**From this directory** (DSH Desktop → Plugins → install a bundle by path), or with the CLI when `dsh` is on your
`PATH`:

```bash
dsh plugin add /absolute/path/to/side-seat
# or, once the repository is published
dsh plugin add https://github.com/Soyouchin/dsh-Side-Seat
```

The bundle contributes one host plugin and one web-client plugin; DSH installs both. A DSH restart (or a page
reload, for the client half) is needed after installing.

## Configuration

The plugin reads its row's `config` from the profile's `cordis.patch.yml`:

```yaml
config:
  level: 3                 # default explanation level (1-4)
  mode: explain            # explain | challenge
  provider: deepseek       # omit to use the session's default model
  model: deepseek-chat
  budgetTokens: 12000      # hard budget for the context pack
  maxThreads: 20
  maxTokens: 1600          # max answer length
  selfTest: false          # true = run the diagnostics once on every activation
  storeDir: '~/.dsh/side-seat'
```

It declares no `Config` schema on purpose: the schema type comes from a package inside the DSH installation, which a
linked bundle cannot resolve. Configuration is validated by nothing, so typos fail at use, not at load.

## How it works

```
session log ──(sessionQuery)──▶ context pack ──▶ one llm.stream() call ──▶ answer
                                     │                                      │
                       anchor window + skeleton + index                   │
                                                                            ▼
                                       right-bar panel ◀── @Remote ── sideSeat/ask
                                                                            │
                              to-main: distillation card ──▶ agent.inject() ─┘ (user-confirmed only)
```

- **No subagent, no fork, no tool.** A subagent would create a real session per question (visible in the session
  list, with a hardcoded tool allow-list and a multi-second agent loop); a fork copies the whole context. A plain
  question needs one model call with a prepared context pack.
- **The context pack is layered and hard-capped**: the anchor's neighbourhood verbatim, a one-line-per-message
  skeleton, an index of the questions asked, and a hard token budget enforced by three degradation steps plus a
  character-level truncation. Real session, 1 800 events: ~4 200 tokens of 12 000.
- **Zero pollution by construction**: no session is created, no tool is registered, no event is appended. The only
  channel back is `to-main`, which delivers one framed card (`【旁听席提炼 · 非用户原话 · 未经主会话验证】`) as a
  user-role message, after a preview step, because the log is append-only and cannot be un-sent.
- **The explainer knows it is temporary**: its system prompt says it is a throwaway side seat, that its output is
  discarded unless promoted, that every claim about the session needs a `[seq]` citation, and that it must answer
  "out of scope" when asked to do work.

## Notes for DSH plugin authors

Everything below failed at least once while building this, and each failure is pinned by a test now. They are worth
knowing before writing your own client-side plugin.

| Trap | Symptom | Fact |
|---|---|---|
| Registering the typert face twice (manual `ctx.typert.register()` **and** the `./typert` export) | The client fails to boot | `dsh-typert-loader` already registers any mounted entry that exports `./typert`. The duplicate package face makes the loader's batch fail on the next start, and **every** strict endpoint (including `settings/describe`) loses its definition. |
| A page tab type without `guide` | The panel exists but cannot be opened | The right bar's start page lists guide entries only. Also `title` must be a function. |
| A strict codec without `create()` | `strict codec has no create() factory` | The client contribution is validated on `$mount`; every strict codec needs a factory. |
| Reading `ctx.remote.<ns>` as a property | `cannot get property "remote.sideSeat" without inject` | The namespace service appears only after `$mount`; read it through `ctx.get('remote.<ns>')` and poll until mounted. Same for `ctx.sidebarRight`. |
| A service object literal | `gateway/binding-invalid` | The service must be a **class instance** with methods on the prototype and a `typertRemote = { service, serviceKey, namespace }` binding. |
| Sub-arity calls | `expected N business argument(s)` | The gateway compares the argument count with the descriptor exactly; optional trailing parameters must still be passed as `undefined`. |
| `#private` fields in a service | `gateway/internal` with no message | Cordis invokes methods through its service proxy, so `this` is the proxy and private state is unreadable. Use a plain property. Better: return failures as `{ ok: false, error }` so the message survives. |
| Reading only one message shape from the log | Silently empty answers | `assistant/message` stores content at `data.message.content`; `user/message` and `tool/result` store it at `data.content`. |
| Anchoring by `data.turn` | The whole budget consumed | `data.turn` resets within a session; measure anchor windows in event sequence distance. |
| Assuming markdown rendering | `**bold**` shown literally | A command result renders as a collapsed summary line plus a 260 px `<pre>` box. Plain text, conclusion first. |

The last four are covered by offline assertions (prototype/signature checks, codec shape, call arity, and a
host-vs-client endpoint parity check), so they fail in `npm test` rather than in someone's browser.

## Verification

```bash
npm test     # 56 assertions across four suites
node tools/replay.mjs 12000   # run the context pack builder against a real session log
```

- **56 assertions, all passing**: `test/core.test.mjs` (31 — layered digest, hard budget, level contracts,
  distillation card, store isolation, service binding/signature), `test/integration.test.mjs` (12 — command path,
  zero injection, two-step promotion, export, diagnostics), `test/client.test.mjs` (8 — the client module executed
  against a stub loader and React, codec shape, arity, anchor wiring, host/client parity), `test/package.test.mjs`
  (5 — every export resolves to a shipped file, the patch inserts this package, the client id matches the package
  name, the icon is self-contained).
- **Ran in a real DSH**: the command path completes end to end (parse → read log → model → answer) in ~1.4 s, and
  the panel's `ping` round-trips through the gateway.
- **Not verified**: answer *quality* (only its shape is checkable), and the visual polish of the panel beyond
  "it renders". There is no automated browser here, so every UI regression so far was found by a human clicking.

## Limitations

- No streaming yet: the panel shows a spinner and then the whole answer.
- `to-main` is command-only (`/seat to-main 1 yes`); the panel does not have a promote button yet.
- One thread model: questions accumulate in the session's current thread unless you start another with `/seat new`.
- The panel's own answers are stored per session as JSON files under `storeDir`; they are not encrypted.

## License

MIT — see [LICENSE](./LICENSE).
