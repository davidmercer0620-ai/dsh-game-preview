/**
 * Local harness: runs the Host half against a stub Cordis context so the control
 * API, detection, the dirty watcher and tool registration can be verified
 * without restarting the Harness process.
 */
import { apply } from '../index.js'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const JSON_HEADERS = { 'content-type': 'application/json' }

const root = join(tmpdir(), 'dgp-harness')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title><canvas></canvas>')

const tools = new Map()
const effects = []
const ctx = {
  logger: { info() {}, warn: (...a) => console.error('WARN', ...a) },
  get: () => undefined,
  effect: (fn) => { const d = fn(); effects.push(d); return d },
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
  workingDirectory: { get: () => root },
}

apply(ctx, { port: 7401, waitForMs: 1500, godotExe: 'C:\\Windows\\System32\\notepad.exe' })

await new Promise((r) => setTimeout(r, 600))
const base = 'http://127.0.0.1:7401'
const hello = await (await fetch(base + '/api/hello')).json()
console.log('hello', JSON.stringify(hello))

const detected = await (await fetch(base + '/api/detect', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ root }),
})).json()
console.log('configs', detected.configs.map((c) => `${c.id}:${c.kind}`).join(','))

const ran = await (await fetch(base + '/api/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ configId: 'static' }),
})).json()
console.log('run', ran.ok, ran.active?.url?.slice(0, 60))

const page = await fetch(ran.active.url)
const html = await page.text()
console.log('file served', page.status, html.includes('canvas'))

// dirty watcher
writeFileSync(join(root, 'src', 'game.js'), 'v1')
await new Promise((r) => setTimeout(r, 900))
const afterEdit = await (await fetch(base + '/api/state')).json()
console.log('dirty', JSON.stringify(afterEdit.dirty))

const toolNames = [...tools.keys()]
console.log('tools', toolNames.join(','))
for (const name of toolNames) {
  const def = tools.get(name)
  const out = await def.execute({}, { agent: {} })
  console.log(' →', name, String(out).slice(0, 90))
}

/* ------------------------------------------- engine detection fixtures */

async function detectOf(dir) {
  const res = await fetch(base + '/api/detect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: dir }),
  })
  return res.json()
}

const wechat = join(tmpdir(), 'dgp-wechat')
rmSync(wechat, { recursive: true, force: true })
mkdirSync(wechat, { recursive: true })
writeFileSync(join(wechat, 'project.config.json'), '{"appid":"wx-test"}')
writeFileSync(join(wechat, 'game.json'), '{"deviceOrientation":"portrait"}')
const wechatDetect = await detectOf(wechat)
console.log('wechat configs', wechatDetect.configs.map((c) => c.id).join(','))
const wechatRun = await (await fetch(base + '/api/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ configId: 'wechat' }),
})).json()
console.log('wechat run', wechatRun.ok, '|', wechatRun.error)
if (wechatRun.ok) throw new Error('wechat run should fail without the devtools cli')
if (!/cli\.bat/.test(wechatRun.error)) throw new Error('wechat error must name cli.bat, got: ' + wechatRun.error)

const cocos = join(tmpdir(), 'dgp-cocos')
rmSync(cocos, { recursive: true, force: true })
mkdirSync(join(cocos, 'assets'), { recursive: true })
mkdirSync(join(cocos, 'settings'), { recursive: true })
const cocosDetect = await detectOf(cocos)
console.log('cocos configs', cocosDetect.configs.map((c) => `${c.id}@${c.url}`).join(','))
const cocosCfg = cocosDetect.configs.find((c) => c.id === 'cocos-web')
if (!cocosCfg || cocosCfg.url !== 'http://localhost:7456') throw new Error('cocos detection is wrong')

const cocosRun = await (await fetch(base + '/api/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ configId: 'cocos-web' }),
})).json()
console.log('cocos run', cocosRun.ok, '|', String(cocosRun.error).slice(0, 80))
if (cocosRun.ok !== false) throw new Error('cocos timeout must report ok:false')
if (!/浏览器预览/.test(String(cocosRun.error))) throw new Error('cocos timeout must tell the user what to do next')

/* ------------------------------- nested projects and serve-style scripts */

console.log('\n--- nested detection ---')

