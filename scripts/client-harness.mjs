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
if (mod.id !== '@davidmercer0620-ai/dsh-game-preview') throw new Error(`module id must equal the package name, got: ${mod.id}`)

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

function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object') return
  visit(node)
  if (typeof node.type === 'function') {
    // each top-level render restarts from the fixture's seeded hook values,
    // otherwise a second walk over the same tree finds them exhausted
    if (depth === 0) react.__states = (node.__seed ?? react.__seed ?? []).slice()
    // render the nested component once so its markup is part of the tree,
    // passing children the way React does
    const props = { ...(node.props ?? {}) }
    if (node.children?.length) props.children = node.children.length === 1 ? node.children[0] : node.children
    let rendered = null
    try {
      const fn = node.type
      // class components cannot be called; instantiate and render once
      rendered = /^class[\s{]/.test(String(fn)) ? new fn(props).render() : fn(props)
    } catch (error) {
      if (process.env.DSH_DEBUG_HARNESS) console.error('[walk] component threw:', node.type?.name, String(error?.message ?? error))
      rendered = null
    }
    if (rendered) walk(rendered, visit, depth + 1)
    return
  }
  for (const child of node.children ?? []) walk(child, visit, depth + 1)
}

const renderPanel = (props = {}) => {
  const element = body.component(props)
  // remember the fixture this tree was built from: walks may happen much later
  element.__seed = (react.__seed ?? []).slice()
  return element
}

const tree = renderPanel()
const types = []
walk(tree, (n) => types.push(typeof n.type === 'string' ? n.type : String(n.type)))
const spinners = []
walk(tree, (n) => {
  if (typeof n.props?.className === 'string' && n.props.className.includes('gp-spinner')) spinners.push(n)
})
if (spinners.length !== 1) throw new Error('the first render must show the connecting skeleton')
if (!types.includes('div')) throw new Error('panel rendered nothing at all')

const headerTree = header.component({})
walk(headerTree, (n) => types.push(n.type === 'button' ? 'button' : ''))
if (!types.includes('button')) throw new Error('header control rendered no button')

/* ------------------------------------------- render the running stage state */

react.__seed = [{
  configs: [
    { id: 'static', kind: 'web', title: '静态 HTML' },
    { id: 'node-dev', kind: 'web', title: 'Web · serve', detail: 'npm run serve' },
  ],
  active: { id: 'static', kind: 'web', url: 'http://127.0.0.1:7317/file?root=x&path=index.html' },
  dirty: ['src/game.js'],
  running: true,
  root: 'C:/games/demo',
}]
const running = renderPanel()
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
if (!dirtyText[0].includes('"1"')) throw new Error(`dirty badge should collapse to a count: ${dirtyText[0]}`)

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
// useState order in Panel: snap, error, busy, reloadKey, viewport, manualRoot, rootOverride, manualUrl, immersive, crop, pointerMode, showExport, showLogs, logLines, quality, windows, roots, winBusy
react.__seed = [windowSnap, null, false, 0, 'auto', '', '', '', false, { mode: false, rect: null }, false, false, false, [], 'sharp', null, null, false]
const windowTree = renderPanel()
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
react.__seed = [staleSnap, null, false, 0, 'auto', '', '', '', false, { mode: false, rect: null }, false, false, false, [], 'sharp', null, null, false]
const staleTree = renderPanel()
const staleBadges = []
walk(staleTree, (n) => { if (typeof n.children?.[0] === 'string' && n.children[0] === '已断流') staleBadges.push(n.children[0]) })
if (!staleBadges.length) throw new Error('a stale capture must show the 已断流 badge')

// PC / phone / auto previews: three explicit buttons, and the stage box follows
const viewportLabels = []
walk(windowTree, (n) => {
  const label = typeof n.children?.[0] === 'string' ? n.children[0] : ''
  if (['自适应', 'PC', '手机'].includes(label)) viewportLabels.push(label)
})

