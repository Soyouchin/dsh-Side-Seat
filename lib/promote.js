/**
 * Promotion: the only channel into the main session.
 *
 * Pure. `agent.inject()` delivers a **user-role** message with no automatic
 * wrapper (verified in the host recon), so every word of framing below is
 * load-bearing: without it the main agent reads the card as the user's own
 * instruction.
 */

export const CARD_LIMIT = 600

export const INJECTION_PREFIX = '【旁听席提炼 · 非用户原话 · 未经主会话验证】'

export const FIELDS = ['claim', 'evidence', 'caveat', 'disagreement', 'suggestion']

/** System prompt for the distillation call (a second, cheap model call). */
export const DISTILL_SYSTEM = `你把一段旁听席问答压缩成一张给主会话看的提炼卡。
只输出 JSON，不要任何解释、不要 markdown 代码块。字段：
{
  "claim": "一句话结论，不超过 120 字",
  "evidence": ["依据，每条带 [seq] 或写'无法从会话中确认'"],
  "caveat": "这条结论在什么条件下会错（必填，不许写'无'）",
  "disagreement": "与主会话现有说法的分歧；没有就写'无'",
  "suggestion": "建议主会话做什么一句话，必须是建议不是命令；没有就写'无'"
}`

const str = v => (typeof v === 'string' ? v.trim() : '')

/** Normalize whatever the model produced into a card with every field present. */
export function normalizeCard (value) {
  const raw = value && typeof value === 'object' ? value : {}
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.map(str).filter(Boolean)
    : str(raw.evidence) ? [str(raw.evidence)] : []
  return {
    claim: str(raw.claim),
    evidence,
    caveat: str(raw.caveat),
    disagreement: str(raw.disagreement) || '无',
    suggestion: str(raw.suggestion) || '无',
  }
}

export function cardChars (card) {
  return renderCardBody(card).length
}

export function renderCardBody (card) {
  const c = normalizeCard(card)
  return [
    `结论：${c.claim || '（未给出）'}`,
    `依据：${c.evidence.length ? c.evidence.join('；') : '（未给出）'}`,
    `注意：${c.caveat || '（未给出）'}`,
    `分歧：${c.disagreement}`,
    `建议：${c.suggestion}`,
  ].join('\n')
}

/** True when the card must be shortened before it may be injected. */
export function cardTooLong (card) {
  return cardChars(card) > CARD_LIMIT
}

/**
 * The exact text that will be delivered to the main session.
 * Deterministic: the test asserts a byte-identical round trip.
 */
export function renderInjection (card, meta = {}) {
  const where = meta.anchorSeq === undefined ? '（未指定锚点）' : `第 ${meta.anchorSeq} 事件`
  const quote = str(meta.quoteText) ? `「${str(meta.quoteText).slice(0, 40)}」` : ''
  return [
    INJECTION_PREFIX,
    `锚点：${where}${quote ? ` ${quote}` : ''}`,
    renderCardBody(card),
    `（来源：旁听席${meta.threadId ? `线程 ${meta.threadId}` : ''}；是否采纳由你判断）`,
  ].join('\n')
}

/**
 * Heuristic card when the distillation call fails or returns non-JSON.
 * Never pretends to be structured: it keeps the raw answer under 结论.
 */
export function fallbackCard (answer) {
  const text = String(answer ?? '').trim()
  const firstLine = text.split(/\n+/).find(l => l.trim().length > 0) ?? ''
  const seqs = [...text.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]))
  return {
    claim: firstLine.slice(0, 120),
    evidence: [...new Set(seqs)].slice(0, 5).map(s => `见 [${s}]`),
    caveat: '⚠️ 这条是未提炼的原文摘录，完整依据仍在旁听席线程里；注入前请自行核对。',
    disagreement: '无',
    suggestion: '无',
  }
}

/** Pull the first JSON object out of a model reply (handles stray prose / fences). */
export function parseCardJson (text) {
  const raw = String(text ?? '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Keep every [seq] that exists in the snapshot; return the ones that do not. */
export function validateCitations (answer, knownSeqs) {
  const known = new Set(knownSeqs)
  const cited = [...String(answer ?? '').matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]))
  const unknown = [...new Set(cited.filter(s => !known.has(s)))]
  return { cited: [...new Set(cited)], unknown }
}
