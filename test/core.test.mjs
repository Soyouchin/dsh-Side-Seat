import test from 'node:test'
import assert from 'node:assert/strict'

import { buildContextPack, describeEvent, estimateTokens, textOf } from '../lib/digest.js'
import { buildSystemPrompt, LEVELS, MODES } from '../lib/prompt.js'
import { ThreadStore } from '../lib/store.js'
import {
  CARD_LIMIT, cardChars, cardTooLong, fallbackCard, normalizeCard, parseCardJson,
  renderInjection, validateCitations,
} from '../lib/promote.js'

// ---------------------------------------------------------------- fixtures

const msg = (text, extra = []) => ({ role: 'assistant', content: [{ type: 'text', text }, ...extra] })

function turn (n, question, answer, baseSeq) {
  return [
    { type: 'turn/start', seq: baseSeq, time: baseSeq, data: { turn: n } },
    { type: 'user/message', seq: baseSeq + 1, time: baseSeq + 1, data: { turn: n, message: { role: 'user', content: [{ type: 'text', text: question }] } } },
    { type: 'assistant/message', seq: baseSeq + 2, time: baseSeq + 2, data: { turn: n, message: msg(answer) } },
    { type: 'turn/end', seq: baseSeq + 3, time: baseSeq + 3, data: { turn: n, reason: { kind: 'completed' } } },
  ]
}

const log = [
  ...turn(1, '先看哪种抽样方法？', '用分层抽样，因为批次效应明显。', 0),
  ...turn(2, '为什么用 Welch t 检验？', '不假设方差齐性。', 4),
  ...turn(3, '这个 p 值 0.03 怎么来的？', 'Welch t 检验，双侧，df 约 12.4。', 8),
  ...turn(4, '那下一步写方法学？', '先补敏感性分析。', 12),
]

// ---------------------------------------------------------------- digest

test('describer reads text blocks and tool calls', () => {
  const user = describeEvent({
    type: 'user/message', seq: 7,
    data: { turn: 2, message: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
  })
  assert.equal(user.role, 'user')
  assert.equal(user.text, '你好')
  assert.equal(user.turn, 2)

  const call = describeEvent({ type: 'tool/call', seq: 9, data: { turn: 2, name: 'exec', arguments: '{"cmd":"ls"}' } })
  assert.equal(call.role, 'tool-call')
  assert.equal(call.tools[0].name, 'exec')
})

test('textOf survives string content and unknown blocks', () => {
  assert.equal(textOf({ content: 'plain' }), 'plain')
  assert.equal(textOf({ content: [{ type: 'image' }, { type: 'text', text: 'x' }] }), 'x')
  assert.equal(textOf(null), '')
})

test('reads the flat content shape used by user/message and tool/result', () => {
  // The committed log wraps assistant content in data.message, but stores user
  // and tool content directly in data.content. Reading only one shape silently
  // drops every question from the pack.
  const user = describeEvent({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '为什么这样抽样？' }] } })
  assert.equal(user.text, '为什么这样抽样？')

  const result = describeEvent({
    type: 'tool/result', seq: 2,
    data: { message: { role: 'tool' }, content: [{ type: 'text', text: '执行结果' }] },
  })
  assert.equal(result.text, '执行结果')

  const pack = buildContextPack([
    { type: 'turn/start', seq: 0, data: {} },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '为什么这样抽样？' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: '因为批次效应。' }] } } },
  ], { anchorSeq: 2 })
  assert.ok(pack.text.includes('为什么这样抽样？'), 'the flat-shape question must reach the index')
})

test('assistant reasoning reaches the skeleton when there is no visible text', () => {
  const row = describeEvent({
    type: 'assistant/message', seq: 5,
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '先验证再改' }, { type: 'tool-call', name: 'run', arguments: '{}' }] } },
  })
  assert.equal(row.text, '')
  assert.equal(row.reasoning, '先验证再改')
  const pack = buildContextPack([
    { type: 'turn/start', seq: 0, data: {} },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'q' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } } },
    { type: 'assistant/message', seq: 5, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '先验证再改' }, { type: 'tool-call', name: 'run', arguments: '{}' }] } } },
  ], { anchorSeq: 5 })
  assert.ok(pack.text.includes('先验证再改'))
})

