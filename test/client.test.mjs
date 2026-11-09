/**
 * The client half, executed for real.
 *
 * `client.js` is a browser module (`window.__ModuleLoader__.load`), so it cannot
 * be imported like the host side. This harness stubs the loader and React,
 * captures the factory, and runs `apply` against a mock Cordis context — which
 * is enough to pin the three things that must never regress:
 *   1. the mounted contribution's codecs carry `create()` (the $mount validator
 *      rejects a strict codec without it: "strict codec has no create() factory")
 *   2. the tab type declares a `guide` entry, otherwise the panel has no way in
 *   3. `title` is a function, as the tab registry calls it
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'client.js'), 'utf8')

function loadClientModule () {
  let definition
  const window = { __ModuleLoader__: { load: value => { definition = value } } }
  // `client.js` is a script that calls into the loader; evaluate it with the
  // stub in scope rather than importing it.
  // eslint-disable-next-line no-new-func
  new Function('window', source)(window)
  assert.ok(definition, 'client.js must register a module definition')
  return definition
}

const reactStub = {
  createElement: () => null,
  useState: initial => [initial, () => {}],
  useEffect: () => {},
}

function runApply () {
  const definition = loadClientModule()
  const captured = { mounts: [], tabTypes: [], slots: [] }
  const namespace = { ping: () => Promise.resolve({ ok: true, value: 'pong' }) }
  const ctx = {
    effect: fn => { fn(); return () => {} },
    get: key => (key === 'remote.sideSeat' ? namespace : undefined),
    remote: {
      $mount: contribution => {
        captured.mounts.push(contribution)
        return Promise.resolve(async () => {})
      },
    },
    sidebarRightTabs: {
      register: options => {
        captured.tabTypes.push(options)
        return () => {}
      },
    },
    slots: {
      inject: (_name, callback) => { callback(); return () => {} },
      register: (options) => {
        captured.slots.push(options)
        return () => {}
      },
    },
  }
  const module = definition.factory(() => reactStub)
  module.apply(ctx)
  return { definition, captured, module }
}

test('the client module declares the services it needs', () => {
  const { module, definition } = runApply()
  assert.equal(definition.id, 'dsh-side-seat')
  for (const service of ['slots', 'sidebarRightTabs', 'remote']) {
    assert.ok(module.inject.includes(service), `must inject ${service}`)
  }
})

test('the mounted contribution passes the codec rules the gateway enforces', () => {
  const { captured } = runApply()
  assert.equal(captured.mounts.length, 1)
  const contribution = captured.mounts[0]
  assert.equal(contribution.package, 'dsh-side-seat')

  for (const descriptor of contribution.descriptors) {
    assert.equal(descriptor.result.mode, 'strict')
    assert.equal(typeof descriptor.result.create, 'function', 'a strict result codec without create() fails $mount')
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict')
      assert.equal(typeof parameter.codec.create, 'function')
      assert.ok(parameter.wire, 'every parameter needs a wire name')
    }
  }
})

test('the tab type is openable: guide entry present, title is a function', () => {
  const { captured } = runApply()
  assert.equal(captured.tabTypes.length, 1)
  const type = captured.tabTypes[0]

  assert.equal(type.kind, 'side-seat')
  assert.equal(type.id, 'dsh-side-seat')
  assert.equal(typeof type.title, 'function', 'the registry calls title, so it cannot be a plain string')
  assert.ok(Array.isArray(type.guide) && type.guide.length > 0, 'a page type with no guide entry cannot be opened')
  for (const entry of type.guide) {
    assert.ok(entry.id, 'guide entries need an id')
    assert.equal(typeof entry.title, 'function')
    assert.equal(typeof entry.description, 'function')
  }
})

test('the tab body registers under the same key as the type id, and the message action is its own cell', () => {
  const { captured } = runApply()
  assert.equal(captured.slots.length, 2, 'panel body + message action')

  const body = captured.slots.find(slot => slot.name === 'sidebar.right.pane.tab')
  assert.ok(body, 'the panel body must register in the right bar')
  assert.equal(body.key, captured.tabTypes[0].id)

  const action = captured.slots.find(slot => slot.name === 'conversation.chat.assistant-actions')
  assert.ok(action, 'the message action belongs beside copy / like / dislike / share')
  assert.ok(action.id, 'list-slot registrations need an id')
  assert.equal(typeof action.order, 'number', 'order decides where it sits in that row')
})

test('the call path pads arguments to the descriptor arity', () => {
  // The gateway compares the call's argument count with the descriptor's
  // parameter count exactly; an omitted optional parameter fails the call.
  assert.match(source, /callRemote\(ns, 'ask', \[sessionId, value, level, mode, anchor \?\? undefined\]\)/)
  assert.match(source, /const args = descriptor\.parameters\.map\(\(parameter, index\) => values\[index\]\)/)
  assert.ok(!/ns\.ask\(/.test(source), 'calls must go through callRemote so arity cannot drift')
})

test('the message action resolves its own anchor before opening the panel', () => {
  // The action row only carries a durable message id; the host maps it to an
  // event sequence. Opening the panel must not depend on a direct service
  // property (ctx.sidebarRight is not injected and throws when accessed).
  assert.match(source, /callRemote\(ns, 'anchor', \[sessionId, messageId\]\)/)
  assert.match(source, /ctx\.get\('sidebarRight'\)/)
  assert.match(source, /controller\.openTab\('side-seat'\)/)
  assert.ok(!/ctx\.sidebarRight\b/.test(source), 'direct property access throws without inject')
})

test('the mounted namespace is read through ctx.get, never as a direct property', () => {
  // `ctx.remote.sideSeat` throws "cannot get property without inject": the
  // namespace service only exists after $mount, so it is not in this plugin's
  // inject list. The call path must go through ctx.get (which returns undefined
  // instead of throwing) and tolerate the namespace arriving late.
  assert.match(source, /ctx\.get\('remote\.sideSeat'\)/)
  assert.ok(!/ctx\.remote\.sideSeat\b/.test(source), 'direct property access throws at call time')
  assert.match(source, /setTimeout\(resolve, 150\)/, 'the namespace may not be mounted yet on first paint')
})

test('the host manifest and the client contribution describe the same endpoints', async () => {
  // They are two hand-written copies of one contract (the client bundle cannot
  // import the host module), so the only way to keep them honest is to compare.
  const { TYPERT } = await import('../typert.host.js')
  const { captured } = runApply()

  const host = TYPERT.invocations.map(i => `${i.namespace}/${i.method}`).sort()
  const client = captured.mounts[0].descriptors.map(d => `${d.namespace}/${d.method}`).sort()
  assert.deepEqual(client, host, 'every host endpoint must be mounted by the client')

  for (const descriptor of captured.mounts[0].descriptors) {
    const hostEntry = TYPERT.invocations.find(i => `${i.namespace}/${i.method}` === `${descriptor.namespace}/${descriptor.method}`)
    assert.equal(descriptor.parameters.length, hostEntry.parameters.length)
    assert.equal(descriptor.result.mode, hostEntry.result.mode)
  }
})
