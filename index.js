/**
 * 旁听席 (Side Seat) — a side channel that answers questions about this
 * session without touching this session.
 *
 * Nothing here creates a session, registers a tool, or writes to the session
 * log. The only channel back into the main session is an explicit
 * `to-main` invocation, which delivers one card as a user-role message.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { buildContextPack, estimateTokens } from './lib/digest.js'
import { buildSystemPrompt } from './lib/prompt.js'
import {
  CARD_LIMIT, DISTILL_SYSTEM, cardChars, cardTooLong, fallbackCard, normalizeCard,
  parseCardJson, renderCardBody, renderInjection, validateCitations,
} from './lib/promote.js'
import { ThreadStore } from './lib/store.js'
import { runSelfTest } from './lib/selftest.js'
import { createSideSeatService, SERVICE_KEY } from './lib/remote-service.js'

export const name = 'side-seat'
export const inject = ['commands', 'sessionQuery', 'llm']

export const VERSION = '0.7.0'

const DEFAULTS = {
  provider: '',
  model: '',
  level: 3,
  mode: 'explain',
  budgetTokens: 12000,
  maxThreads: 20,
  maxTokens: 1600,
  reasoningEffort: '',
  selfTest: false,
  storeDir: join(homedir(), '.dsh', 'side-seat'),
}

const HELP = `旁听席 —— 就这场会话问一句，不打扰主会话。

/seat <问题>              在当前旁听席里问（默认）
/seat l1|l2|l3|l4 <问题>  指定解释档位（L1 外行 … L4 较真）
/seat ? <问题>            质疑模式：检查这个结论站不站得住
/seat new [问题]          新开一张旁听席
/seat ls                  列出本会话的旁听席
/seat here                看最近几条输出的锚点事件号
/seat show [n]            看第 n 张旁听席
/seat use <n>             切到第 n 张
/seat del <n>             删除第 n 张
/seat refresh             快照刷新到最新（默认每次提问已取最新）
/seat export [n]          把第 n 张导出成 markdown
/seat selftest            诊断：模型、快照、包大小、线程
/seat to-main [n] [wake]  把第 n 张提炼成一张卡送进主会话
                          wake = 同时唤醒主会话接着做

@<seq> 前缀可指定锚点，例如：/seat @187 这个 p 值是怎么算的`

export function apply (ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  const store = new ThreadStore(settings.storeDir)

  // Remote channel: a plain Cordis service is enough — the descriptor resolves
  // `ctx[namespace]` and calls the method, so no TypertRemoteService is needed.
  // Guarded because the failure must be reportable, not fatal.
  let remoteStatus = 'not-attempted'
  try {
    if (typeof ctx.provide !== 'function' || typeof ctx.set !== 'function') {
      remoteStatus = 'ctx.provide/ctx.set missing'
    } else {
      ctx.provide(SERVICE_KEY)
      ctx.set(SERVICE_KEY, createSideSeatService({
        ask: request => remoteAsk(ctx, store, settings, request),
        threads: request => remoteThreads(store, request.sessionId),
        anchor: request => remoteAnchor(ctx, request),
      }))
      remoteStatus = 'ok'
    }
  } catch (error) {
    remoteStatus = `failed: ${error?.message ?? String(error)}`
  }

  // The host face belongs to dsh-typert-loader: it discovers every Loader entry
  // whose package exports "./typert" and registers (and withdraws) that manifest
  // itself. Registering the same face here as well is a duplicate — the loader's
  // activation then fails with "package face already registered", and every
  // strict endpoint (settings/describe included) loses its definition with it,
  // which is fatal for the Desktop shell's welcome RPC.
  const typertStatus = 'loader-managed'

  const dispose = ctx.commands.register({
    name: 'seat',
    description: '就当前会话提问，答案不进主会话（旁听席）',
    input: { hint: '<问题> | l1-l4 | ? | ls | show | use | del | to-main' },
    handler: invocation => run(ctx, store, settings, invocation),
  })
  ctx.effect(() => dispose)

  if (settings.selfTest) {
    const timer = setTimeout(() => {
      runSelfTest(ctx, settings, {
        remoteStatus,
        typertStatus,
        resolveModel: () => resolveModel(ctx, settings),
        reasoningEffort: settings.reasoningEffort || undefined,
        probeMaxTokens: 200,
      }).catch(() => {})
    }, 1500)
    ctx.effect(() => () => clearTimeout(timer))
  } else {
    // Cheap liveness beacon: proves which version actually loaded, without
    // spending a model call. Read <storeDir>/last-activation.json.
    import('node:fs/promises').then(({ mkdir, writeFile }) =>
      mkdir(settings.storeDir, { recursive: true }).then(() =>
        writeFile(join(settings.storeDir, 'last-activation.json'), JSON.stringify({
          version: VERSION,
          at: new Date().toISOString(),
          storeDir: settings.storeDir,
          level: settings.level,
          mode: settings.mode,
          budgetTokens: settings.budgetTokens,
        }, null, 2), 'utf8'))).catch(() => {})
  }
}

// ---------------------------------------------------------------- command

async function run (ctx, store, settings, invocation) {
  const raw = String(invocation.rawInput ?? '').trim()
  const sessionId = String(invocation.agent?.id ?? '')

  let level = settings.level
  let mode = settings.mode
  let anchorSeq
  let rest = raw

  // `@<seq>` anchor prefix
  const anchorMatch = rest.match(/^@(\d+)\s+([\s\S]*)$/)
  if (anchorMatch) {
    anchorSeq = Number(anchorMatch[1])
    rest = anchorMatch[2].trim()
  }
  // `l1..l4` prefix
  const levelMatch = rest.match(/^l([1-4])\s+([\s\S]*)$/i)
  if (levelMatch) {
    level = Number(levelMatch[1])
    rest = levelMatch[2].trim()
  }
  // `?` challenge prefix
  if (/^[?？]\s*/.test(rest) || /^质疑\s+/.test(rest)) {
    mode = 'challenge'
    rest = rest.replace(/^[?？]\s*/, '').replace(/^质疑\s+/, '').trim()
  }

  const [verb = '', ...tail] = rest.split(/\s+/)
  const arg = tail.join(' ').trim()

  try {
    switch (verb) {
      case '':
      case 'help':
        return ok(HELP)
      case 'ls':
        return ok(await listThreads(store, sessionId))
      case 'show':
        return ok(await showThread(store, sessionId, arg))
      case 'use':
        return ok(await useThread(store, sessionId, arg))
      case 'del':
        return ok(await deleteThread(store, sessionId, arg))
      case 'new':
        return ok(await ask(ctx, store, settings, { sessionId, question: arg || '（新旁听席已创建）', level, mode, anchorSeq, forceNew: true, signal: invocation.signal }))
      case 'refresh':
        return ok('快照在每次提问时自动取最新，无需手动刷新。')
      case 'here':
        return ok(await here(ctx, sessionId))
      case 'export':
        return ok(await exportThread(store, settings, sessionId, arg))
      case 'selftest':
        return ok(await diagnose(ctx, store, settings, sessionId))
      case 'to-main':
        return ok(await promote(ctx, store, settings, { sessionId, arg, agent: invocation.agent }))
      default:
        return ok(await ask(ctx, store, settings, {
          sessionId, question: rest, level, mode, anchorSeq, signal: invocation.signal,
        }))
    }
  } catch (error) {
    return { kind: 'error', text: `旁听席：${error?.message ?? String(error)}` }
  }
}