test('pack never contains anything after throughSeq', () => {
  const pack = buildContextPack(log, { throughSeq: 11, anchorSeq: 7 })
  assert.equal(pack.throughSeq, 11)
  assert.ok(!pack.text.includes('[12]'), 'events after the snapshot must not appear')
  assert.ok(!pack.text.includes('[13]'))
})

test('anchor window carries the anchor message verbatim, plus the question it answers', () => {
  const anchorSeq = 10 // turn 3 assistant message
  const pack = buildContextPack(log, { anchorSeq })
  assert.equal(pack.anchorTurn, 3, 'anchor turn is the ordinal of turn/start events')
  const l0 = pack.text.split('## L0 锚点窗口（原文）')[1]
  assert.ok(l0.includes('Welch t 检验，双侧，df 约 12.4'), 'anchor text must be verbatim')
  assert.ok(l0.includes('这个 p 值 0.03 怎么来的？'), 'the question the anchor answers is always carried')
})

test('the anchor window is bounded by event distance, not by turn length', () => {
  const events = []
  let seq = 0
  events.push({ type: 'turn/start', seq: seq++, data: { turn: 1 } })
  events.push({ type: 'user/message', seq: seq++, data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '一个问题' }] } } })
  // ONE turn with 400 steps: a turn-based window would swallow everything.
  for (let i = 0; i < 400; i++) {
    events.push({ type: 'tool/call', seq: seq++, data: { turn: 1, name: 'run', arguments: `{"i":${i}}` } })
    events.push({ type: 'tool/result', seq: seq++, data: { turn: 1, message: msg(`结果 ${i}`.repeat(50)) } })
  }
  const anchorSeq = seq - 1
  events.push({ type: 'assistant/message', seq: seq++, data: { turn: 1, message: msg('最后一条回答') } })
  const pack = buildContextPack(events, { anchorSeq, budgetTokens: 12000 })
  const l0 = pack.text.split('## L0 锚点窗口（原文）')[1] ?? ''
  assert.ok(l0.length < 12000, `the anchor window must stay small, got ${l0.length} chars`)
  assert.ok(pack.tokens <= 12000)
})

test('L2 lists every question that was asked', () => {
  const pack = buildContextPack(log, { anchorSeq: 10 })
  assert.ok(pack.text.includes('先看哪种抽样方法？'))
  assert.ok(pack.text.includes('那下一步写方法学？'))
})

test('tight budget degrades instead of silently overflowing', () => {
  const pack = buildContextPack(log, { anchorSeq: 10, budgetTokens: 200 })
  assert.ok(pack.degraded.length > 0, 'degradation must be reported')
  assert.ok(pack.tokens <= 200, `pack must respect the budget, got ${pack.tokens}`)
})

test('a long session stays inside the budget — the promise, not an estimate', () => {
  const big = []
  let seq = 0
  for (let turn = 1; turn <= 400; turn++) {
    big.push({ type: 'turn/start', seq: seq, time: seq, data: { turn } })
    big.push({
      type: 'user/message', seq: ++seq, time: seq,
      data: { turn, message: { role: 'user', content: [{ type: 'text', text: `第 ${turn} 个问题：这一步为什么要这样处理？` }] } },
    })
    big.push({
      type: 'assistant/message', seq: ++seq, time: seq,
      data: { turn, message: msg(`第 ${turn} 个回答：`.padEnd(1) + '因为批次效应、方差不齐和多重比较都会影响结果，所以这里用了分层抽样加 Welch 校正。'.repeat(3)) },
    })
    big.push({ type: 'turn/end', seq: ++seq, time: seq, data: { turn, reason: { kind: 'completed' } } })
    seq++
  }

  for (const budget of [12000, 4000, 1500]) {
    const pack = buildContextPack(big, { anchorSeq: big.length - 3, budgetTokens: budget })
    assert.ok(pack.tokens <= budget, `budget ${budget} exceeded: ${pack.tokens}`)
    assert.ok(pack.degraded.length > 0, 'a 400-turn session must report degradation')
    assert.equal(pack.overBudget, false, 'truncation already lands inside the budget')
  }
})

