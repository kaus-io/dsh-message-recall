/**
 * Workspace smoke test: loads the client module the way the browser module
 * loader does, applies it to a fake Client context, and renders the registered
 * `user` row once with a minimal React shim. Not a browser test.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, 'client.js')

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

await import(entry)

if (captured === undefined) throw new Error('module loader was not called')
if (captured.id !== '@local/dsh-message-recall') throw new Error(`unexpected module id: ${captured.id}`)

const element = (type, props) => ({ type, props: props ?? {} })
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {},
}
const jsxRuntime = { jsx: element, jsxs: element, Fragment: Symbol('Fragment') }

const exports = captured.factory((id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`unexpected require: ${id}`)
})

if (typeof exports.apply !== 'function') throw new Error('apply is not exported')
if (!Array.isArray(exports.inject) || !exports.inject.includes('slots')) throw new Error('bad inject face')

const effects = []
let registered
const ctx = {
  effect(factory, label) {
    effects.push({ label, dispose: factory() })
  },
  locale: {
    dictionaries: undefined,
    register(namespace, dicts) {
      this.dictionaries = { namespace, dicts }
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      this.injected = key
      callback()
      return () => {}
    },
    register(options, component) {
      registered = { options, component }
      return () => {}
    },
  },
  get() {
    return undefined
  },
  sessions: {
    async fork(args) {
      return `child-of-${args.sessionId}`
    },
    binding() {
      return undefined
    },
  },
  uiWorkspace: {
    openSession() {},
    async archiveSession() {},
  },
}

exports.apply(ctx)

const labels = effects.map((effect) => effect.label)
if (!labels.includes('message-recall: styles')) throw new Error(`missing styles effect: ${labels.join(', ')}`)
if (ctx.locale.dictionaries?.namespace !== 'messageRecall') throw new Error('locale namespace not registered')
if (registered === undefined) throw new Error('no slot registration')
if (ctx.slots.injected !== 'conversation.chat.node') throw new Error('registered into the wrong slot')
if (registered.options.key !== 'user') throw new Error('registered for the wrong node kind')
if (!(registered.options.priority < 0)) throw new Error('priority must sit below the shipped renderer (0)')

const tree = registered.component({
  node: {
    kind: 'user',
    anchorSeq: 7,
    data: { seq: 7, time: Date.now(), content: [{ type: 'text', text: 'EasyRewrite 测试' }] },
  },
  renderFactorySlot(name, input) {
    if (name !== 'conversation.chat.user.content') throw new Error(`unexpected factory: ${name}`)
    if (input.content.text !== 'EasyRewrite 测试') throw new Error('bubble text was not carried through')
    return { type: 'factory', name, input }
  },
  loadImage() {},
  t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
  sessionId: 'session-a',
  useChat: (selector) => selector({ nodes: { values: () => [] } }),
  useAccess: () => true,
  useSessionStatus: (selector) => selector(new Map([['session-a', { running: false }]])),
  recall: async () => 'child',
})

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  if (node.props !== undefined) walk(node.props.children, visit)
}

const buttons = []
walk(tree, (node) => {
  if (node.props?.type === 'button') buttons.push(node.props['aria-label'])
})
if (buttons.length !== 2) throw new Error(`expected recall+copy buttons, saw ${JSON.stringify(buttons)}`)
if (!buttons.includes('recall') || !buttons.includes('copy')) throw new Error(`unexpected buttons: ${JSON.stringify(buttons)}`)

const clock = []
walk(tree, (node) => {
  if (typeof node === 'string') clock.push(node)
})
if (!clock.some((text) => /^\d{2}:\d{2}$/.test(text))) throw new Error(`clock label missing: ${JSON.stringify(clock)}`)

console.log('client smoke test ok:', JSON.stringify({ labels, registration: registered.options }))

/* Second render: image + file attachments, reference labels, skill names,
 * recall access denied, and a later human message (hover reveal path). */
const richTree = registered.component({
  node: {
    kind: 'user',
    anchorSeq: 3,
    data: {
      seq: 3,
      time: Date.now() - 86400000 * 400,
      content: [
        { type: 'text', text: '看图 ' },
        { type: 'image', attachment: { id: 'img-1' } },
        { type: 'file', attachment: { name: 'notes.md', bytes: 12 } },
        { type: 'text', text: '再改一下' },
      ],
      referenceLabels: ['src/app.ts'],
      skillNames: ['skill-a'],
    },
  },
  renderFactorySlot(name, input) {
    if (input.content.text !== '看图 再改一下') throw new Error('text join changed')
    if (input.content.attachments.length !== 2) throw new Error('attachments were not carried through')
    if (input.facts.sessionLabels?.[0] !== 'src/app.ts') throw new Error('reference labels missing')
    if (input.facts.skillNames?.[0] !== 'skill-a') throw new Error('skill names missing')
    return { type: 'factory', name, input }
  },
  loadImage() {},
  t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
  sessionId: 'session-b',
  useChat: (selector) => selector({ nodes: { values: () => [{ anchorSeq: 30, kind: 'user' }] } }),
  useAccess: () => false,
  useSessionStatus: (selector) => selector(new Map([['session-b', { running: true }]])),
  recall: async () => 'child',
})

const richButtons = []
walk(richTree, (node) => {
  if (node.props?.type === 'button') richButtons.push(node.props['aria-label'])
})
if (richButtons.length !== 1 || richButtons[0] !== 'copy') throw new Error(`access denied should leave only copy: ${JSON.stringify(richButtons)}`)

const classes = []
walk(richTree, (node) => {
  if (typeof node.props?.className === 'string') classes.push(node.props.className)
})
if (!classes.some((value) => value.includes('dshRecall_later'))) throw new Error('later-message hover reveal class missing')

console.log('client smoke test #2 ok')