const ok = text => ({ kind: 'success', text })

const formatTokens = n => (typeof n === 'number'
  ? (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  : '?')

// ---------------------------------------------------------------- threads

async function listThreads (store, sessionId) {
  const threads = await store.list(sessionId)
  if (threads.length === 0) return '还没有旁听席。直接 `/seat <问题>` 开一张。'
  const current = pickCurrent(threads)
  const lines = threads.map(t => {
    const mark = t === current ? '●' : '○'
    const head = t.turns[0]?.question ?? '(空)'
    const when = new Date(t.createdAt).toLocaleTimeString()
    return `${mark} #${t.id} ${when} L${t.level} ${t.mode === 'challenge' ? '质疑' : '解释'} · ${head.slice(0, 40)}`
  })
  return [`本会话共 ${threads.length} 张旁听席：`, ...lines, '', '用 `/seat use <n>` 切换，`/seat show <n>` 看内容。'].join('\n')
}

async function showThread (store, sessionId, arg) {
  const threads = await store.list(sessionId)
  if (threads.length === 0) return '还没有旁听席。'
  const thread = arg ? findThread(threads, arg) : pickCurrent(threads)
  if (!thread) return `找不到 #${arg}。`
  const out = [`#${thread.id} · L${thread.level} · ${thread.mode === 'challenge' ? '质疑' : '解释'} · 快照事件 ${thread.snapshotSeq ?? '-'}`]
  for (const turn of thread.turns) {
    out.push('', `问：${turn.question}`, '', `答：${turn.answer}`)
    if (turn.unknownCitations?.length) out.push('', `⚠️ 引用了快照里不存在的事件号：${turn.unknownCitations.join(', ')}`)
  }
  return out.join('\n')
}

async function useThread (store, sessionId, arg) {
  const threads = await store.list(sessionId)
  const thread = findThread(threads, arg)
  if (!thread) return `找不到 #${arg}。`
  await store.update(sessionId, thread.id, t => { t.accessedAt = Date.now() })
  return `已切到 #${thread.id}。`
}

async function deleteThread (store, sessionId, arg) {
  const threads = await store.list(sessionId)
  const thread = findThread(threads, arg)
  if (!thread) return `找不到 #${arg}。`
  await store.remove(sessionId, thread.id)
  return `已删除 #${thread.id}。`
}

function findThread (threads, arg) {
  const id = String(arg ?? '').replace(/^#/, '')
  return threads.find(t => t.id === id)
}

/**
 * List the recent assistant messages so the user can pick an anchor without
 * knowing event numbers. The seq is otherwise invisible in the UI.
 */
async function here (ctx, sessionId, count = 6) {
  const { events, throughSeq } = await readLog(ctx, sessionId)
  const rows = events.map(describeEventSnapshot).filter(Boolean)
  const recent = rows.filter(r => r.role === 'assistant' && r.text).slice(-count).reverse()
  if (recent.length === 0) return '这个会话里还没有可锚定的 assistant 输出。'
  const out = [`最近 ${recent.length} 条输出（用 /seat @<事件号> <问题> 指定锚点）：`, '']
  for (const row of recent) {
    out.push(`${row.seq}  ${oneLine(row.text, 40)}`)
  }
  out.push('', `默认锚点 = 最后一条（${recent[0].seq}），所以不写 @ 也行。快照到事件 ${throughSeq}。`)
  return out.join('\n')
}

const oneLine = (text, width) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`
}

/** Minimal event → {seq, role, text} reader; the full layering lives in digest.js. */
function describeEventSnapshot (event) {
  const type = event?.type
  if (type !== 'assistant/message' && type !== 'user/message') return null
  const data = event.data ?? {}
  const message = data.message && Array.isArray(data.message.content)
    ? data.message
    : Array.isArray(data.content) ? { content: data.content } : undefined
  if (!message) return null
  const text = (Array.isArray(message.content) ? message.content : [])
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text).join('\n').trim()
  if (!text) return null
  return { seq: event.seq, role: type === 'assistant/message' ? 'assistant' : 'user', text }
}

async function exportThread (store, settings, sessionId, arg) {
  const threads = await store.list(sessionId)
  if (threads.length === 0) return '还没有旁听席。'
  const thread = arg ? findThread(threads, arg) : pickCurrent(threads)
  if (!thread) return `找不到 #${arg}。`
  const lines = [
    `# 旁听席 #${thread.id}`,
    '',
    `- 会话：${sessionId}`,
    `- 快照：事件 ${thread.snapshotSeq ?? '-'} · 锚点事件 ${thread.anchorSeq ?? '-'}`,
    `- 档位：L${thread.level} · 模式：${thread.mode === 'challenge' ? '质疑' : '解释'}`,
    `- 创建：${new Date(thread.createdAt).toISOString()}`,
    '',
  ]
  for (const turn of thread.turns) {
    lines.push('## 问', '', turn.question, '', '## 答', '', turn.answer, '')
    const meta = [
      turn.packTokens ? `上下文 ${turn.packTokens} tokens` : '',
      turn.usage ? `用量 ${turn.usage.inputTokens ?? '?'}/${turn.usage.outputTokens ?? '?'}` : '',
      turn.latencyMs ? `${turn.latencyMs}ms` : '',
      turn.unknownCitations?.length ? `⚠️ 不存在的事件号：${turn.unknownCitations.join(', ')}` : '',
    ].filter(Boolean).join(' · ')
    if (meta) lines.push(`（${meta}）`, '')
  }

  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = join(settings.storeDir, 'exports')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${sessionId}-${thread.id}-${Date.now()}.md`)
  await writeFile(file, lines.join('\n'), 'utf8')
  return `已导出到：${file}`
}

async function diagnose (ctx, store, settings, sessionId) {
  const out = [`旁听席 v${VERSION}`, '']
  try {
    const model = resolveModel(ctx, settings)
    out.push(`模型：${model.provider}/${model.model}${settings.provider ? '（配置指定）' : '（会话默认）'}`)
  } catch (error) {
    out.push(`模型：❌ ${error.message.split('\n')[0]}`)
  }
  try {
    const { events, throughSeq } = await readLog(ctx, sessionId)
    const pack = buildContextPack(events, {
      anchorSeq: defaultAnchor(events), budgetTokens: settings.budgetTokens, throughSeq,
    })
    out.push(`会话：${events.length} 个事件 · 快照到 ${throughSeq}`)
    out.push(`上下文包：${pack.tokens}/${pack.budget} tokens${pack.degraded.length ? `（降级：${pack.degraded.join('+')}）` : ''}`)
  } catch (error) {
    out.push(`会话：❌ ${error.message}`)
  }
  const threads = await store.list(sessionId)
  out.push(`旁听席：${threads.length} 张 · 存储目录 ${settings.storeDir}`)
  out.push(`自检：${settings.selfTest ? '开' : '关'}`)
  return out.join('\n')
}



function pickCurrent (threads) {
  let best
  for (const t of threads) {
    if (!best) { best = t; continue }
    const a = t.accessedAt ?? t.createdAt
    const b = best.accessedAt ?? best.createdAt
    if (a > b) best = t
  }
  return best
}

// ---------------------------------------------------------------- explain

/**
 * One question, one answer. Returns the facts the command formats into text and
 * the Remote hands to the panel as JSON — same computation, two renderings.
 */
async function askStructured (ctx, store, settings, { sessionId, question, level, mode, anchorSeq, forceNew, signal }) {
  const { events, throughSeq } = await readLog(ctx, sessionId)
  if (events.length === 0) {
    return { empty: true, text: '这个会话还没有可读的内容。', footer: '' }
  }

  const effectiveAnchor = anchorSeq ?? defaultAnchor(events)
  const pack = buildContextPack(events, {
    anchorSeq: effectiveAnchor,
    budgetTokens: settings.budgetTokens,
    throughSeq,
  })

  let thread
  if (!forceNew) {
    thread = pickCurrent(await store.list(sessionId))
  }
  if (!thread) {
    thread = await store.create(sessionId, {
      level, mode, anchorSeq: effectiveAnchor, snapshotSeq: throughSeq, accessedAt: Date.now(),
    }, settings.maxThreads)
  }

  const system = buildSystemPrompt({ level, mode, snapshot: { throughSeq, anchorSeq: effectiveAnchor } })
  const user = [`以下是这场会话的快照。\n\n${pack.text}`, '', `## 我的问题`, question].join('\n')

  const started = Date.now()
  const { text, usage } = await complete(ctx, settings, { system, user, signal })
  const { unknown } = validateCitations(text, events.map(e => e.seq))

  const record = {
    question, answer: text, level, mode,
    packTokens: pack.tokens, degraded: pack.degraded,
    usage, latencyMs: Date.now() - started,
    unknownCitations: unknown, at: Date.now(),
  }
  await store.update(sessionId, thread.id, t => {
    t.turns.push(record)
    t.accessedAt = Date.now()
    t.snapshotSeq = throughSeq
    t.anchorSeq = effectiveAnchor
    t.level = level
    t.mode = mode
  })

  // The Host renders a command result as a collapsed one-line summary plus a
  // 260px preformatted box (chat/client GenericCommandCard). So the footer has
  // to earn its lines: one compact line, not three.
  const footer = [
    '',
    `— L${level}${mode === 'challenge' ? '·质疑' : ''} · 事件 ${throughSeq} · ${formatTokens(pack.tokens)}/${formatTokens(pack.budget)}` +
      (usage?.inputTokens ? ` · ${formatTokens(usage.inputTokens)}→${usage.outputTokens ?? '?'}` : '') +
      (pack.overBudget ? ' · ⚠️超预算' : pack.degraded.length ? ` · 降级 ${pack.degraded.length}` : '') +
      (unknown.length ? ` · ⚠️无此事件号 ${unknown.slice(0, 3).join(',')}` : '') +
      ' · 未进主会话',
  ].join('\n')

  return {
    empty: false,
    answer: text,
    footer,
    text: `${text}\n${footer}`,
    threadId: thread.id,
    throughSeq,
    anchorSeq: effectiveAnchor,
    tokens: pack.tokens,
    budget: pack.budget,
    degraded: pack.degraded,
    overBudget: pack.overBudget,
    unknownCitations: unknown,
    usage: usage ?? null,
    latencyMs: record.latencyMs,
  }
}

async function ask (ctx, store, settings, options) {
  const result = await askStructured(ctx, store, settings, options)
  return result.text
}

/** One Remote ask: normalizes the wire values and returns plain JSON. */
async function remoteAsk (ctx, store, settings, { sessionId, question, level, mode, anchorSeq }) {
  const levelValue = Number(level)
  const usedLevel = Number.isFinite(levelValue) && levelValue >= 1 && levelValue <= 4 ? levelValue : settings.level
  const usedMode = mode === 'challenge' ? 'challenge' : 'explain'
  const seqValue = Number(anchorSeq)
  const usedAnchor = Number.isFinite(seqValue) ? seqValue : undefined

  const result = await askStructured(ctx, store, settings, {
    sessionId: String(sessionId),
    question: String(question ?? ''),
    level: usedLevel,
    mode: usedMode,
    anchorSeq: usedAnchor,
  })

  return {
    ok: result.empty !== true,
    answer: result.answer ?? result.text,
    threadId: result.threadId ?? null,
    throughSeq: result.throughSeq ?? 0,
    anchorSeq: result.anchorSeq ?? null,
    tokens: result.tokens ?? 0,
    budget: result.budget ?? settings.budgetTokens,
    degraded: result.degraded ?? [],
    overBudget: result.overBudget === true,
    unknownCitations: result.unknownCitations ?? [],
    usage: result.usage ?? null,
    latencyMs: result.latencyMs ?? 0,
  }
}

/** Thread summaries for the panel; answers are included so it can render history. */
async function remoteThreads (store, sessionId) {
  const threads = await store.list(String(sessionId))
  return threads.map(thread => ({
    id: thread.id,
    at: thread.createdAt,
    level: thread.level ?? null,
    mode: thread.mode ?? 'explain',
    turns: (thread.turns ?? []).map(turn => ({
      question: turn.question,
      answer: turn.answer,
      at: turn.at ?? null,
      tokens: turn.packTokens ?? null,
    })),
  }))
}

/** Resolve an assistant message id to the sequence it was committed at. */
async function remoteAnchor (ctx, { sessionId, messageId }) {
  const { events } = await readLog(ctx, String(sessionId))
  const wanted = String(messageId ?? '')
  if (!wanted) return { ok: false, error: 'messageId is empty' }

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const message = event.data?.message
    if (message?.id !== wanted) continue
    const quote = (Array.isArray(message.content) ? message.content : [])
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    return { ok: true, seq: event.seq, quote }
  }
  return { ok: false, error: `no assistant message with id ${wanted}` }
}

