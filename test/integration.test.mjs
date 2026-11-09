/**
 * Integration test for the command path: a mock Cordis context, the real
 * plugin module, and a synthetic session log.
 *
 * This is the layer that can actually assert the two things that matter:
 *   1. asking never calls inject() — the "zero pollution" claim (R2)
 *   2. `to-main` delivers exactly one framed card (R5)
 *
 * Each test gets its own temp store AND its own session id: the node test
 * runner keeps one module instance, so sharing a session id would share the
 * thread file.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { INJECTION_PREFIX } from '../lib/promote.js'

const msg = text => ({ role: 'assistant', content: [{ type: 'text', text }] })

function sessionLog () {
  const ev = (seq, type, data) => ({ seq, time: 1700000000000 + seq, type, data })
  const turns = [
    ['先看哪种抽样方法？', '用分层抽样，因为批次效应明显。'],
    ['为什么用 Welch t 检验？', '不假设方差齐性。'],
    ['这个 p 值 0.03 怎么来的？', 'Welch t 检验，双侧，df 约 12.4，见 [10]。'],
  ]
  const out = []
  turns.forEach(([q, a], i) => {
    const base = i * 4
    out.push(ev(base, 'turn/start', { turn: i + 1 }))
    out.push(ev(base + 1, 'user/message', { turn: i + 1, message: { role: 'user', content: [{ type: 'text', text: q }] } }))
    out.push(ev(base + 2, 'assistant/message', { turn: i + 1, message: msg(a) }))
    out.push(ev(base + 3, 'turn/end', { turn: i + 1, reason: { kind: 'completed' } }))
  })
  return out
}

function mockCtx ({ reply = '这是解释。[10]', sessionId } = {}) {
  const state = { definition: undefined, injected: [], llmCalls: [], disposed: false }
  const ctx = {
    commands: {
      register (definition) {
        state.definition = definition
        return () => { state.disposed = true }
      },
    },
    effect (fn) { fn() },
    get (name) {
      if (name === 'sessionQuery') {
        return { readSession: async () => ({ events: sessionLog(), inheritedEventCount: 0 }) }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) }
      }
      return undefined
    },
    llm: {
      stream (options) {
        state.llmCalls.push(options)
        const isDistill = String(options.system ?? '').includes('提炼卡')
        const chunks = isDistill
          ? ['{"claim":"', 'p 值来自 Welch 检验', '","evidence":["见 [10]"],"caveat":"若方差不齐则不成立"}']
          : [reply.slice(0, 3), reply.slice(3)]
        return (async function * () {
          for (const t of chunks) yield { type: 'text-delta', index: 0, text: t }
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }

  const agent = {
    id: sessionId,
    inject (payload) { state.injected.push(payload); return 'msg-1' },
    followup (payload) { state.injected.push(payload); return 'msg-2' },
  }

  return { ctx, state, agent }
}

let counter = 0
async function scenario (fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'side-seat-'))
  const sessionId = `t${++counter}`
  const { ctx, state, agent } = mockCtx({ sessionId, ...options })
  apply(ctx, { storeDir: dir, selfTest: false })
  try {
    return await fn({ ctx, state, agent, storeDir: dir, run: raw => state.definition.handler({ agent, rawInput: raw, attachments: [], signal: undefined, commandId: 'c1' }) })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('plugin registers one command and disposes cleanly', async () => {
  await scenario(async ({ state }) => {
    assert.equal(state.definition.name, 'seat')
    assert.ok(state.definition.description.length > 0)
  })
})

test('asking answers and never touches the main session', async () => {
  await scenario(async ({ state, run }) => {
    const result = await run('这个 p 值 0.03 怎么来的？')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /这是解释/)
    assert.match(result.text, /事件 \d+/)
    assert.match(result.text, /未进主会话/)
    assert.ok(!/^—$/m.test(result.text), 'the footer must be one line, not three')
    assert.deepEqual(state.injected, [], 'asking must not inject anything')
    assert.equal(state.llmCalls.length, 1)
  })
})

test('the explainer prompt carries the level, the mode and the snapshot', async () => {
  await scenario(async ({ state, run }) => {
    await run('l1 为什么要校正多重检验？')
    const system = state.llmCalls[0].system
    assert.match(system, /旁听席/)
    assert.match(system, /L1 外行/)
    assert.match(system, /解释/)
    assert.ok(state.llmCalls[0].messages[0].content[0].text.includes('锚点窗口'))

    await run('? 这个结论站得住吗')
    assert.match(state.llmCalls[1].system, /质疑/)
  })
})

test('a second question reuses the thread; new opens another', async () => {
  await scenario(async ({ run }) => {
    await run('第一个问题')
    await run('第二个问题')
    let listed = await run('ls')
    assert.match(listed.text, /共 1 张旁听席/)

    await run('new 新线程的问题')
    listed = await run('ls')
    assert.match(listed.text, /共 2 张旁听席/)
  })
})

test('to-main previews first and injects nothing until confirmed', async () => {
  await scenario(async ({ state, run }) => {
    await run('这个 p 值 0.03 怎么来的？')
    const preview = await run('to-main')
    assert.equal(preview.kind, 'success')
    assert.match(preview.text, /还没送/)
    assert.match(preview.text, /确认：\/seat to-main 1 yes/)
    assert.deepEqual(state.injected, [], 'a preview must not inject')
  })
})

test('to-main yes injects exactly one framed card and nothing else', async () => {
  await scenario(async ({ state, run }) => {
    await run('这个 p 值 0.03 怎么来的？')
    const result = await run('to-main 1 yes')
    assert.equal(result.kind, 'success')
    assert.equal(state.injected.length, 1, 'exactly one delivery')

    const text = state.injected[0].content[0].text
    assert.ok(text.startsWith(INJECTION_PREFIX))
    assert.match(text, /结论：p 值来自 Welch 检验/)
    assert.match(text, /是否采纳由你判断/)
    assert.equal(state.injected[0].source.kind, 'side-seat')
  })
})

test('del removes a thread and show reports a missing one', async () => {
  await scenario(async ({ run }) => {
    await run('问题')
    assert.match((await run('del 1')).text, /已删除 #1/)
    assert.match((await run('del 1')).text, /找不到 #1/)
    assert.match((await run('show 1')).text, /还没有旁听席/)
  })
})

test('unknown subcommands are treated as questions, not as errors', async () => {
  await scenario(async ({ run }) => {
    const result = await run('这个 df 是怎么估的？')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /这是解释/)
  })
})

test('a model failure becomes an error result, not a crash', async () => {
  await scenario(async ({ ctx, state, run }) => {
    ctx.llm.stream = () => (async function * () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游 429' } } }
    })()
    const result = await run('问题')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /429/)
    assert.deepEqual(state.injected, [])
  })
})

test('selftest reports the model, the snapshot and the pack size without calling the model', async () => {
  await scenario(async ({ state, run }) => {
    await run('先开一张')
    const before = state.llmCalls.length
    const result = await run('selftest')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /模型：mock\/mock-1/)
    assert.match(result.text, /上下文包：\d+\/\d+ tokens/)
    assert.match(result.text, /旁听席：1 张/)
    assert.equal(state.llmCalls.length, before, 'selftest must not spend a model call')
  })
})

test('here lists the anchorable messages with their event numbers', async () => {
  await scenario(async ({ run }) => {
    const result = await run('here')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /最近 3 条输出/)
    assert.match(result.text, /10 {2}Welch t 检验/)
    assert.match(result.text, /默认锚点/)
  })
})

test('export writes a markdown file with the question, the answer and its provenance', async () => {
  await scenario(async ({ run }) => {
    await run('这个 p 值怎么来的？')
    const result = await run('export')
    const file = result.text.replace('已导出到：', '').trim()
    const markdown = await readFile(file, 'utf8')
    assert.match(markdown, /# 旁听席 #1/)
    assert.match(markdown, /## 问/)
    assert.match(markdown, /这个 p 值怎么来的？/)
    assert.match(markdown, /## 答/)
    assert.match(markdown, /上下文 \d+ tokens/)
  })
})
