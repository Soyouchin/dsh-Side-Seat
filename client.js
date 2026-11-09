window.__ModuleLoader__.load({
  id: 'dsh-side-seat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PACKAGE = 'dsh-side-seat'

    // The same artifact shape `createTypertRemoteInfo` produces. The client
    // reads namespace/method/parameters/result, and its registry validation
    // requires a `create()` factory on every strict codec. Parameter order must
    // match the host service's parameter list.
    const loose = () => ({ parse: value => value, safeParse: value => ({ success: true, data: value }) })
    const codec = (typeSymbol, jsonSchema) => ({ mode: 'strict', typeSymbol, jsonSchema, create: loose })
    const param = (name, jsonSchema, optional = false) => ({
      name,
      wire: name,
      source: 'json',
      ...(optional ? { acceptsUndefined: true } : {}),
      codec: codec(`${PACKAGE}#${name}`, jsonSchema),
    })
    const json = { type: 'object', additionalProperties: true }
    const text = { type: 'string' }
    const input = () => ({ create: loose, jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } })

    const DESCRIPTORS = [      {
        id: `${PACKAGE}#sideSeat/ping`,
        service: 'sideSeat', namespace: 'sideSeat', method: 'ping',
        invocation: { kind: 'direct' }, parameters: [], input,
        result: codec(`${PACKAGE}#sideSeat.ping.result`, text),
      },
      {
        id: `${PACKAGE}#sideSeat/ask`,
        service: 'sideSeat', namespace: 'sideSeat', method: 'ask',
        invocation: { kind: 'direct' }, input,
        parameters: [
          param('sessionId', text),
          param('question', text),
          param('level', { type: 'number' }, true),
          param('mode', text, true),
          param('anchorSeq', { type: 'number' }, true),
        ],
        cancellation: { parameter: 'signal' },
        result: codec(`${PACKAGE}#sideSeat.ask.result`, json),
      },
      {
        id: `${PACKAGE}#sideSeat/threads`,
        service: 'sideSeat', namespace: 'sideSeat', method: 'threads',
        invocation: { kind: 'direct' }, input,
        parameters: [param('sessionId', text)],
        result: codec(`${PACKAGE}#sideSeat.threads.result`, json),
      },
      {
        id: `${PACKAGE}#sideSeat/anchor`,
        service: 'sideSeat', namespace: 'sideSeat', method: 'anchor',
        invocation: { kind: 'direct' }, input,
        parameters: [param('sessionId', text), param('messageId', text)],
        result: codec(`${PACKAGE}#sideSeat.anchor.result`, json),
      },
    ]

    // The panel and the per-message entry are two different slots; this tiny bus
    // is how "ask about this message" reaches a panel that may already be open.
    const bus = {
      anchor: null,
      listeners: new Set(),
      set (seq) {
        this.anchor = seq ?? null
        for (const listener of this.listeners) listener(this.anchor)
      },
      subscribe (listener) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'remote'],
      apply(ctx) {
        let mountError = ''
        try {
          Promise.resolve(ctx.remote.$mount({ package: PACKAGE, descriptors: DESCRIPTORS })).catch((error) => {
            mountError = String((error && error.message) || error)
          })
        } catch (error) {
          mountError = String((error && error.message) || error)
        }

        // The namespace service appears only after $mount, so it is read through
        // ctx.get (a direct property access throws "without inject") and polled
        // until it is mounted.
        const namespace = () => { try { return ctx.get('remote.sideSeat') } catch { return undefined } }
        const ready = async (method) => {
          for (let i = 0; i < 20; i++) {
            const ns = namespace()
            if (ns && typeof ns[method] === 'function') return ns
            await new Promise(resolve => setTimeout(resolve, 150))
          }
          return undefined
        }

        // The gateway checks arity against the descriptor exactly, so calls are
        // assembled from the descriptor rather than written out by hand: optional
        // trailing parameters must still be passed (as undefined).
        const callRemote = (ns, method, values) => {
          const descriptor = DESCRIPTORS.find(candidate => candidate.method === method)
          const args = descriptor.parameters.map((parameter, index) => values[index])
          return ns[method](...args)
        }

        const token = tone => ({ color: `var(--dsw-alias-label-${tone})`, fontSize: '12px' })
        const button = extra => ({
          padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          borderRadius: '6px',
          ...extra,
        })

        function Body(props) {
          const sessionId = props && props.sessionId
          const [turns, setTurns] = React.useState([])
          const [question, setQuestion] = React.useState('')
          const [level, setLevel] = React.useState(3)
          const [mode, setMode] = React.useState('explain')
          const [busy, setBusy] = React.useState(false)
          const [anchor, setAnchor] = React.useState(bus.anchor)
          const [note, setNote] = React.useState(mountError ? `mount failed: ${mountError}` : '')
          const [loaded, setLoaded] = React.useState(false)

          React.useEffect(() => bus.subscribe(value => setAnchor(value)), [])

          React.useEffect(() => {
            if (mountError || !sessionId) return undefined
            let alive = true
            ready('threads').then(async (ns) => {
              if (!ns) { if (alive) setNote('通道未就绪：remote.sideSeat 没挂载上'); return }
              const result = await callRemote(ns, 'threads', [sessionId])
              if (!alive) return
              if (!result || !result.ok) { setNote(`threads 失败：${JSON.stringify(result && result.error)}`); return }
              const payload = result.value || {}
              if (payload.ok === false) { setNote(`threads 失败：${payload.error}`); return }
              const flat = []
              for (const thread of payload.threads || []) {
                for (const turn of thread.turns || []) flat.push({ ...turn, threadId: thread.id, level: thread.level })
              }
              setTurns(flat)
              setLoaded(true)
            }).catch((error) => { if (alive) setNote(`threads 抛错：${error && error.message}`) })
            return () => { alive = false }
          }, [sessionId])

          const submit = async () => {
            const value = question.trim()
            if (!value || busy) return
            setBusy(true)
            setNote('')
            try {
              const ns = await ready('ask')
              if (!ns) { setNote('通道未就绪：remote.sideSeat 没挂载上'); return }
              const result = await callRemote(ns, 'ask', [sessionId, value, level, mode, anchor ?? undefined])
              if (!result || !result.ok) { setNote(`ask 失败：${JSON.stringify(result && result.error)}`); return }
              const value2 = result.value || {}
              setTurns(previous => [...previous, { question: value, answer: value2.answer, level, mode, tokens: value2.tokens }])
              setQuestion('')
            } catch (error) {
              setNote(`ask 抛错：${error && error.message}`)
            } finally {
              setBusy(false)
            }
          }

          const onKeyDown = (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() }
          }

          return h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '10px', height: '100%', minHeight: 0, padding: '12px' },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } }, '旁听席'),
            h('span', { style: token('tertiary') }, loaded ? '不进主会话' : '连接中…')),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            ...[1, 2, 3, 4].map(value => h('button', {
              key: value,
              onClick: () => setLevel(value),
              style: button({
                background: value === level ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-1)',
                color: value === level ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
              }),
            }, `L${value}`)),
            h('span', { style: { width: '1px', background: 'var(--dsw-alias-border-l1)' } }),
            ...['explain', 'challenge'].map(value => h('button', {
              key: value,
              onClick: () => setMode(value),
              style: button({
                background: value === mode ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-1)',
                color: value === mode ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
              }),
            }, value === 'explain' ? '解释' : '质疑'))),
          h('div', {
            style: { flex: 'auto', minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' },
          },
          turns.length === 0
            ? h('div', { style: token('tertiary') }, '还没有提问。问一句试试，答案只留在这里。')
            : turns.map((turn, index) => h('div', { key: index, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('div', { style: { ...token('tertiary'), fontStyle: 'italic' } }, turn.question),
              h('pre', {
                style: {
                  margin: 0, whiteSpace: 'pre-wrap', fontSize: '12px', lineHeight: '1.5',
                  color: 'var(--dsw-alias-label-primary)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  borderLeft: '2px solid var(--dsw-alias-state-business-primary)',
                  borderRadius: '6px', padding: '8px 10px',
                },
              }, turn.answer || '')))),
          note ? h('div', { style: { ...token('secondary'), whiteSpace: 'pre-wrap' } }, note) : null,
          anchor === null || anchor === undefined
            ? null
            : h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h('span', {
                style: {
                  fontSize: '11px', padding: '2px 8px', borderRadius: '999px',
                  color: 'var(--dsw-alias-label-secondary)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  border: '0.5px solid var(--dsw-alias-border-l1)',
                },
              }, `锚点 · 事件 ${anchor}`),
              h('button', {
                onClick: () => bus.set(null),
                style: button({ padding: '2px 6px', fontSize: '11px' }),
              }, '×')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('textarea', {
              value: question,
              rows: 2,
              placeholder: '就这条会话问一句…（Ctrl+Enter 发送）',
              onChange: event => setQuestion(event.target.value),
              onKeyDown,
              style: {
                width: '100%', resize: 'vertical', boxSizing: 'border-box',
                fontSize: '12px', lineHeight: '1.5', padding: '8px 10px',
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-layer-1)',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                borderRadius: '8px',
              },
            }),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              h('span', { style: token('tertiary') }, busy ? '思考中…' : '答案不进主会话'),
              h('button', { onClick: submit, disabled: busy || !question.trim(), style: button({ opacity: busy ? 0.6 : 1 }) }, busy ? '…' : '问'))))
        }

        // Per-message entry: the turn tail is the only message-level seat that
        // receives the event sequence, which is exactly what an anchor is.
        /**
         * The per-message entry, placed in the same row as copy / like / dislike /
         * share. That row only receives the durable `messageId`, so the host
         * resolves it to an event sequence before the panel is opened.
         */
        function AnchorEntry(props) {
          const messageId = props && props.messageId
          const sessionId = props && props.sessionId
          if (!messageId) return null

          const open = () => {
            const controller = (() => { try { return ctx.get('sidebarRight') } catch { return undefined } })()
            try {
              if (controller && typeof controller.openTab === 'function') controller.openTab('side-seat')
            } catch (error) {
              console.warn('[side-seat] openTab failed:', error)
            }
          }

          const onClick = async () => {
            try {
              const ns = await ready('anchor')
              if (ns) {
                const result = await callRemote(ns, 'anchor', [sessionId, messageId])
                const value = result && result.ok ? result.value : undefined
                bus.set(value && value.ok ? value.seq : null)
              }
            } catch (error) {
              console.warn('[side-seat] anchor lookup failed:', error)
            }
            open()
          }

          return h('button', {
            type: 'button',
            onClick,
            title: '旁听席：就这条问一句',
            'aria-label': '旁听席',
            style: {
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: '24px', height: '24px', padding: 0,
              cursor: 'pointer', background: 'transparent', border: 'none',
              borderRadius: '6px',
              color: 'var(--dsw-alias-label-tertiary)',
              verticalAlign: 'middle',
            },
          }, h('svg', {
            width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.6,
            strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('path', { d: 'M4 5.5h16v10H9l-4 3.5v-3.5H4z' }),
          h('path', { d: 'M8 10.5h8M8 13h5' })))
        }

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: PACKAGE,
          kind: 'side-seat',
          title: () => '旁听席',
          guide: [{
            id: 'side-seat:panel',
            order: 20,
            title: () => '旁听席',
            description: () => '就这场会话问一句，答案不进主会话',
          }],
          priority: 'extension',
          keepMounted: true,
        }), 'side-seat: tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PACKAGE,
        }, Body)), 'side-seat: tab body')

        // Same row as copy / like / dislike / share. Guarded on purpose: if this
        // slot name ever changes, the entry disappears without taking the
        // working panel down with it.
        try {
          ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: 'side-seat',
            order: 15,
            label: () => '旁听席',
          }, AnchorEntry)), 'side-seat: message action')
        } catch (error) {
          console.warn('[side-seat] message action unavailable:', error)
        }
      },
    }
  },
})
