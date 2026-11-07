/**
 * Client harness: executes client.js against a fake window/ModuleLoader and a
 * minimal React shim, then runs the registration path and renders the panel
 * once. Catches typos, bad slot options and component-body errors without a
 * browser.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(join(here, '..', 'client.js'), 'utf8')

/* ---------------------------------------------------------------- React shim */

const createElement = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity).filter((c) => c !== undefined && c !== null && c !== false),
})

const react = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: (initial) => {
    const override = react.__states.length ? react.__states.shift() : undefined
    return [override !== undefined ? override : (typeof initial === 'function' ? initial() : initial), () => {}]
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useContext: () => ({}),
  __states: [],
}

/* ------------------------------------------------------------ ModuleLoader */

const modules = []
const win = {
  __ModuleLoader__: { load: (m) => modules.push(m) },
  open: () => null,
  addEventListener: () => {},
}
new Function('window', code)(win)

if (modules.length !== 1) throw new Error(`expected one module registration, got ${modules.length}`)
const mod = modules[0]
if (mod.id !== 'dsh-game-preview') throw new Error(`unexpected module id: ${mod.id}`)

/* ------------------------------------------------------------- fake context */

const tabs = []
const slots = []
const slotService = {
  inject: (_key, cb) => {
    const dispose = cb()
    return () => dispose?.()
  },
  register: (options, component) => {
    slots.push({ options, component })
    return () => {}
  },
}

const ctx = {
  inject: (names, cb) => {
    if (!names.includes('sidebarRightTabs')) return { dispose() {} }
    cb({
      sidebarRightTabs: {
        register: (definition) => {
          tabs.push(definition)
          return () => {}
        },
      },
      slots: slotService,
    })
    return { dispose() {} }
  },
  slots: slotService,
  get: () => undefined,
}

const api = mod.factory((name) => {
  if (name === 'react') return react
  return {}
})

if (typeof api.apply !== 'function') throw new Error('client factory did not return apply()')
api.apply(ctx)

if (tabs.length !== 1) throw new Error(`expected 1 tab type, got ${tabs.length}`)
const tab = tabs[0]
if (tab.kind !== 'game-preview') throw new Error(`unexpected kind: ${tab.kind}`)
if (typeof tab.title() !== 'string') throw new Error('tab title must resolve to a string')
if (!Array.isArray(tab.guide) || tab.guide.length === 0) throw new Error('tab guide is missing')

const body = slots.find((s) => s.options.name === 'sidebar.right.pane.tab')
if (!body) throw new Error('panel was not registered into sidebar.right.pane.tab')
const header = slots.find((s) => s.options.name === 'conversation.session.header.utilities')
if (!header) throw new Error('header button was not registered')

/* --------------------------------------------------------------- render once */

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

const tree = body.component({})
const types = []
walk(tree, (n) => types.push(typeof n.type === 'string' ? n.type : String(n.type)))
if (!types.includes('iframe') && !types.includes('input')) {
  throw new Error(`panel rendered no stage and no path input: ${types.slice(0, 8).join(',')}`)
}

const headerTree = header.component({})
walk(headerTree, (n) => types.push(n.type === 'button' ? 'button' : ''))
if (!types.includes('button')) throw new Error('header control rendered no button')

/* ------------------------------------------- render the running stage state */

react.__states = [{
  configs: [{ id: 'static', kind: 'web', title: '静态 HTML' }],
  active: { id: 'static', kind: 'web', url: 'http://127.0.0.1:7317/file?root=x&path=index.html' },
  dirty: ['src/game.js'],
  running: true,
  root: 'C:/games/demo',
}]
const running = body.component({})
const stageSrcs = []
const dirtyText = []
walk(running, (n) => {
  if (n.type === 'iframe') stageSrcs.push(n.props.src)
  if (typeof n.props?.className === 'string' && n.props.className.includes('gp-dirty')) {
    dirtyText.push(JSON.stringify(n.children))
  }
})
if (stageSrcs.length !== 1) throw new Error(`running state rendered ${stageSrcs.length} stages`)
if (!dirtyText.length) throw new Error('running state rendered no dirty badge')
if (!stageSrcs[0].startsWith('http://127.0.0.1:7317/file')) throw new Error('stage src is not the preview URL')
if (!dirtyText[0].includes('1 处改动待运行')) throw new Error(`dirty badge text is wrong: ${dirtyText[0]}`)

/* ---------------------------------------- render the window-capture stage (v0.2) */

const windowSnap = {
  root: 'F:\\Games\\godot-demo',
  configs: [{ id: 'godot-native', kind: 'native', title: 'Godot · 原生' }],
  active: {
    id: 'godot-native', kind: 'window', windowTitle: 'My Game',
    url: 'http://127.0.0.1:7317/stream?hwnd=4242&t=1',
  },
  dirty: [],
  running: true,
  capture: { supported: true, running: true, fps: 24.5, width: 1280, height: 720, stale: false, error: null, errorCode: null, black: 0 },
}
// useState order in Panel: snap, error, busy, reloadKey, width, manualRoot, manualUrl, windows, roots, winBusy
react.__states = [windowSnap, null, false, 0, 0, '', '', null, null, false]
const windowTree = body.component({})
const shots = []
const badges = []
walk(windowTree, (n) => {
  if (n.type === 'img') shots.push(n.props)
  if (typeof n.props?.className === 'string' && n.props.className === 'gp-live') {
    walk(n, (c) => { if (typeof c.children?.[0] === 'string') badges.push(c.children[0]) })
  }
})
if (shots.length !== 1) throw new Error(`window state rendered ${shots.length} images`)
if (!String(shots[0].src).includes('/stream?hwnd=4242')) throw new Error('window stage must point at the capture stream')
if (!badges.some((b) => b.includes('fps'))) throw new Error(`window stage rendered no fps badge: ${badges.join('|')}`)

// a stale capture must show the disconnect badge rather than a silent freeze
const staleSnap = { ...windowSnap, capture: { ...windowSnap.capture, fps: 0, stale: true } }
react.__states = [staleSnap, null, false, 0, 0, '', '', null, null, false]
const staleTree = body.component({})
const staleBadges = []
walk(staleTree, (n) => { if (typeof n.children?.[0] === 'string' && n.children[0] === '已断流') staleBadges.push(n.children[0]) })
if (!staleBadges.length) throw new Error('a stale capture must show the 已断流 badge')

// the workspace chip shows the directory the Host resolved, so a fresh session
// can tell it auto-detected the right project instead of guessing
const dirChips = []
walk(windowTree, (n) => {
  const label = typeof n.children?.[0] === 'string' ? n.children[0] : ''
  if (label.startsWith('📁')) dirChips.push(label)
})
if (!dirChips.length) throw new Error('panel did not render a workspace directory chip')

// the window picker renders one option per capturable window
react.__states = [windowSnap, null, false, 0, 0, '', '', [{ hwnd: 1, title: 'Godot', width: 1280, height: 720 }], null, false]
const pickerTree = body.component({})
let pickerOptions = 0
walk(pickerTree, (n) => { if (n.type === 'select') pickerOptions = (n.children ?? []).length })
if (pickerOptions < 2) throw new Error('window picker rendered no window options')

console.log('modules   ', modules.map((m) => m.id).join(','))
console.log('tab       ', tab.kind, '| title:', tab.title(), '| guide:', tab.guide.length)
console.log('slots     ', slots.map((s) => s.options.name).join(', '))
console.log('panel tree', types.filter(Boolean).slice(0, 10).join(' > '))
console.log('client OK')
