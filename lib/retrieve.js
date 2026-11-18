/**
 * Question-driven retrieval over a whole session log.
 *
 * The layered pack answers "what is around this step" well, but a long session
 * buries the paragraph you actually doubt: the skeleton has one line per
 * message and the anchor window is a few events wide. This module finds the
 * messages that share vocabulary with the question, so the explainer can read
 * the real text instead of a summary of it.
 *
 * Pure and deterministic: no model call, no I/O. CJK is indexed by bigrams
 * (there are no spaces to split on), latin by words.
 */

/** Terms too common to say anything about what the user is asking. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'why', 'how', 'does', 'did', 'was', 'were',
  'are', 'you', 'your', 'our', 'not', 'but', 'can', 'could', 'would', 'should', 'about', 'from',
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '这', '那', '和', '与', '就', '都', '也',
  '很', '要', '会', '能', '把', '被', '给', '对', '上', '下', '中', '个', '不', '有', '没', '吗',
  '呢', '吧', '啊', '什么', '怎么', '为什么', '一下', '这个', '那个', '我们', '你们', '可以',
])

/**
 * Turn a question into search terms.
 * @param {string} question
 * @returns {string[]} distinct terms, longest first (rarer terms score higher)
 */
export function queryTerms (question) {
  const text = String(question ?? '')
  const terms = new Set()

  for (const word of text.toLowerCase().match(/[a-z][a-z0-9_+#.-]{2,}/g) ?? []) {
    if (!STOPWORDS.has(word)) terms.add(word)
  }

  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) continue
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2)
      if (!STOPWORDS.has(bigram)) terms.add(bigram)
    }
  }

  return [...terms].sort((a, b) => b.length - a.length)
}

/**
 * Score one text against the query terms.
 * @param {string} text
 * @param {string[]} terms
 * @returns {number} weighted hit count (0 = not relevant)
 */
export function scoreText (text, terms) {
  if (!text || terms.length === 0) return 0
  const haystack = String(text).toLowerCase()
  let score = 0
  for (const term of terms) {
    let at = haystack.indexOf(term)
    if (at < 0) continue
    let hits = 0
    while (at >= 0 && hits < 8) {
      hits += 1
      at = haystack.indexOf(term, at + term.length)
    }
    // A long, specific term says more than a common two-character one.
    score += hits * Math.min(4, Math.max(1, term.length - 1))
  }
  return score
}

/**
 * Pick the most relevant messages for a question.
 *
 * @param {Array<{seq:number, role:string, text:string}>} rows  normalized events
 * @param {string} question
 * @param {{limit?: number, budgetChars?: number, exclude?: Set<number>}} options
 * @returns {{excerpts: Array<{seq:number, role:string, text:string, score:number}>, terms: string[], matched: boolean}}
 */
export function selectExcerpts (rows, question, options = {}) {
  const limit = options.limit ?? 8
  const budgetChars = options.budgetChars ?? 6000
  const exclude = options.exclude ?? new Set()
  const terms = queryTerms(question)
  if (terms.length === 0) return { excerpts: [], terms, matched: false }

  const scored = []
  for (const row of rows) {
    if (row.role === 'turn' || row.role === 'other') continue
    if (!row.text || exclude.has(row.seq)) continue
    const score = scoreText(row.text, terms)
    if (score > 0) scored.push({ row, score })
  }
  scored.sort((a, b) => b.score - a.score || b.row.seq - a.row.seq)

  const excerpts = []
  let used = 0
  for (const { row, score } of scored) {
    if (excerpts.length >= limit) break
    const clip = clipExcerpt(row.text, Math.min(1200, budgetChars - used))
    if (clip === '') continue
    if (used + clip.length > budgetChars && excerpts.length > 0) break
    excerpts.push({ seq: row.seq, role: row.role, text: clip, score })
    used += clip.length
  }
  excerpts.sort((a, b) => a.seq - b.seq)
  return { excerpts, terms, matched: excerpts.length > 0 }
}

function clipExcerpt (text, room) {
  const clean = String(text).trim()
  if (clean.length <= room) return clean
  const head = clean.slice(0, Math.max(0, room - 120))
  const tail = clean.slice(-100)
  return `${head}\n…[省略 ${clean.length - head.length - tail.length} 字]…\n${tail}`
}
