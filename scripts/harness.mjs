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

apply(ctx, { port: 7401 })

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

for (const d of effects) { try { d?.() } catch {} }
rmSync(root, { recursive: true, force: true })
process.exit(0)
