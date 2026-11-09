#!/usr/bin/env node
// Minimal read-only ASAR inspector for the installed DeepSeek Harness.
// Usage:
//   node tools/asar.mjs list   <pattern>
//   node tools/asar.mjs grep   <regex> [pathFilter]
//   node tools/asar.mjs cat    <path> [fromLine] [lines]
//   node tools/asar.mjs jsdoc  <path>          (print only export/class/method lines)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function defaultAsar () {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return undefined
}

// Read-only: this tool never writes into the installation.
const ASAR = process.env.ASAR_PATH ?? defaultAsar()
if (ASAR === undefined) {
  console.error('Set ASAR_PATH to the installed DSH app.asar (e.g. .../resources/app.asar).')
  process.exit(1)
}

function readHeader (file) {
  const fd = fs.openSync(file, 'r')
  const probe = Buffer.alloc(16)
  fs.readSync(fd, probe, 0, 16, 0)
  // Layout observed in this build: [uint32:4][uint32:8+len][uint32:4+len][uint32:len][JSON at 16]
  const len = probe.readUInt32LE(12)
  const buf = Buffer.alloc(len)
  fs.readSync(fd, buf, 0, len, 16)
  const header = JSON.parse(buf.toString('utf8'))
  const dataStart = 16 + Math.ceil(len / 4) * 4
  return { fd, header, dataStart }
}

function walk (node, prefix, out) {
  if (!node) return out
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, prefix ? `${prefix}/${name}` : name, out)
    }
  } else if (node.size !== undefined && typeof node.size !== 'object') {
    out.push({ path: prefix, size: Number(node.size), offset: Number(node.offset ?? 0) })
  }
  return out
}

function readEntry (ctx, entry) {
  const buf = Buffer.alloc(entry.size)
  fs.readSync(ctx.fd, buf, 0, entry.size, ctx.dataStart + entry.offset)
  return buf.toString('utf8')
}

const [cmd, a1, a2, a3] = process.argv.slice(2)
const ctx = readHeader(ASAR)
const entries = walk(ctx.header, '', [])
const byPath = new Map(entries.map(e => [e.path, e]))

if (cmd === 'list') {
  const re = a1 ? new RegExp(a1) : null
  for (const e of entries) if (!re || re.test(e.path)) console.log(`${String(e.size).padStart(9)}  ${e.path}`)
  console.log(`\n# ${entries.length} entries total`)
} else if (cmd === 'grep') {
  const re = new RegExp(a1, 'g')
  const filter = a2 ? new RegExp(a2) : null
  let hits = 0
  for (const e of entries) {
    if (!filter || !filter.test(e.path)) continue
    if (!/\.(js|mjs|cjs|json|md|yml|yaml|ts|tsx|css)$/.test(e.path)) continue
    let text
    try { text = readEntry(ctx, e) } catch { continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      const out = `${e.path}:${i + 1}: ${lines[i].trim().slice(0, 400)}`
      console.log(out)
      if (++hits > 400) { console.log('… truncated'); process.exit(0) }
    }
  }
  console.log(`\n# ${hits} matches`)
} else if (cmd === 'cat') {
  const e = byPath.get(a1) ?? entries.find(x => x.path.endsWith(a1))
  if (!e) { console.error(`not found: ${a1}`); process.exit(1) }
  const text = readEntry(ctx, e)
  const from = a2 ? Number(a2) : 1
  const count = a3 ? Number(a3) : 400
  const lines = text.split('\n')
  for (let i = from - 1; i < Math.min(lines.length, from - 1 + count); i++) {
    console.log(`${String(i + 1).padStart(5)}| ${lines[i]}`)
  }
  console.log(`\n# ${e.path} total ${lines.length} lines`)
} else if (cmd === 'extract') {
  const prefix = a1
  const dest = a2 ?? 'vendor'
  if (!prefix || !dest) { console.error('usage: extract <pathPrefix> <destDir>'); process.exit(1) }
  const matches = entries.filter(e => e.path.startsWith(prefix))
  if (matches.length === 0) { console.error(`nothing under ${prefix}`); process.exit(1) }
  let written = 0
  for (const e of matches) {
    const rel = e.path.slice(prefix.length).replace(/^\/+/, '')
    if (!rel) continue
    const out = path.join(dest, rel)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, Buffer.from(readEntry(ctx, e), 'utf8'))
    written++
  }
  console.log(`extracted ${written} files under ${dest}`)
} else if (cmd === 'jsdoc') {
  const e = byPath.get(a1) ?? entries.find(x => x.path.endsWith(a1))
  if (!e) { console.error(`not found: ${a1}`); process.exit(1) }
  const text = readEntry(ctx, e)
  text.split('\n').forEach((l, i) => {
    if (/^\s*(export (function|const|class|interface|type)|class |register\(|inject\(|apply\(|\* .*\(| \* @)/.test(l)) {
      console.log(`${String(i + 1).padStart(5)}| ${l.trim().slice(0, 300)}`)
    }
  })
} else {
  console.error('usage: list <pattern> | grep <regex> [pathFilter] | cat <path> [fromLine] [lines] | jsdoc <path>')
  process.exit(1)
}
