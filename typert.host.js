/**
 * Host-face Remote descriptors for the side seat.
 *
 * Hand-written instead of generated: `createTypertRemoteInfo` only reshapes
 * `{ package, methods }` into `{ package, descriptors, methods }` and pulls in
 * no runtime dependencies, so an out-of-tree bundle can produce the same
 * artifact without the generator. The loader validates this manifest and
 * registers it into `ctx.typert`; registering it here as well is a duplicate
 * face and breaks the whole strict registry (see README).
 *
 * Parameter order must match the service method's parameter list: the gateway
 * reads wire values by descriptor order and passes them positionally.
 */

const PACKAGE = 'dsh-side-seat'

/** Minimal strict codec: the wire layer only needs the discriminator. */
const codec = (typeSymbol, jsonSchema, description) => ({
  mode: 'strict',
  typeSymbol,
  description,
  jsonSchema,
  create: () => ({
    parse: value => value,
    safeParse: value => ({ success: true, data: value }),
  }),
})

const param = (name, typeSymbol, jsonSchema, { optional = false, description } = {}) => ({
  name,
  wire: name,
  source: 'json',
  ...(optional ? { acceptsUndefined: true } : {}),
  ...(description ? { description } : {}),
  codec: codec(typeSymbol, jsonSchema),
})

const json = typeSymbol => ({ type: 'object', additionalProperties: true })
const string = typeSymbol => ({ type: 'string' })

const ping = {
  id: `${PACKAGE}#sideSeat/ping`,
  service: 'sideSeat',
  namespace: 'sideSeat',
  method: 'ping',
  description: 'Liveness probe: returns "pong" when the Remote channel is mounted end to end.',
  invocation: { kind: 'direct' },
  parameters: [],
  result: codec(`${PACKAGE}#sideSeat.ping.result`, string(), 'the literal string pong'),
  input () {
    return { create: codec('input', json()).create, jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }
  },
  invoke (remote) {
    const receiver = Reflect.get(remote, 'sideSeat')
    return Reflect.get(receiver, 'ping').apply(receiver, [])
  },
}

const ask = {
  id: `${PACKAGE}#sideSeat/ask`,
  service: 'sideSeat',
  namespace: 'sideSeat',
  method: 'ask',
  description: 'Answer one question about the current session without entering it.',
  invocation: { kind: 'direct' },
  parameters: [
    param('sessionId', `${PACKAGE}#sessionId`, string(), { description: 'session the question is about' }),
    param('question', `${PACKAGE}#question`, string(), { description: 'what the user asked' }),
    param('level', `${PACKAGE}#level`, { type: 'number' }, { optional: true, description: 'L1–L4 explanation level (default L3)' }),
    param('mode', `${PACKAGE}#mode`, string(), { optional: true, description: 'explain | challenge (default explain)' }),
    param('anchorSeq', `${PACKAGE}#anchorSeq`, { type: 'number' }, { optional: true, description: 'event sequence the question is anchored to' }),
  ],
  cancellation: { parameter: 'signal' },
  result: codec(`${PACKAGE}#sideSeat.ask.result`, json(), 'answer text plus the snapshot/usage facts the panel displays'),
  input () {
    return { create: codec('input', json()).create, jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }
  },
  invoke (remote, input) {
    const receiver = Reflect.get(remote, 'sideSeat')
    return Reflect.get(receiver, 'ask').apply(receiver, [
      input.sessionId, input.question, input.level, input.mode, input.anchorSeq,
    ])
  },
}

const threads = {
  id: `${PACKAGE}#sideSeat/threads`,
  service: 'sideSeat',
  namespace: 'sideSeat',
  method: 'threads',
  description: 'List the side-seat threads recorded for one session.',
  invocation: { kind: 'direct' },
  parameters: [
    param('sessionId', `${PACKAGE}#sessionId`, string(), { description: 'session whose threads are listed' }),
  ],
  result: codec(`${PACKAGE}#sideSeat.threads.result`, json(), 'ok plus the thread summaries, or ok:false and an error'),
  input () {
    return { create: codec('input', json()).create, jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }
  },
  invoke (remote, input) {
    const receiver = Reflect.get(remote, 'sideSeat')
    return Reflect.get(receiver, 'threads').apply(receiver, [input.sessionId])
  },
}

const anchor = {
  id: `${PACKAGE}#sideSeat/anchor`,
  service: 'sideSeat',
  namespace: 'sideSeat',
  method: 'anchor',
  description: 'Resolve a durable message id to the event sequence it committed at.',
  invocation: { kind: 'direct' },
  parameters: [
    param('sessionId', `${PACKAGE}#sessionId`, string(), { description: 'session the message belongs to' }),
    param('messageId', `${PACKAGE}#messageId`, string(), { description: 'durable assistant message id from the action row' }),
  ],
  result: codec(`${PACKAGE}#sideSeat.anchor.result`, json(), 'ok with seq and a quote, or ok:false and an error'),
  input () {
    return { create: codec('input', json()).create, jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }
  },
  invoke (remote, input) {
    const receiver = Reflect.get(remote, 'sideSeat')
    return Reflect.get(receiver, 'anchor').apply(receiver, [input.sessionId, input.messageId])
  },
}

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [ping, ask, threads, anchor],
  model: { services: [], events: [], objects: [] },
}