function defaultAnchor (events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.type
    if (t === 'assistant/message') return events[i].seq
  }
  return events[events.length - 1]?.seq
}

// ---------------------------------------------------------------- promote

async function promote (ctx, store, settings, { sessionId, arg, agent }) {
  const parts = String(arg ?? '').split(/\s+/).filter(Boolean)
  const idArg = parts.find(p => /^#?\d+$/.test(p)) ?? ''
  const confirmed = parts.includes('yes')
  const wake = parts.includes('wake')

  const threads = await store.list(sessionId)
  const thread = idArg ? findThread(threads, idArg) : pickCurrent(threads)
  if (!thread) return '没有可提炼的旁听席。'
  if (thread.turns.length === 0) return `#${thread.id} 里还没有问答。`

  const last = thread.turns[thread.turns.length - 1]
  const distilled = parseCardJson(await distill(ctx, settings, last))
  const card = normalizeCard(distilled ?? fallbackCard(last.answer))

  if (cardTooLong(card)) {
    return `提炼卡有 ${cardChars(card)} 字，超过 ${CARD_LIMIT} 字上限，未送入。\n\n${renderCardBody(card)}\n\n请先精简这条答案，再重新执行 /seat to-main ${thread.id}。`
  }

  const text = renderInjection(card, {
    anchorSeq: thread.anchorSeq,
    quoteText: thread.turns[0]?.question,
    threadId: thread.id,
  })

  // Two-step by default: injecting is irreversible (append-only log), so the
  // first call only previews. `yes` is the user's signature.
  if (!confirmed) {
    return [
      `将要送入主会话的内容（还没送）· 旁听席 #${thread.id}`,
      '',
      ...text.split('\n').map(line => `│ ${line}`),
      '',
      `确认：/seat to-main ${thread.id} yes${wake ? ' wake' : ''}`,
      '注意：日志 append-only，送入后无法撤回；要更正只能再送一条。',
    ].join('\n')
  }

  await deliver(agent, text, wake)
  await store.update(sessionId, thread.id, t => { t.promotedAt = Date.now() })

  return [
    wake ? '已送入主会话并唤醒。' : '已送入主会话（不唤醒：主 agent 下一次被接纳的步骤里会读到）。',
    '',
    ...text.split('\n').map(line => `│ ${line}`),
    '',
    '已写入日志，无法撤回；要更正只能再送一条。',
  ].join('\n')
}

async function distill (ctx, settings, turn) {
  try {
    const { text } = await complete(ctx, settings, {
      system: DISTILL_SYSTEM,
      user: `问题：${turn.question}\n\n回答：\n${turn.answer}`,
      maxTokens: 400,
    })
    return text
  } catch {
    return ''
  }
}

async function deliver (agent, text, wake) {
  const options = { content: [{ type: 'text', text }], source: { kind: 'side-seat' } }
  const call = (method, payload) => {
    if (typeof agent?.[method] !== 'function') return undefined
    return agent[method](payload)
  }
  if (wake) {
    const sent = call('followup', options) ?? call('steer', options)
    if (sent !== undefined) return sent
  }
  const sent = call('inject', options) ?? call('inject', text)
  if (sent !== undefined) return sent
  throw new Error('当前 DSH 版本没有提供 agent.inject()，无法送入主会话。')
}

// ---------------------------------------------------------------- infra

async function readLog (ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query?.readSession) {
    try {
      const snapshot = await query.readSession(sessionId)
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      if (events.length > 0) {
        return { events, throughSeq: events[events.length - 1].seq }
      }
    } catch {
      // A live session can refuse the cold reader; fall through to the live store.
    }
  }
  const sessions = ctx.get('sessions')
  const session = sessions?.get?.(sessionId)
  const events = session?.snapshotEvents?.() ?? []
  return { events, throughSeq: events.length > 0 ? events[events.length - 1].seq : 0 }
}