test('estimateTokens counts CJK closer to one-per-char than latin', () => {
  assert.ok(estimateTokens('你好世界') >= 4)
  assert.ok(estimateTokens('hello world') < 4)
})

// ---------------------------------------------------------------- prompt

test('every level is a distinct, checkable contract', () => {
  assert.equal(Object.keys(LEVELS).length, 4)
  for (const level of Object.values(LEVELS)) {
    assert.ok(level.rules.length > 40, `L${level.id} rules must be substantive`)
  }
  assert.match(LEVELS[1].rules, /300 字/)
  assert.match(LEVELS[3].rules, /不成立/)
  assert.match(LEVELS[4].rules, /可查证来源/)
})

test('system prompt carries identity, mode and level', () => {
  const p = buildSystemPrompt({ level: 2, mode: 'challenge', snapshot: { anchorSeq: 42 } })
  assert.match(p, /旁听席/)
  assert.match(p, /你没有存在意义|临时的/)
  assert.match(p, /\[seq\]/)
  assert.match(p, /质疑/)
  assert.match(p, /L2 同实验室非同行/)
  assert.match(p, /事件 42/)
  assert.notEqual(p, buildSystemPrompt({ level: 2, mode: 'explain', snapshot: { anchorSeq: 42 } }))
  assert.notEqual(buildSystemPrompt({ level: 1 }), buildSystemPrompt({ level: 4 }))
})

test('modes differ in the risk they guard against', () => {
  assert.match(MODES.explain.rules, /听懂/)
  assert.match(MODES.challenge.rules, /推翻/)
})

test('the prompt states the renderer limits the UI actually imposes', () => {
  // The command result is rendered as a collapsed one-line summary plus a
  // 260px <pre> box: markdown would show up as literal characters.
  const prompt = buildSystemPrompt({ level: 3 })
  assert.match(prompt, /纯文本/)
  assert.match(prompt, /第一行必须是一句话结论/)
  assert.match(prompt, /不超过 50 个字/)
  assert.match(prompt, /不超过 25 行/)
})

// ---------------------------------------------------------------- promote

test('injection text is deterministic and always framed', () => {
  const card = normalizeCard({ claim: 'p 值来自 Welch 检验', evidence: ['见 [10]'], caveat: '若方差不齐则需换检验' })
  const text = renderInjection(card, { anchorSeq: 10, quoteText: '这个 p 值怎么来的', threadId: '3' })
  assert.ok(text.startsWith('【旁听席提炼 · 非用户原话 · 未经主会话验证】'))
  assert.match(text, /第 10 事件/)
  assert.match(text, /见 \[10\]/)
  assert.match(text, /线程 3/)
  assert.equal(text, renderInjection(card, { anchorSeq: 10, quoteText: '这个 p 值怎么来的', threadId: '3' }))
})

test('an over-long card is refused, not truncated', () => {
  const card = normalizeCard({ claim: 'x'.repeat(400), evidence: ['y'.repeat(300)], caveat: 'z' })
  assert.ok(cardTooLong(card))
  assert.ok(cardChars(card) > CARD_LIMIT)
})

test('card json parses out of fenced or noisy replies', () => {
  const good = '```json\n{"claim":"a","evidence":["[1]"],"caveat":"c"}\n```'
  assert.equal(parseCardJson(good).claim, 'a')
  assert.equal(parseCardJson('前言 {"claim":"b","evidence":[],"caveat":"c"} 后记').claim, 'b')
  assert.equal(parseCardJson('没有 json'), null)
})

test('missing fields are filled, never dropped', () => {
  const card = normalizeCard({ claim: 'a' })
  assert.equal(card.disagreement, '无')
  assert.equal(card.suggestion, '无')
  assert.deepEqual(card.evidence, [])
})

test('fallback card keeps seqs it can find and admits it is unprocessed', () => {
  const card = fallbackCard('结论是 A [10]，因为 B [11]。')
  assert.deepEqual(card.evidence, ['见 [10]', '见 [11]'])
  assert.match(card.caveat, /未提炼/)
})