if (viewportLabels.length !== 3) throw new Error('expected 自适应 / PC / 手机 buttons, got: ' + viewportLabels.join(','))

const vpBoxes = []
walk(windowTree, (n) => {
  if (typeof n.props?.className === 'string' && n.props.className === 'gp-device') vpBoxes.push(n.props['data-vp'])
})
if (vpBoxes[0] !== 'auto') throw new Error('stage box did not follow the auto viewport: ' + vpBoxes[0])

// a phone preview must be a 390x844 logical viewport, not a stretched box
react.__seed = [windowSnap, null, false, 0, 'mobile', '', '', '', false, { mode: false, rect: null }, false, false, false, [], 'sharp', null, null, false]
const phoneTree = renderPanel()
const screens = []
walk(phoneTree, (n) => {
  if (typeof n.props?.className === 'string' && n.props.className.includes('gp-device-screen')) screens.push(n.props)
})
const phoneScreen = screens.find((p) => p.style?.width === 390)
if (!phoneScreen) throw new Error('phone mode rendered no 390px-wide device screen')
if (phoneScreen.style.height !== 844) throw new Error('phone device screen must be 390x844, got ' + JSON.stringify(phoneScreen.style))

const pickerTreeForVp = renderPanel()
void pickerTreeForVp

// the workspace chip shows the directory the Host resolved, so a fresh session
// can tell it auto-detected the right project instead of guessing
const dirChips = []
walk(windowTree, (n) => {
  const label = typeof n.children?.[0] === 'string' ? n.children[0] : ''
  if (label.startsWith('📁')) dirChips.push(label)
})
if (!dirChips.length) throw new Error('panel did not render a workspace directory chip')

// the window picker renders one option per capturable window
react.__seed = [windowSnap, null, false, 0, 'pc', '', '', '', false, { mode: false, rect: null }, false, false, false, [], 'sharp', [{ hwnd: 1, title: 'Godot', width: 1280, height: 720 }], null, false]
const pickerTree = renderPanel()
let pickerOptions = 0
walk(pickerTree, (n) => { if (n.type === 'select') pickerOptions = (n.children ?? []).length })
if (pickerOptions < 2) throw new Error('window picker rendered no window options')

// no workspace known yet: the panel must offer the discovered directories
// instead of a dead end that says "nothing detected"
const noRootSnap = { root: null, configs: [], active: null, dirty: [], running: false, capture: { supported: true } }
react.__seed = [noRootSnap, null, false, 0, 'auto', '', '', '', false, { mode: false, rect: null }, false, false, false, [], 'sharp', null, [{ dir: 'F:\\game-a', at: 0 }, { dir: 'F:\\game-b', at: 0 }], false]
const noRootTree = renderPanel()
const rootOptions = []
walk(noRootTree, (n) => {
  if (n.type === 'select') rootOptions.push((n.children ?? []).length)
})
if (!rootOptions.some((n) => n >= 3)) throw new Error('without a workspace the panel must offer the discovered directories')

const noRootInputs = []
walk(noRootTree, (n) => { if (n.type === 'input') noRootInputs.push(n) })
if (!noRootInputs.length) throw new Error('the empty state must still accept a project path')

// regression guard: call sites keep the loopback shape '/api/...' while a
// same-origin base already ends in /api/game-preview, so `call` must strip the
// duplicated prefix. A missing strip produced '/api/game-preview/api/state' 404s.
if (!/path\.startsWith\('\/api\/'\)/.test(code) || !/path\.slice\('\/api'\.length\)/.test(code)) {
  throw new Error('call() must normalise the /api prefix for the same-origin transport')
}
const callSites = [...code.matchAll(/call\('([^'?]+)/g)].map((m) => m[1])
if (!callSites.length) throw new Error('no call sites found to check')
const badSites = callSites.filter((path) => !path.startsWith('/api/'))
if (badSites.length) throw new Error('call sites must use the /api/... shape: ' + badSites.join(','))