const MODEL_KEYS = ['provider', 'providerId', 'provider_id']
const MODEL_IDS = ['model', 'modelId', 'model_id']

function pick (object, keys) {
  for (const key of keys) {
    const value = object?.[key]
    if (typeof value === 'string' && value) return value
    if (value && typeof value === 'object' && typeof value.id === 'string') return value.id
  }
  return undefined
}

function resolveModel (ctx, settings) {
  if (settings.provider && settings.model) return { provider: settings.provider, model: settings.model }
  const service = ctx.get('agentDefaultModel')
  let selection
  try {
    selection = service?.currentSelection?.()
  } catch {
    selection = undefined
  }
  const candidates = [selection, selection?.primary, selection?.default, selection?.current].filter(Boolean)
  for (const candidate of candidates) {
    const provider = pick(candidate, MODEL_KEYS)
    const model = pick(candidate, MODEL_IDS)
    if (provider && model) return { provider, model }
  }
  throw new Error(
    '无法确定用哪个模型。请给插件加配置，例如：\n'
    + "  config:\n    provider: 'deepseek'\n    model: 'deepseek-chat'",
  )
}

/**
 * One model call, with the two failure modes the side seat actually hits:
 * a reasoning model spending the whole budget before it writes anything, and a
 * silence that is not a budget problem at all. Both used to collapse into
 * "模型返回了空回答" with no way to tell which had happened.
 */