test('citation validation flags seqs that are not in the snapshot', () => {
  const { cited, unknown } = validateCitations('见 [10] 和 [999]，重复 [10]', [1, 10, 11])
  assert.deepEqual(cited, [10, 999])
  assert.deepEqual(unknown, [999])
})

// ---------------------------------------------------------------- remote surface

test('the host manifest is a valid typert contribution with strict codecs', async () => {
  const { TYPERT } = await import('../typert.host.js')
  assert.equal(TYPERT.package, 'dsh-side-seat')
  assert.equal(TYPERT.face, 'host')
  assert.ok(Array.isArray(TYPERT.schemas))
  assert.ok(Array.isArray(TYPERT.invocations) && TYPERT.invocations.length > 0)
  for (const invocation of TYPERT.invocations) {
    assert.equal(invocation.id, `${TYPERT.package}#${invocation.namespace}/${invocation.method}`)
    assert.equal(invocation.invocation.kind, 'direct')
    assert.equal(invocation.result.mode, 'strict')
    assert.equal(typeof invocation.input, 'function')
    assert.equal(typeof invocation.invoke, 'function')
    for (const parameter of invocation.parameters) assert.equal(parameter.codec.mode, 'strict')
  }
  assert.deepEqual(TYPERT.model.services, [])
})

test('the host manifest calls the registered service, not a private copy', async () => {
  const { TYPERT } = await import('../typert.host.js')
  const ping = TYPERT.invocations.find(i => i.method === 'ping')
  // `remote` is the Cordis context: the descriptor must resolve the service by
  // its namespace, which is what `ctx.provide('sideSeat')` makes possible.
  const fakeContext = { sideSeat: { ping: () => 'pong-from-service' } }
  assert.equal(ping.invoke(fakeContext), 'pong-from-service')
})

test('every host descriptor finds its method on the prototype with matching parameter names', async () => {
  // Mirrors dsh-api-gateway's methodParameterNames (lib/index.js:1746): it reads
  // Function.prototype.toString, requires unique plain identifiers, and the
  // gateway then passes wire values positionally in descriptor order.
  const { TYPERT } = await import('../typert.host.js')
  const { SideSeatService } = await import('../lib/remote-service.js')

  const namesOf = (fn) => {
    const source = Function.prototype.toString.call(fn)
    const open = source.indexOf('(')
    const close = source.indexOf(')', open + 1)
    assert.ok(open >= 0 && close > open, 'a class method always has a parameter list')
    const body = source.slice(open + 1, close).trim()
    if (body === '') return []
    const names = new Set()
    for (const part of body.split(',').map(p => p.trim())) {
      assert.match(part, /^[$A-Z_a-z][$\w]*$/u, `bad parameter ${JSON.stringify(part)}`)
      assert.ok(!names.has(part), `duplicate parameter ${part}`)
      names.add(part)
    }
    return [...names]
  }

  for (const invocation of TYPERT.invocations) {
    const implementation = Object.getOwnPropertyDescriptor(SideSeatService.prototype, invocation.method)
    assert.ok(implementation && typeof implementation.value === 'function',
      `${invocation.method} must be an own prototype method, or the gateway reports method-unavailable`)
    const declared = namesOf(implementation.value)
    const expected = invocation.parameters.map(parameter => parameter.name)
    assert.deepEqual(declared, expected, `${invocation.method}: method parameters must match descriptor order`)
  }
})

test('the service is callable through a proxy, as Cordis exposes it', async () => {
  // Cordis hands the gateway a proxy, so the invoked method's `this` is the
  // proxy rather than the instance. State held in a #private field throws
  // there, and the gateway turns that TypeError into an opaque gateway/internal.
  const { createSideSeatService } = await import('../lib/remote-service.js')
  const threads = [{ id: '1', turns: [] }]
  const service = createSideSeatService({
    ask: async () => ({ ok: true, answer: 'a' }),
    threads: async () => threads,
  })
  const proxy = new Proxy(service, {})

  assert.deepEqual(await proxy.threads('s1'), { ok: true, threads })
  assert.deepEqual(await proxy.ask('s1', 'q', 3, 'explain', undefined), { ok: true, answer: 'a' })
})