const nested = join(tmpdir(), 'dgp-nested')
rmSync(nested, { recursive: true, force: true })
mkdirSync(join(nested, 'cocos', 'settings'), { recursive: true })
mkdirSync(join(nested, 'cocos', 'assets'), { recursive: true })
mkdirSync(join(nested, 'tools'), { recursive: true })
writeFileSync(join(nested, 'package.json'), JSON.stringify({ scripts: { serve: 'node tools/serve.mjs' } }))
writeFileSync(join(nested, 'tools', 'serve.mjs'), 'const PORT = 8123\nconsole.log(PORT)\n')
writeFileSync(join(nested, 'cocos', 'index.html'), '<!doctype html><title>nested</title><canvas></canvas><script src="main.js"></script>')
writeFileSync(join(nested, 'cocos', 'main.js'), "console.log('nested-js')")

const nestedDetect = await detectOf(nested)
console.log('nested configs', nestedDetect.configs.map((c) => `${c.id}@${c.dir ?? '.'}`).join(', '))
const nestedIds = nestedDetect.configs.map((c) => c.id)
if (!nestedIds.includes('node-dev')) throw new Error('a package.json with only a serve script must still be detected')
if (!nestedIds.includes('cocos-web@cocos')) throw new Error('a nested Cocos project must be detected')
const serveCfg = nestedDetect.configs.find((c) => c.id === 'node-dev')
if (serveCfg.url !== 'http://localhost:8123') throw new Error('the serve port should be read from the script file, got ' + serveCfg.url)

const nestedStatic = await (await fetch(base + '/api/run', {
  method: 'POST', headers: JSON_HEADERS,
  body: JSON.stringify({ configId: 'static@cocos', root: nested }),
})).json()
console.log('nested static', nestedStatic.ok, nestedStatic.active?.url?.slice(0, 70))
if (!nestedStatic.ok) throw new Error('a nested static config must run: ' + nestedStatic.error)
if (!String(nestedStatic.active.url).includes('/static/')) throw new Error('a static game must be served from /static/ so relative assets resolve')
const nestedPage = await fetch(nestedStatic.active.url)
const nestedHtml = await nestedPage.text()
if (!nestedHtml.includes('canvas')) throw new Error('nested static page did not serve the subdirectory file')

// a sibling <script src="main.js"> must resolve next to index.html, not at the server root
const assetUrl = new URL('main.js', nestedStatic.active.url)
const asset = await fetch(assetUrl)
const assetBody = await asset.text()
console.log('nested asset', asset.status, assetUrl.pathname.slice(0, 40), '|', assetBody.slice(0, 24))
if (asset.status !== 200 || !assetBody.includes('nested-js')) throw new Error('relative assets broke: ' + asset.status)

// the static route only serves directories the plugin registered
const forged = Buffer.from('C:\\Windows', 'utf8').toString('base64url')
const blocked = await fetch(base + '/static/' + forged + '/win.ini')
console.log('unregistered root', blocked.status)
if (blocked.status !== 403) throw new Error('static route must refuse unregistered roots')

/* ------------------------------------- real dev server: start, wait, stop */

const devApp = join(tmpdir(), 'dgp-dev')
rmSync(devApp, { recursive: true, force: true })
mkdirSync(devApp, { recursive: true })
writeFileSync(join(devApp, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js --port 7458' } }))
writeFileSync(join(devApp, 'server.js'), [
  "const http = require('http')",
  'const port = Number(process.argv.at(-1))',
  "http.createServer((_q, s) => s.end('ok')).listen(port, '127.0.0.1')",
].join('\n'))

const devDetect = await detectOf(devApp)
const devCfg = devDetect.configs.find((c) => c.id === 'node-dev')
console.log('node-dev config', devCfg?.url)
if (devCfg?.url !== 'http://localhost:7458') throw new Error('dev url guess is wrong')

const stopDev = () => fetch(base + '/api/stop', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
}).catch(() => {})

try {
  const devRun = await (await fetch(base + '/api/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configId: 'node-dev', waitMs: 20000 }),
  })).json()
  console.log('node-dev run', devRun.ok, 'waited', devRun.waitedMs, 'ms')
  if (devRun.ok !== true) throw new Error('dev server did not become ready: ' + devRun.error)
  const devPage = await fetch('http://localhost:7458/')
  if (!(await devPage.text()).includes('ok')) throw new Error('dev server did not answer')

  await stopDev()
  let stopped = false
  for (let i = 0; i < 25 && !stopped; i += 1) {
    await new Promise((r) => setTimeout(r, 300))
    try {
      await fetch('http://localhost:7458/', { signal: AbortSignal.timeout(400) })
    } catch {
      stopped = true
    }
  }
  console.log('node-dev stopped', stopped)
  if (!stopped) throw new Error('stop did not kill the dev server process tree')
} finally {
  await stopDev()
}

