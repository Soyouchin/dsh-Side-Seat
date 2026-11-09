/**
 * The service the Remote descriptors resolve against.
 *
 * Three constraints come from `dsh-api-gateway/lib/index.js`:
 *
 *   1. `validateBinding` (1729): the service must carry a `typertRemote`
 *      binding whose `service` field is the instance itself;
 *   2. `methodParameterNames` (1746): the invoked method must be found on the
 *      **prototype chain**, and its declared parameters must be unique plain
 *      identifiers — no destructuring, defaults, or rest;
 *   3. `assertExactArguments` (1776): the wire fields must match the descriptor
 *      exactly, so parameter order here mirrors the descriptor order.
 *
 * Doing this by hand keeps the bundle free of a dependency on
 * `@deepseek-ai/dsh-typert-protocol`, which a linked profile bundle cannot
 * resolve from the dsh installation.
 */

export const SERVICE_KEY = 'sideSeat'
export const NAMESPACE = 'sideSeat'

export class SideSeatService {
  constructor (handlers = {}) {
    // A plain property, not a #private field: Cordis exposes a service through a
    // proxy, and a method invoked through that proxy cannot touch private state
    // of the target ("cannot read private member"). The gateway folds the
    // resulting TypeError into an opaque `gateway/internal`.
    this.handlers = handlers
  }

  /** Liveness probe for the browser → host channel. */
  ping () {
    return 'pong'
  }

  /** One side-seat question. Returns plain JSON so the wire needs no codec. */
  async ask (sessionId, question, level, mode, anchorSeq) {
    try {
      return await this.handlers.ask({ sessionId, question, level, mode, anchorSeq })
    } catch (error) {
      // The gateway replaces a thrown error with `gateway/internal` and drops
      // the message, so failures are returned as data instead.
      return { ok: false, error: String((error && error.message) || error) }
    }
  }

  /** The side-seat threads recorded for one session. */
  async threads (sessionId) {
    try {
      return { ok: true, threads: await this.handlers.threads({ sessionId }) }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  }

  /**
   * Resolve a durable message id to the event sequence it committed at.
   * The message action row only receives `messageId`, and the client has no log
   * access, so the mapping has to happen on the host.
   */
  async anchor (sessionId, messageId) {
    try {
      return await this.handlers.anchor({ sessionId, messageId })
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  }
}

/** Build the instance with its Remote binding attached. */
export function createSideSeatService (handlers = {}) {
  const service = new SideSeatService(handlers)
  Object.defineProperty(service, 'typertRemote', {
    value: { service, serviceKey: SERVICE_KEY, namespace: NAMESPACE },
    enumerable: false,
    configurable: true,
  })
  return service
}
