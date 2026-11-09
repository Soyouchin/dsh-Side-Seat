/**
 * Self-test: run on plugin activation and dump what the Host actually sees.
 *
 * Why this exists: the plugin's claims ("the command is registered", "the
 * descriptor registered", "asking does not inject") cannot be checked from a
 * browser-less session. This writes the observable facts to a JSON file so the
 * development loop can assert them instead of assuming them.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let alreadyRan = false

export async function runSelfTest (ctx, settings, options = {}) {
  if (alreadyRan) return
  alreadyRan = true

  const report = { at: new Date().toISOString(), steps: [] }
  const step = (name, value) => report.steps.push({ name, ...value })

  try {
    const service = (() => { try { return ctx.get('sideSeat') } catch { return undefined } })()
    step('remote-service', {
      status: options.remoteStatus ?? 'unknown',
      resolved: service !== undefined && service !== null,
      ping: (() => {
        try { return service?.ping?.() ?? null } catch (error) { return `error: ${error?.message}` }
      })(),
    })

    const commands = ctx.get('commands')
    step('commands-service', { ok: Boolean(commands), hasExecute: typeof commands?.execute === 'function' })

    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const liveAgents = (agents?.list?.() ?? []).map(a => String(a.id))
    const liveSessions = (sessions?.list?.() ?? []).map(s => String(s.id))
    step('live', { agents: liveAgents, sessions: liveSessions })

    const typert = ctx.get('typert')
    step('typert', {
      status: options.typertStatus ?? 'unknown',
      hasRegister: typeof typert?.register === 'function',
      localList: (() => {
        try { return (typert?.local?.list?.() ?? []).map(r => r.package ?? r) } catch (error) { return `error: ${error?.message}` }
      })(),
      localGet: (() => {
        try { return typert?.local?.get?.('dsh-side-seat') !== undefined } catch (error) { return `error: ${error?.message}` }
      })(),
    })

    const agent = agents?.list?.()[0]
    if (agent && typeof commands?.execute === 'function' && options.ask !== false) {
      const started = Date.now()
      const execution = await commands.execute(agent, '/seat ping 自检：请只回答 pong', [], new AbortController().signal)
      step('seat-command', {
        latencyMs: Date.now() - started,
        resolved: execution !== undefined,
        resultKind: execution?.result?.kind,
        textLength: execution?.result?.text?.length ?? 0,
        head: String(execution?.result?.text ?? '').slice(0, 400),
      })
    } else {
      step('seat-command', { skipped: true, reason: agent ? 'no execute' : 'no live agent' })
    }
  } catch (error) {
    step('fatal', { message: String(error?.message ?? error), stack: String(error?.stack ?? '') })
  }

  report.ok = !report.steps.some(s => s.name === 'fatal')
  const dir = settings.storeDir
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'selftest.json')
  await writeFile(file, JSON.stringify(report, null, 2), 'utf8')
  return file
}