// the config row must collapse to one primary action plus a compact "more" menu
const primaryChips = []
const moreMenus = []
walk(running, (n) => {
  if (typeof n.props?.className === 'string' && n.props.className.includes('gp-chip-primary')) primaryChips.push(n.props)
  if (n.type === 'select' && String(n.props?.className ?? '').includes('gp-chip-select')) moreMenus.push(n)
})
if (process.env.DSH_DEBUG_HARNESS) {
  const seen = []
  walk(running, (n) => { if (typeof n.props?.className === 'string') seen.push(n.props.className) })
  console.error('[dbg] classes:', seen.slice(0, 16).join(' | '))
}
if (primaryChips.length !== 1) throw new Error(`expected one primary config button, got ${primaryChips.length}`)
if (moreMenus.length !== 1) throw new Error('expected one "other configs" menu')

// immersive mode hides every control and floats a single exit pill
react.__seed = [windowSnap, null, false, 0, 'auto', '', '', '', true, { mode: false, rect: null }, false, false, false, [], 'sharp', null, null, false]
const immersiveTree = renderPanel()
const exitPills = []
const chipRows = []
walk(immersiveTree, (n) => {
  if (typeof n.props?.className === 'string' && n.props.className.includes('gp-exit-full')) exitPills.push(n)
  if (typeof n.props?.className === 'string' && n.props.className.includes('gp-chips')) chipRows.push(n)
})
if (exitPills.length !== 1) throw new Error('immersive mode renders no exit control')
if (chipRows.length !== 0) throw new Error('immersive mode must hide the config row')

// pointer mode: the capture becomes an interactive surface
react.__seed = [windowSnap, null, false, 0, 'auto', '', '', '', false, { mode: false, rect: null }, true, false, false, [], 'sharp', null, null, false]
const interactiveTree = renderPanel()
const interactiveImgs = []
walk(interactiveTree, (n) => {
  if (n.type === 'img' && n.props?.['data-interactive'] === '1') interactiveImgs.push(n.props)
})
if (interactiveImgs.length !== 1) throw new Error('pointer mode did not make the stage interactive')
if (typeof interactiveImgs[0].onMouseDown !== 'function') throw new Error('interactive stage has no pointer handler')
if (typeof interactiveImgs[0].onKeyDown !== 'function') throw new Error('interactive stage has no key handler')

// crop tool: selecting a region is a mode, and a stored rect scales the image
react.__seed = [windowSnap, null, false, 0, 'auto', '', '', '', false, { mode: true, rect: null }, false, false, false, [], 'sharp', null, null, false]
const cropModeTree = renderPanel()
const cropLayers = []
walk(cropModeTree, (n) => {
  if (typeof n.props?.className === 'string' && n.props.className.includes('gp-crop-layer')) cropLayers.push(n)
})
if (cropLayers.length !== 1) throw new Error('crop mode rendered no selection layer')

react.__seed = [windowSnap, null, false, 0, 'auto', '', '', '', false, { mode: false, rect: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 } }, false, false, false, [], 'sharp', null, null, false]
const croppedTree = renderPanel()
const croppedInners = []
walk(croppedTree, (n) => {
  if (typeof n.props?.className === 'string' && n.props.className.includes('gp-crop-inner')) croppedInners.push(n.props.style)
})
if (croppedInners.length !== 1) throw new Error('stored crop rect rendered no cropped stage')
if (croppedInners[0].width !== '200%') throw new Error('crop must zoom the frame: ' + JSON.stringify(croppedInners[0]))
if (croppedInners[0].left !== '-50%') throw new Error('crop offset is wrong: ' + JSON.stringify(croppedInners[0]))

console.log('modules   ', modules.map((m) => m.id).join(','))
console.log('tab       ', tab.kind, '| title:', tab.title(), '| guide:', tab.guide.length)
console.log('slots     ', slots.map((s) => s.options.name).join(', '))
console.log('panel tree', types.filter(Boolean).slice(0, 10).join(' > '))
console.log('client OK')