test('a handler failure becomes data, not an opaque gateway/internal', async () => {
  const { createSideSeatService } = await import('../lib/remote-service.js')
  const service = createSideSeatService({
    threads: async () => { throw new Error('disk on fire') },
    ask: async () => { throw new Error('model down') },
  })
  assert.deepEqual(await service.threads('s1'), { ok: false, error: 'disk on fire' })
  assert.deepEqual(await service.ask('s1', 'q', 3, 'explain', undefined), { ok: false, error: 'model down' })
})

test('the remote service carries the binding the gateway validates', async () => {
  const { createSideSeatService, SERVICE_KEY } = await import('../lib/remote-service.js')
  const service = createSideSeatService()

  // gateway/validateBinding: the service must expose typertRemote pointing at
  // itself, keyed by the Cordis service key and the Remote namespace.
  const binding = service.typertRemote
  assert.ok(binding, 'a service without a typertRemote binding is rejected with gateway/binding-invalid')
  assert.equal(binding.service, service)
  assert.equal(binding.serviceKey, SERVICE_KEY)
  assert.equal(binding.namespace, SERVICE_KEY)

  // gateway/methodParameterNames walks the prototype chain: an own property on
  // a plain object literal is not found and fails with method-unavailable.
  assert.equal(Object.hasOwn(service, 'ping'), false, 'ping must live on the prototype')
  assert.equal(typeof Object.getPrototypeOf(service).ping, 'function')
  assert.equal(service.ping(), 'pong')
})

test('the host half never registers the typert face itself (the loader owns it)', async () => {
  // Regression for the v0.4.0 incident: registering the same package-face twice
  // made the loader's activation fail on the next restart, which removed every
  // strict endpoint (settings/describe included) and crashed the client boot.
  const { readFile } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'index.js'), 'utf8')

  assert.ok(!/ctx\.typert\.register\s*\(/.test(source), 'the plugin must not register its own typert face')
  assert.ok(!/typert\.register\s*\(/.test(source), 'no typert registration at all from this plugin')

  const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./typert'], './typert.host.js', 'the loader discovers the face through this export')
})

test('the client half mounts the same endpoint and registers the right-bar tab', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')

  assert.match(source, /__ModuleLoader__/)
  assert.match(source, /id: 'dsh-side-seat'/)
  assert.match(source, /ctx\.remote\.\$mount/)
  assert.match(source, /sidebarRightTabs\.register/)
  // A page type with no `guide` entry has no way to be opened: the right bar's
  // start page lists guide entries only. Losing this line makes the panel
  // unreachable even though every registration succeeds.
  assert.match(source, /guide: \[\{/)
  assert.match(source, /'sidebar\.right\.pane\.tab'/)
  // The call path itself is exercised in test/client.test.mjs, which runs the
  // module against a mock context.
})

test('two stores never share empty state (regression: a shared EMPTY object)', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const a = await mkdtemp(join(tmpdir(), 'side-seat-a-'))
  const b = await mkdtemp(join(tmpdir(), 'side-seat-b-'))
  try {
    const storeA = new ThreadStore(a)
    const storeB = new ThreadStore(b)

    const first = await storeA.create('s1', { question: 'A 的问题' }, 10)
    assert.equal(first.id, '1')

    const second = await storeB.create('s1', { question: 'B 的问题' }, 10)
    assert.equal(second.id, '1', 'the second store must start from an empty thread list')

    const threadsB = await storeB.list('s1')
    assert.equal(threadsB.length, 1)
    assert.equal(threadsB[0].question, 'B 的问题')
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})

test('store keeps at most maxThreads threads', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'side-seat-cap-'))
  try {
    const store = new ThreadStore(dir)
    for (let i = 0; i < 5; i++) await store.create('s1', { question: `q${i}` }, 3)
    const threads = await store.list('s1')
    assert.equal(threads.length, 3)
    assert.deepEqual(threads.map(t => t.question), ['q2', 'q3', 'q4'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
