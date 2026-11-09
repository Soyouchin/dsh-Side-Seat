/**
 * Session log -> layered context pack.
 *
 * Pure: no Cordis, no DSH imports, no I/O. Everything here is a function of
 * (events, options); the tests exercise it with synthetic logs.
 *
 * Layers (see docs/side-channel-design.md §3.2):
 *   L0  anchor window   - full text of the turns around the anchor
 *   L1  session skeleton - one line per message for the whole session
 *   L2  index           - the questions that were asked, turn boundaries
 */

const DEFAULTS = {
  budgetTokens: 12000,
  l0Turns: 1,          // ±1 turn around the anchor
  l1Recent: 30,        // kept verbatim in the skeleton when trimming
  toolHead: 1200,
  toolTail: 600,
  lineWidth: 90,
}

// ---------- message helpers ----------

function blocksOf (message) {
  if (message === null || typeof message !== 'object') return []
  const content = message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

export function textOf (message) {
  return blocksOf(message)
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

function toolCallsOf (message) {
  return blocksOf(message).filter(b => b && b.type === 'tool-call')
}

function oneLine (text, width = DEFAULTS.lineWidth) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`
}

function clipMiddle (text, head, tail) {
  if (text.length <= head + tail + 40) return text
  return `${text.slice(0, head)}\n…[${text.length - head - tail} chars clipped]…\n${text.slice(-tail)}`
}

/**
 * The committed log uses two shapes for the same thing:
 *   assistant/message -> data.message.content
 *   user/message, tool/result -> data.content (no data.message wrapper)
 * Reading only one of them silently drops every user question from the pack —
 * which is exactly what a browser-less implementation would never notice.
 */
function messageOf (data) {
  if (data.message && Array.isArray(data.message.content)) return data.message
  if (Array.isArray(data.content)) return { role: data.message?.role, content: data.content }
  if (typeof data.content === 'string') return { content: data.content }
  if (typeof data.message === 'string') return { content: data.message }
  return undefined
}

/** Normalize one log event into the fields this module cares about. */
export function describeEvent (event) {
  const type = event?.type
  const data = event?.data ?? {}
  const turn = typeof data.turn === 'number' ? data.turn : undefined
  const base = { seq: event?.seq, type, turn, time: event?.time }
  const message = messageOf(data)

  switch (type) {
    case 'user/message':
      return { ...base, role: 'user', text: textOf(message), tools: toolCallsOf(message) }
    case 'assistant/message': {
      const text = textOf(message)
      const tools = toolCallsOf(message)
      // Reasoning is where "why it said this" usually lives; keep one line of it
      // so the explainer can answer questions about intent, not just output.
      const reasoning = blocksOf(message)
        .filter(b => b && b.type === 'reasoning' && typeof b.text === 'string')
        .map(b => b.text).join('\n').trim()
      return { ...base, role: 'assistant', text, tools, reasoning }
    }
    case 'developer/message':
    case 'system/message':
      return { ...base, role: 'system', text: textOf(message), tools: [] }
    case 'tool/call':
      return { ...base, role: 'tool-call', text: '', tools: [{ name: data.name, arguments: data.arguments }] }
    case 'tool/result': {
      const text = textOf(message)
      return { ...base, role: 'tool-result', text, error: data.error === true, tools: [] }
    }
    case 'turn/start':
      return { ...base, role: 'turn', text: `turn ${turn} start` }
    case 'turn/end':
      return { ...base, role: 'turn', text: `turn ${turn} end (${data.reason?.kind ?? 'unknown'})` }
    default:
      return { ...base, role: 'other', text: '' }
  }
}

// ---------- layers ----------

function l2Index (rows, maxQuestions = 200) {
  const questions = rows.filter(r => r.role === 'user' && r.text)
  // `data.turn` resets across a session's epochs, so counting `turn/start`
  // events is the only reliable ordinal.
  const turns = rows.filter(r => r.role === 'turn' && /start/.test(r.text)).length
  const kept = questions.length > maxQuestions ? questions.slice(-maxQuestions) : questions
  const out = []
  out.push(`回合数：${turns}，消息数：${rows.filter(r => r.role === 'user' || r.role === 'assistant').length}`)
  if (questions.length > kept.length) {
    out.push(`用户问过的问题（共 ${questions.length} 条，只列最近 ${kept.length} 条）：`)
  } else if (questions.length > 0) {
    out.push('用户问过的问题：')
  }
  kept.forEach((q, i) => out.push(`${i + 1}. [${q.seq}] ${oneLine(q.text, 120)}`))
  return out.join('\n')
}

function l1Skeleton (rows, keep) {
  const lines = []
  for (const r of keep) {
    if (r.role === 'turn') continue
    const prefix = `[${r.seq}] ${r.role}`
    if (r.role === 'tool-call') {
      const t = r.tools[0]
      lines.push(`${prefix}: ${oneLine(t?.name ?? 'tool')}(${oneLine(t?.arguments ?? '', 60)})`)
      continue
    }
    if (r.role === 'tool-result') {
      const body = oneLine(r.text, 70)
      lines.push(`${prefix}${r.error ? ' ⚠' : ''}: ${body || '(empty)'}`)
      continue
    }
    const text = oneLine(r.text, 80)
    if (text) lines.push(`${prefix}: ${text}`)
    else if (r.reasoning) lines.push(`${prefix} ⟲: ${oneLine(r.reasoning, 80)}`)
    for (const call of r.tools ?? []) {
      lines.push(`${prefix} → ${oneLine(call?.name ?? 'tool')}(${oneLine(call?.arguments ?? '', 60)})`)
    }
  }
  return lines.join('\n')
}

/**
 * The anchor window is measured in events, not turns.
 *
 * A single turn in a research session can contain a hundred steps (search,
 * read, run, re-run); anchoring by turn means one long turn swallows the whole
 * budget. Anchoring by sequence distance keeps the window's size predictable.
 */
function l0Window (rows, anchorSeq, opts = {}) {
  if (anchorSeq === undefined) return ''
  const window = opts.window ?? 10
  const head = opts.head ?? 1200
  const tail = opts.tail ?? 600
  const textHead = opts.textHead ?? 2400
  const textTail = opts.textTail ?? 1200

  const anchorAt = rows.findIndex(r => r.seq === anchorSeq)
  if (anchorAt < 0) return ''
  const anchor = rows[anchorAt]

  const keep = new Set()
  let from = anchorAt
  while (from > 0 && anchor.seq - rows[from - 1].seq <= window) from--
  let to = anchorAt
  while (to + 1 < rows.length && rows[to + 1].seq - anchor.seq <= window) to++
  for (let i = from; i <= to; i++) keep.add(rows[i].seq)

  // Always carry the user message this anchor answers, even when it is outside
  // the window: without it the explainer cannot tell what was being asked.
  const question = rows.slice(0, anchorAt + 1).reverse().find(r => r.role === 'user')
  if (question) keep.add(question.seq)

  const out = []
  for (const r of rows) {
    if (!keep.has(r.seq)) continue
    if (r.role === 'turn') { out.push(`—— ${r.text} ——`); continue }
    if (r.role === 'tool-call') {
      const t = r.tools[0]
      out.push(`[${r.seq}] tool-call ${t?.name ?? 'tool'}\n${clipMiddle(String(t?.arguments ?? ''), head, tail)}`)
      continue
    }
    if (r.role === 'tool-result') {
      out.push(`[${r.seq}] tool-result${r.error ? ' (error)' : ''}\n${clipMiddle(r.text, head, tail)}`)
      continue
    }
    if (!r.text) continue
    out.push(`[${r.seq}] ${r.role}\n${clipMiddle(r.text, textHead, textTail)}`)
    for (const call of r.tools ?? []) {
      out.push(`[${r.seq}] ${r.role} → tool-call ${call?.name ?? 'tool'}\n${clipMiddle(String(call?.arguments ?? ''), head, tail)}`)
    }
  }
  return out.join('\n\n')
}

// ---------- packing ----------

/** Rough token estimate: CJK ~1 token/char, latin ~1 token/4 chars. */
export function estimateTokens (text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * Build the context pack under a hard token budget.
 *
 * The budget is a promise: if the pack still exceeds it after every
 * degradation step, it is truncated and the caller is told. An over-budget
 * pack is not a cosmetic problem — it is the difference between a side
 * question that costs 2k tokens and one that costs 30k.
 *
 * @param {Array} events  session events (ascending seq)
 * @param {{anchorSeq?: number, budgetTokens?: number, throughSeq?: number}} options
 */
export function buildContextPack (events, options = {}) {
  const budget = Math.max(200, options.budgetTokens ?? DEFAULTS.budgetTokens)
  const throughSeq = options.throughSeq ?? (events.length > 0 ? events[events.length - 1].seq : 0)
  const rows = events
    .filter(e => e && e.seq <= throughSeq)
    .map(describeEvent)
    .filter(r => typeof r.seq === 'number')

  const anchorSeq = options.anchorSeq
  // Ordinal of the anchor's turn, counted from `turn/start` events: the stored
  // `data.turn` resets between a session's epochs and cannot be used as an
  // absolute number.
  const anchorTurn = anchorSeq === undefined
    ? undefined
    : rows.filter(r => r.role === 'turn' && /start/.test(r.text) && r.seq <= anchorSeq).length

  // "Near the anchor" is a sequence distance, not a turn distance: one turn can
  // contain hundreds of steps.
  const nearAnchor = new Set(
    anchorSeq === undefined ? [] : rows.filter(r => Math.abs(r.seq - anchorSeq) <= 150).map(r => r.seq),
  )
  const questionSeqs = new Set()
  for (const r of rows) {
    if (r.role !== 'user') continue
    questionSeqs.add(r.seq)
    const next = rows.find(x => x.seq > r.seq && (x.role === 'assistant' || x.role === 'tool-result'))
    if (next) questionSeqs.add(next.seq)
  }

  const compose = ({ keep, l2, l0, note }) => {
    const l1 = l1Skeleton(rows, keep)
    const text = [
      '## 快照元信息',
      `快照：事件 0–${throughSeq}，锚点事件 ${options.anchorSeq ?? '-'}，锚点回合 ${anchorTurn ?? '-'}`,
      `预算 ${budget} tokens${note ? `（${note}）` : ''}`,
      '',
      '## L2 会话索引',
      l2,
      '',
      '## L1 会话骨架（每条消息一行，[seq] 为事件号）',
      l1 || '(空)',
      '',
      '## L0 锚点窗口（原文）',
      l0 || '(未指定锚点，未挂载原文)',
    ].join('\n')
    return { text, tokens: estimateTokens(text) }
  }

  const plans = [
    () => ({
      name: '完整',
      note: '',
      keep: rows,
      l2: l2Index(rows, 200),
      l0: l0Window(rows, options.anchorSeq),
    }),
    () => ({
      name: '骨架收紧',
      note: '骨架→近期+问题+锚点邻域',
      keep: rows.filter(r => nearAnchor.has(r.seq) || questionSeqs.has(r.seq)
        || rows.slice(-DEFAULTS.l1Recent).some(x => x.seq === r.seq)),
      l2: l2Index(rows, 80),
      l0: l0Window(rows, options.anchorSeq),
    }),
    () => ({
      name: '最小',
      note: '仅最近 40 条 + 最近 20 问 + 锚点回合',
      keep: rows.slice(-40),
      l2: l2Index(rows, 20),
      l0: l0Window(rows, options.anchorSeq, { window: 2, head: 300, tail: 150, textHead: 800, textTail: 400 }),
    }),
  ]

  const degraded = []
  let last
  for (const plan of plans) {
    const built = compose(plan())
    last = built
    if (built.tokens <= budget) {
      return finish(built, { budget, throughSeq, anchorTurn, options, degraded, rows, truncated: false })
    }
    degraded.push(plan().note)
  }

  // Nothing fit: truncate the middle of the pack, keeping the header and the
  // anchor window, and say so.
  const text = hardTruncate(last.text, budget)
  const tokens = estimateTokens(text)
  degraded.push(`硬截断到 ${tokens} tokens`)
  return finish({ text, tokens }, { budget, throughSeq, anchorTurn, options, degraded, rows, truncated: true })
}

function hardTruncate (text, budget) {
  // Character count is an upper bound on the token estimate (CJK ~1 token/char),
  // so slicing by characters guarantees the budget is respected.
  const anchorAt = text.indexOf("## L0 锚点窗口")
  const rawTail = anchorAt > 0 ? text.slice(anchorAt) : ""
  const rawHead = anchorAt > 0 ? text.slice(0, anchorAt) : text
  const clip = (value, chars) =>
    value.length <= chars ? value : value.slice(0, Math.max(0, chars - 10)) + "…（截断）\n"
  const tail = clip(rawTail, Math.floor(budget * 0.6))
  const head = clip(rawHead, Math.max(0, budget - tail.length - 20))
  return head + tail
}

function finish (built, { budget, throughSeq, anchorTurn, options, degraded, rows, truncated }) {
  const messages = rows.filter(r => r.role === 'user' || r.role === 'assistant').length
  return {
    text: built.text,
    throughSeq,
    anchorSeq: options.anchorSeq,
    anchorTurn,
    tokens: built.tokens,
    budget,
    overBudget: built.tokens > budget,
    degraded: [...new Set(degraded.filter(Boolean))],
    counts: { events: rows.length, messages },
  }
}
