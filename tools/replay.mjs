// Read a real DSH session log (zstd JSONL) and run the context pack builder on it.
// Usage: node tools/replay.mjs [budget] [path-to-zstd]

import zlib from 'node:zlib'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildContextPack, estimateTokens } from '../lib/digest.js'

const ROOT = join(homedir(), '.dsh', 'sessions')

function newestLog () {
  let best
  for (const workspace of fs.readdirSync(ROOT)) {
    const workspaceDir = join(ROOT, workspace)
    if (!fs.statSync(workspaceDir).isDirectory()) continue
    for (const session of fs.readdirSync(workspaceDir)) {
      const file = join(workspaceDir, session, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      const mtime = fs.statSync(file).mtimeMs
      if (!best || mtime > best.mtime) best = { file, mtime }
    }
  }
  return best?.file
}

const file = process.argv[3] ?? newestLog()
if (!file) {
  console.error('no session log found')
  process.exit(1)
}

// The persistence appends one zstd frame per checkpoint, so a single-file read
// only yields the first frame. Split on the magic number and decode each.
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeFrames (buffer) {
  const starts = []
  let at = 0
  while ((at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1) {
    starts.push(at)
    at += 4
  }
  const parts = []
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[i], end)))
    } catch {
      // a false-positive magic inside compressed bytes; skip it
    }
  }
  return Buffer.concat(parts)
}

const raw = decodeFrames(fs.readFileSync(file)).toString('utf8')
const records = raw.split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line) } catch { return null }
}).filter(Boolean)

console.log(`file: ${file}`)
console.log(`records: ${records.length}`)
console.log(`sample keys: ${Object.keys(records[0] ?? {}).join(', ')}`)
console.log(`sample: ${JSON.stringify(records[0]).slice(0, 300)}`)

const events = records
  .filter(r => typeof r.type === 'string' && typeof r.seq === 'number')
  .map(r => ({ type: r.type, seq: r.seq, time: r.time, data: r.data ?? r }))

console.log(`events: ${events.length}`)
console.log(`types: ${[...new Set(events.map(e => e.type))].slice(0, 20).join(', ')}`)

const budget = Number(process.argv[2] ?? 12000)
const anchor = events.filter(e => e.type === 'assistant/message').slice(-1)[0]?.seq
const pack = buildContextPack(events, { anchorSeq: anchor, budgetTokens: budget })
console.log(JSON.stringify({
  budget,
  tokens: pack.tokens,
  overBudget: pack.overBudget,
  degraded: pack.degraded,
  anchorTurn: pack.anchorTurn,
  counts: pack.counts,
  textChars: pack.text.length,
  estimateOfText: estimateTokens(pack.text),
}, null, 2))