/* ------------------------------------------------ v0.2 native window capture */

console.log('\n--- window capture (v0.2) ---')

const notepad = spawn('notepad.exe', [], { windowsHide: false, detached: false })
try {
  await sleep(1400)
  const listed = await (await fetch(base + '/api/window/list')).json()
  console.log('windows', listed.ok, listed.windows?.length ?? 0)
  if (!listed.ok) throw new Error('window list failed: ' + listed.error)
  const target = (listed.windows ?? []).find((w) => w.pid === notepad.pid)
  if (!target) throw new Error('could not find the notepad window for pid ' + notepad.pid)

  const attached = await (await fetch(base + '/api/window/attach', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ hwnd: target.hwnd }),
  })).json()
  console.log('attach', attached.ok, attached.active?.kind, 'capture running:', attached.capture?.running)
  if (!attached.ok) throw new Error('attach failed: ' + attached.error)
  if (attached.active?.kind !== 'window') throw new Error('active preview should be kind=window')
  if (!/\/stream\?hwnd=/.test(String(attached.active.url))) throw new Error('window preview must point at /stream')

  await sleep(1600)
  const frameRes = await fetch(base + '/api/frame')
  const jpeg = Buffer.from(await frameRes.arrayBuffer())
  console.log('frame', frameRes.status, jpeg.length + 'B', 'header', jpeg.subarray(0, 3).toString('hex'))
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('frame is not a JPEG')

  const live = await (await fetch(base + '/api/state')).json()
  console.log('capture state', JSON.stringify({ fps: live.capture.fps, w: live.capture.width, h: live.capture.height, frames: live.capture.frames }))
  if (!(live.capture.fps > 0)) throw new Error('no frame rate measured')
  if (!live.capture.width || !live.capture.height) throw new Error('capture has no frame size')

  // multipart stream: first boundary and one JPEG part must arrive
  const streamRes = await fetch(base + '/stream')
  const reader = streamRes.body.getReader()
  const { value } = await reader.read()
  const head = Buffer.from(value ?? []).toString('latin1')
  reader.cancel().catch(() => {})
  console.log('stream', streamRes.status, /boundary=frame/.test(streamRes.headers.get('content-type') ?? ''), head.slice(0, 40))
  if (!/multipart\/x-mixed-replace/.test(streamRes.headers.get('content-type') ?? '')) throw new Error('stream is not multipart')
  if (!head.includes('Content-Type: image/jpeg')) throw new Error('stream did not start with a JPEG part')

  // closing the captured window must surface as window-closed, not a frozen picture
  await new Promise((resolve) => execFile('taskkill', ['/pid', String(notepad.pid), '/T', '/F'], () => resolve()))
  let closed = null
  for (let i = 0; i < 20 && !closed; i += 1) {
    await sleep(300)
    const state = await (await fetch(base + '/api/state')).json()
    if (state.capture.errorCode === 'window-closed') closed = state.capture
  }
  console.log('window closed ->', closed?.errorCode ?? 'not detected', '|', closed?.error ?? '')
  if (!closed) throw new Error('closing the window must be reported as window-closed')

  const stoppedCapture = await (await fetch(base + '/api/stop', { method: 'POST', headers: JSON_HEADERS, body: '{}' })).json()
  console.log('capture stopped', stoppedCapture.capture?.running === false)
  if (stoppedCapture.capture?.running !== false) throw new Error('stop must stop the capture')

  // a window that does not exist must fail with an actionable message
  const missing = await (await fetch(base + '/api/window/attach', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ hwnd: 1 }),
  })).json()
  console.log('missing window ->', missing.ok, String(missing.error).slice(0, 60))
  if (missing.ok !== false) throw new Error('attaching to a dead hwnd must fail')
} finally {
  try { notepad.kill() } catch {}
}

/* --------------------------- native launch path: engine -> window -> capture */

console.log('\n--- native launch path (godot config with a stand-in exe) ---')

