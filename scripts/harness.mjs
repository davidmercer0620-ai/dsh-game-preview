/**
 * Local harness: runs the Host half against a stub Cordis context so the control
 * API, detection, the dirty watcher and tool registration can be verified
 * without restarting the Harness process.
 */
import { apply } from '../index.js'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

apply(ctx, { port: 7401, waitForMs: 1500 })

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

for (const d of effects) { try { d?.() } catch {} }
for (const dir of [root, wechat, cocos, devApp]) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
process.exit(0)
