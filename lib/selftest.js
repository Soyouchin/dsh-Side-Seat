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

    // Raw chunk probe: proves what the model actually streams, independent of
    // the explainer prompt. "empty answer" is a symptom with three very
    // different causes (reasoning-only output, max-tokens exhaustion, a
    // mis-resolved route), and they are indistinguishable from the outside.
    if (options.llmProbe !== false) {
      const started = Date.now()
      const chunks = {}
      let text = ''
      let reasoning = ''
      let finish = null
      let usage = null
      let failure = null
      try {
        const route = options.resolveModel ? options.resolveModel() : { provider: 'unknown', model: 'unknown' }
        const stream = ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          reasoningEffort: options.reasoningEffort,
          system: '你是连通性测试。',
          messages: [{ role: 'user', content: [{ type: 'text', text: '只回答：OK' }] }],
          maxTokens: options.probeMaxTokens ?? 200,
        })
        for await (const chunk of stream) {
          chunks[chunk.type] = (chunks[chunk.type] ?? 0) + 1
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') {
            finish = chunk.reason?.kind ?? null
            if (chunk.reason?.kind === 'error') failure = chunk.reason.failure?.message ?? 'error'
          }
        }
        step('llm-probe', {
          latencyMs: Date.now() - started,
          model: route,
          reasoningEffort: options.reasoningEffort ?? '(default)',
          chunks,
          finish,
          failure,
          textChars: text.length,
          reasoningChars: reasoning.length,
          textHead: text.slice(0, 120),
          reasoningHead: reasoning.slice(0, 120),
          usage,
        })
      } catch (error) {
        step('llm-probe', { error: String(error?.message ?? error), chunks, finish })
      }
    }

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
