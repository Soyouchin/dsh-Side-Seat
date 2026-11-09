/**
 * Thread storage.
 *
 * Deliberately a plain JSON file per session rather than the storageDomain
 * service: the domain API requires a zod schema, and a bundle installed as a
 * linked directory cannot resolve `zod` from the dsh installation. A file is
 * boring, inspectable, and easy to delete.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

const emptyData = () => ({ version: 1, threads: [] })

export class ThreadStore {
  #dir
  #cache = new Map()

  constructor (dir) {
    this.#dir = dir
  }

  #file (sessionId) {
    return join(this.#dir, `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  }

  async load (sessionId) {
    const cached = this.#cache.get(sessionId)
    if (cached) return cached
    // A fresh object per miss: returning a shared constant would let one store's
    // `create()` push into every other store's empty state.
    let data = emptyData()
    try {
      const text = await readFile(this.#file(sessionId), 'utf8')
      const parsed = JSON.parse(text)
      if (parsed && Array.isArray(parsed.threads)) data = parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    this.#cache.set(sessionId, data)
    return data
  }

  async save (sessionId, data) {
    this.#cache.set(sessionId, data)
    await mkdir(this.#dir, { recursive: true })
    const target = this.#file(sessionId)
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, target)
  }

  async list (sessionId) {
    const data = await this.load(sessionId)
    return data.threads
  }

  async create (sessionId, thread, maxThreads) {
    const data = await this.load(sessionId)
    while (data.threads.length >= maxThreads) data.threads.shift()
    const id = nextId(data.threads)
    const record = { id, createdAt: Date.now(), turns: [], ...thread }
    data.threads.push(record)
    await this.save(sessionId, data)
    return record
  }

  async update (sessionId, threadId, mutate) {
    const data = await this.load(sessionId)
    const thread = data.threads.find(t => t.id === threadId)
    if (!thread) return undefined
    mutate(thread)
    await this.save(sessionId, data)
    return thread
  }

  async remove (sessionId, threadId) {
    const data = await this.load(sessionId)
    const before = data.threads.length
    data.threads = data.threads.filter(t => t.id !== threadId)
    await this.save(sessionId, data)
    return data.threads.length < before
  }
}

function nextId (threads) {
  let max = 0
  for (const t of threads) {
    const n = Number(t.id)
    if (Number.isFinite(n) && n > max) max = n
  }
  return String(max + 1)
}