async function complete (ctx, settings, { system, user, signal, maxTokens }) {
  const { provider, model } = resolveModel(ctx, settings)
  const budget = maxTokens ?? settings.maxTokens

  const attempt = async (limit) => {
    const stream = ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: limit,
      ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
      signal,
    })

    let text = ''
    let reasoning = 0
    let usage
    let finish = null
    let blocker
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text.length
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') {
        finish = chunk.reason?.kind ?? null
        if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型请求失败')
        if (chunk.reason?.kind === 'aborted') throw new Error('请求被取消')
        if (chunk.reason?.kind === 'max-tokens') blocker = 'max-tokens'
      }
    }
    return { text: text.trim(), reasoning, usage, finish, blocker }
  }

  const first = await attempt(budget)
  if (first.text) return { text: first.text, usage: first.usage }

  // An empty completion is rare and usually transient (a provider hiccup, a
  // dropped content block). A reasoning-heavy model needs a bigger budget
  // instead, so the two cases retry differently — but both retry once.
  const retryBudget = first.finish === 'max-tokens' || first.reasoning > 0
    ? Math.min(8000, Math.max(budget * 2, 3000))
    : budget
  try {
    const retry = await attempt(retryBudget)
    if (retry.text) return { text: retry.text, usage: retry.usage }
  } catch {
    // A provider that caps maxTokens rejects the larger budget; the original
    // diagnosis below is more useful than that validation error.
  }

  const detail = [
    `finish=${first.finish ?? 'unknown'}`,
    `reasoning=${first.reasoning} 字`,
    `budget=${budget}`,
    first.usage ? `用量 ${first.usage.inputTokens ?? '?'}/${first.usage.outputTokens ?? '?'}` : '无用量',
  ].join(' · ')
  throw new Error(
    `模型返回了空回答（${detail}）。` +
    (first.reasoning > 0
      ? '看起来模型把预算都用在思考上了：可以调大 maxTokens，或把 config.reasoningEffort 设为 low/none。'
      : '没有产出任何文本，也不是预算问题：检查 config.provider/model 是否指向可用的路由。'),
  )
}

export { estimateTokens }