const godotDir = join(tmpdir(), 'dgp-godot')
rmSync(godotDir, { recursive: true, force: true })
mkdirSync(godotDir, { recursive: true })
writeFileSync(join(godotDir, 'project.godot'), '[application]\nconfig/name="Stand-in"\n')

const godotDetect = await detectOf(godotDir)
const godotCfg = godotDetect.configs.find((c) => c.id === 'godot-native')
console.log('godot config', godotCfg?.id, godotCfg?.kind, '|', godotCfg?.detail)
if (!godotCfg) throw new Error('project.godot must produce a godot-native config')

const nativeRun = await fetch(base + '/api/run', {
  method: 'POST', headers: JSON_HEADERS,
  body: JSON.stringify({ configId: 'godot-native', root: godotDir }),
})
const nativeBody = await nativeRun.json()
console.log('native run', nativeBody.ok, nativeBody.active?.kind, '| hwnd', nativeBody.active?.hwnd, '| waited', nativeBody.waitedMs, 'ms')
if (!nativeBody.ok) throw new Error('native launch failed: ' + nativeBody.error)
if (nativeBody.active?.kind !== 'window') throw new Error('native launch must activate a window preview')
if (!nativeBody.capture?.running) throw new Error('native launch must start the capture')

await sleep(1200)
const nativeState = await (await fetch(base + '/api/state')).json()
console.log('native capture', JSON.stringify({ fps: nativeState.capture.fps, frames: nativeState.capture.frames }))
if (!(nativeState.capture.frames > 0)) throw new Error('native capture produced no frames')

const killed = await (await fetch(base + '/api/stop', { method: 'POST', headers: JSON_HEADERS, body: '{}' })).json()
console.log('native stop', killed.ok, 'capture:', killed.capture?.running)
if (killed.capture?.running !== false) throw new Error('stop must stop the native capture')

/* -------------------- missing engine binary must produce an actionable error */

const tools2 = new Map()
const effects2 = []
const ctx2 = {
  logger: { info() {}, warn: () => {} },
  get: () => undefined,
  effect: (fn) => { const d = fn(); effects2.push(d); return d },
  tools: { register: (def) => { tools2.set(def.name, def); return () => tools2.delete(def.name) } },
  workingDirectory: { get: () => godotDir },
}
apply(ctx2, { port: 7402, waitForMs: 800, godotExe: 'C:/no/such/godot.exe' })
await sleep(500)
await fetch('http://127.0.0.1:7402/api/detect', {
  method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ root: godotDir }),
})
const noEngine = await (await fetch('http://127.0.0.1:7402/api/run', {
  method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ configId: 'godot-native' }),
})).json()
console.log('missing engine ->', noEngine.ok, String(noEngine.error).slice(0, 50))
if (noEngine.ok !== false) throw new Error('a missing engine binary must fail fast')
if (!/godotExe/.test(String(noEngine.error))) throw new Error('the missing-engine error must name the config key')
for (const d of effects2) { try { d?.() } catch {} }

/* --------------------------------------------------------- security + api */

console.log('\n--- control api guards ---')

const foreign = await fetch(base + '/api/state', { headers: { origin: 'https://evil.example' } })
console.log('foreign origin', foreign.status, foreign.headers.get('access-control-allow-origin'))
if (foreign.status !== 403) throw new Error('a foreign origin must be rejected with 403')

const localOrigin = await fetch(base + '/api/hello', { headers: { origin: 'http://127.0.0.1:56543' } })
console.log('loopback origin', localOrigin.status, localOrigin.headers.get('access-control-allow-origin'))
if (localOrigin.status !== 200) throw new Error('the DSH page origin must be allowed')

const noRoot = await fetch(base + '/api/detect', { method: 'POST', headers: JSON_HEADERS, body: '{}' })
const noRootBody = await noRoot.json()
console.log('detect without root', noRoot.status, Array.isArray(noRootBody.configs) ? 'fell back to the last root' : '')
if (noRoot.status !== 200 && noRoot.status !== 400) throw new Error('detect without a root must not 500')

const badRoot = await fetch(base + '/api/detect', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ root: 'C:/no/such/project' }) })
console.log('detect missing dir', badRoot.status)
if (badRoot.status !== 404) throw new Error('detect on a missing directory must be 404')

for (const d of effects) { try { d?.() } catch {} }
for (const dir of [root, wechat, cocos, devApp, godotDir, nested]) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
process.exit(0)
