/**
 * dsh-game-preview — Host half.
 *
 * Owns the workspace scan, the dev-server lifecycle, the dirty-file watcher and
 * a small loopback control API the panel talks to. Zero runtime dependencies:
 * only node: builtins and the Cordis context.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export const inject = ['tools']

const APP_ID = 'dsh-game-preview'
const BASE_PORT = 7317
const PORT_TRIES = 16

const IGNORE = [
  'node_modules', '.git', 'dist', 'build', 'temp', 'library', 'logs',
  '.dsh-game-preview', 'out', 'bin', 'obj', '.cache', '.vscode',
]

/* ------------------------------------------------------------------ helpers */

function safeJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function has(root, p) {
  try {
    return existsSync(join(root, p))
  } catch {
    return false
  }
}

function listDir(root, p) {
  try {
    return readdirSync(join(root, p))
  } catch {
    return []
  }
}

function isDir(root, p) {
  try {
    return statSync(join(root, p)).isDirectory()
  } catch {
    return false
  }
}

function ignored(rel) {
  const parts = rel.split(/[\\/]/)
  return parts.some((part) => IGNORE.includes(part))
}

function portOf(url, fallback) {
  try {
    const u = new URL(url)
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch {
    return fallback
  }
}

async function reachable(url, timeoutMs = 1200) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'manual' })
    return res.status > 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitFor(url, timeoutMs, signal) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return false
    if (await reachable(url)) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

/* ------------------------------------------------------------- detection */

function guessDevUrl(pkg) {
  const script = String(pkg?.scripts?.dev ?? '') + ' ' + String(pkg?.scripts?.start ?? '')
  const port = /(?:--port[= ]|PORT=)(\d{2,5})/.exec(script)?.[1]
  const framework = pkg?.dependencies?.next ? 'next' : pkg?.dependencies?.vite ? 'vite' : null
  const resolved = port ?? (framework === 'next' ? '3000' : framework === 'vite' ? '5173' : '5173')
  return `http://localhost:${resolved}`
}

function detect(root) {
  const configs = []
  const pkg = has(root, 'package.json') ? safeJson(join(root, 'package.json')) : null

  // Cocos Creator: settings/ + assets/, or a settings/v2 tree
  const cocos = (has(root, 'settings') && has(root, 'assets')) || has(root, 'settings/v2')
  if (cocos) {
    configs.push({
      id: 'cocos-web',
      kind: 'web',
      title: 'Cocos · Web',
      detail: '编辑器预览 :7456（HMR）',
      url: 'http://localhost:7456',
      estimatedMs: 1200,
      reload: 'hmr',
    })
  }

  // WeChat mini game project (usually produced by Cocos)
  if (has(root, 'project.config.json') && has(root, 'game.json')) {
    configs.push({
      id: 'wechat',
      kind: 'wechat',
      title: '微信小游戏',
      detail: '构建目录 + 开发者工具',
      projectPath: '.',
      estimatedMs: 90000,
      reload: 'hard',
    })
  }

  // Godot / Unity: detected, native window capture ships in v0.2
  if (has(root, 'project.godot')) {
    configs.push({
      id: 'godot-native',
      kind: 'native',
      title: 'Godot · 原生',
      detail: '窗口捕获 v0.2',
      estimatedMs: 3000,
      reload: 'hard',
    })
  }
  if (has(root, 'ProjectSettings') && has(root, 'Assets')) {
    configs.push({
      id: 'unity-native',
      kind: 'native',
      title: 'Unity · 原生',
      detail: '窗口捕获 v0.2',
      estimatedMs: 3000,
      reload: 'hard',
    })
  }

  // Generic node dev server
  if (pkg?.scripts?.dev || pkg?.scripts?.start) {
    configs.push({
      id: 'node-dev',
      kind: 'web',
      title: 'Web · dev server',
      detail: pkg?.scripts?.dev ? 'npm run dev' : 'npm start',
      url: guessDevUrl(pkg),
      cmd: pkg?.scripts?.dev ? 'npm run dev' : 'npm start',
      estimatedMs: 5000,
      reload: 'hmr',
    })
  }

  // Static single page
  if (!configs.length && (has(root, 'index.html') || listDir(root).some((n) => n.endsWith('.html')))) {
    configs.push({
      id: 'static',
      kind: 'web',
      title: '静态 HTML',
      detail: '本地文件',
      file: has(root, 'index.html') ? 'index.html' : listDir(root).find((n) => n.endsWith('.html')),
      estimatedMs: 200,
      reload: 'manual',
    })
  }

  if (!configs.length) {
    configs.push({ id: 'manual', kind: 'manual', title: '手动 URL', detail: '填一个地址', estimatedMs: 0, reload: 'manual' })
  }
  return configs
}

/* ---------------------------------------------------------------- plugin */

export function apply(ctx, config = {}) {
  const log = (...args) => ctx.logger?.info?.('[game-preview]', ...args)
  const roots = new Map() // root -> { configs, dirty:Set, watcher }
  const proc = { child: null, config: null, startedAt: 0, logTail: [] }
  const state = { active: null, lastRoot: null, lastError: null }

  /* -- workspace bookkeeping ------------------------------------------- */

  function ensureRoot(root) {
    const abs = resolve(root)
    let entry = roots.get(abs)
    if (entry) return entry
    entry = { root: abs, configs: null, dirty: new Set(), watcher: null }
    roots.set(abs, entry)
    startWatch(entry)
    return entry
  }

  function startWatch(entry) {
    if (entry.watcher) return
    try {
      entry.watcher = watch(entry.root, { recursive: true, persistent: false }, (_event, file) => {
        if (!file) return
        const rel = String(file)
        if (ignored(rel)) return
        // fs.watch also reports the containing directory; only real files count as dirty
        try {
          if (statSync(join(entry.root, rel)).isDirectory()) return
        } catch {
          return
        }
        entry.dirty.add(rel.split(sep).join('/'))
      })
      entry.watcher.on('error', () => { entry.watcher = null })
    } catch (error) {
      log('watch failed', String(error))
    }
  }

  function snapshot(root) {
    const entry = root ? ensureRoot(root) : state.lastRoot ? ensureRoot(state.lastRoot) : null
    if (entry && !entry.configs) entry.configs = detect(entry.root)
    return {
      ok: true,
      app: APP_ID,
      root: entry?.root ?? null,
      configs: entry?.configs ?? [],
      dirty: entry ? [...entry.dirty] : [],
      active: state.active,
      running: Boolean(proc.child),
      error: state.lastError,
      ports: servedPorts,
    }
  }

  /* -- process control -------------------------------------------------- */

  function killChild() {
    if (!proc.child) return
    try {
      proc.child.kill()
    } catch {}
    proc.child = null
    proc.config = null
  }

  function spawnCommand(cmd, cwd, label) {
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, detached: false })
    proc.child = child
    proc.startedAt = Date.now()
    proc.logTail = []
    const push = (buf) => {
      const text = String(buf)
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        proc.logTail.push(line.slice(0, 400))
        if (proc.logTail.length > 40) proc.logTail.shift()
      }
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    child.on('exit', (code) => {
      if (proc.child === child) {
        proc.child = null
        if (code !== 0) state.lastError = `${label} 退出（code ${code}）`
      }
    })
    return child
  }

  function resolveConfig(root, configId) {
    const entry = ensureRoot(root)
    if (!entry.configs) entry.configs = detect(entry.root)
    return entry.configs.find((c) => c.id === configId) ?? entry.configs[0]
  }

  /* -- HTTP control API ------------------------------------------------- */

  const servedPorts = []
  let server = null

  function corsHeaders(request) {
    const origin = request.headers.origin
    const allowed = new Set()
    try {
      const ws = ctx.get('webServer')
      const self = ws?.getOrigin?.()
      if (self) allowed.add(self)
    } catch {}
    allowed.add('http://127.0.0.1:53948')
    const ok = origin && [...allowed].includes(origin)
    return {
      'access-control-allow-origin': ok ? origin : origin ?? '*',
      'access-control-allow-headers': 'content-type, x-game-preview',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    }
  }

  function send(res, headers, body, status = 200) {
    res.writeHead(status, headers)
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!chunks.length) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return {}
    }
  }

  async function handle(req, res) {
    const headers = corsHeaders(req)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (path === '/api/hello') {
      send(res, headers, { ok: true, app: APP_ID, version: '0.1.0', ports: servedPorts, tools: tools.length })
      return
    }

    if (path === '/api/state') {
      const root = url.searchParams.get('root') ?? state.lastRoot ?? undefined
      send(res, headers, snapshot(root ?? undefined))
      return
    }

    if (path === '/api/detect') {
      const body = await readBody(req)
      const entry = ensureRoot(body.root)
      entry.configs = detect(entry.root)
      state.lastRoot = entry.root
      send(res, headers, snapshot(entry.root))
      return
    }

    if (path === '/api/run' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const result = await runPreview(body.root ?? state.lastRoot, body.configId, body.url)
        send(res, headers, result)
      } catch (error) {
        state.lastError = String(error?.message ?? error)
        send(res, headers, { ok: false, error: state.lastError }, 500)
      }
      return
    }

    if (path === '/api/stop' && req.method === 'POST') {
      killChild()
      state.active = null
      send(res, headers, snapshot(state.lastRoot ?? undefined))
      return
    }

    if (path === '/api/clean' && req.method === 'POST') {
      const entry = state.lastRoot ? ensureRoot(state.lastRoot) : null
      entry?.dirty.clear()
      send(res, headers, snapshot(state.lastRoot ?? undefined))
      return
    }

    if (path === '/api/log') {
      send(res, headers, { ok: true, lines: proc.logTail, active: state.active, running: Boolean(proc.child) })
      return
    }

    // static file serving for single-page games, contained to its root
    if (path === '/file') {
      const root = resolve(url.searchParams.get('root') ?? '')
      const target = resolve(root, url.searchParams.get('path') ?? '')
      if (!target.startsWith(root + sep) && target !== root) {
        send(res, headers, { ok: false, error: 'containment' }, 403)
        return
      }
      const ext = target.slice(target.lastIndexOf('.')).toLowerCase()
      const types = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
        '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
      }
      try {
        const data = readFileSync(target)
        res.writeHead(200, { ...headers, 'content-type': types[ext] ?? 'application/octet-stream' })
        res.end(data)
      } catch {
        send(res, headers, { ok: false, error: 'not found' }, 404)
      }
      return
    }

    send(res, headers, { ok: false, error: 'not found' }, 404)
  }

  async function runPreview(rootArg, configId, overrideUrl) {
    const root = rootArg ?? state.lastRoot
    if (!root) throw new Error('还没有工作区：先在对话里让我跑一次预览，或在面板里填入项目路径')
    const cfg = resolveConfig(root, configId)
    if (!cfg) throw new Error('这个项目没有可运行的配置')
    state.lastRoot = resolve(root)
    state.lastError = null
    const entry = ensureRoot(state.lastRoot)
    entry.dirty.clear()

    if (overrideUrl) cfg.url = overrideUrl

    if (cfg.kind === 'manual') {
      if (!overrideUrl) throw new Error('手动模式需要在面板里填一个 URL')
      state.active = { id: cfg.id, title: cfg.title, kind: cfg.kind, url: overrideUrl, startedAt: Date.now() }
      return { ...snapshot(state.lastRoot), waitedMs: 0 }
    }

    if (cfg.kind === 'native') {
      throw new Error(`${cfg.title} 的原生窗口捕获在 v0.2；当前请用引擎自带的 Play 按钮`)
    }

    if (cfg.kind === 'wechat') {
      const cli = findWechatCli(config)
      if (!cli) throw new Error('没找到微信开发者工具 cli.bat：请在插件配置 wechatCli 里填写绝对路径')
      const projectPath = resolve(state.lastRoot, cfg.projectPath ?? '.')
      const args = ['open', '--project', projectPath]
      const child = spawn(`"${cli}"`, { cwd: state.lastRoot, shell: true, windowsHide: true })
      proc.child = child
      child.on('exit', () => { if (proc.child === child) proc.child = null })
      state.active = {
        id: cfg.id, title: cfg.title, kind: 'wechat', external: true,
        url: null, projectPath, startedAt: Date.now(),
      }
      return { ...snapshot(state.lastRoot), waitedMs: 0, external: true }
    }

    // web
    const started = Date.now()
    if (cfg.url && (await reachable(cfg.url))) {
      state.active = { id: cfg.id, title: cfg.title, kind: 'web', url: cfg.url, startedAt: Date.now() }
      return { ...snapshot(state.lastRoot), waitedMs: 0 }
    }
    if (cfg.cmd && !proc.child) spawnCommand(cfg.cmd, state.lastRoot, cfg.title)
    if (cfg.file) {
      const origin = `http://127.0.0.1:${servedPorts[0] ?? BASE_PORT}`
      const query = `root=${encodeURIComponent(state.lastRoot)}&path=${encodeURIComponent(cfg.file)}`
      state.active = {
        id: cfg.id, title: cfg.title, kind: 'file',
        url: `${origin}/file?${query}`,
        startedAt: Date.now(),
      }
      return { ...snapshot(state.lastRoot), waitedMs: 0 }
    }
    const ok = await waitFor(cfg.url, config.waitForMs ?? 60000)
    state.active = {
      id: cfg.id, title: cfg.title, kind: 'web', url: cfg.url,
      startedAt: Date.now(), ready: ok,
    }
    if (!ok) {
      state.lastError = `等 ${cfg.url} 超时（${Math.round((Date.now() - started) / 1000)}s）`
    }
    return { ...snapshot(state.lastRoot), waitedMs: Date.now() - started, ready: ok }
  }

  function findWechatCli() {
    const candidates = [
      config.wechatCli,
      'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
      'C:/Program Files/Tencent/微信web开发者工具/cli.bat',
    ].filter(Boolean)
    return candidates.find((p) => existsSync(p)) ?? null
  }

  /* -- boot ------------------------------------------------------------- */

  const cleanup = []

  // control server: probe a small port range so a busy port never breaks the panel
  server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        send(res, corsHeaders(req), { ok: false, error: String(error?.message ?? error) }, 500)
      } catch {}
    })
  })
  cleanup.push(() => {
    try { server?.close() } catch {}
  })

  void (async () => {
    const first = Number(config.port ?? BASE_PORT)
    for (let i = 0; i < PORT_TRIES; i += 1) {
      const candidate = first + i
      try {
        await new Promise((ok, fail) => {
          const onError = (error) => {
            server.off('listening', ok)
            fail(error)
          }
          server.once('error', onError)
          server.once('listening', () => {
            server.off('error', onError)
            ok()
          })
          server.listen(candidate, '127.0.0.1')
        })
        servedPorts.push(candidate)
        log('control api on', String(candidate))
        return
      } catch {
        server.removeAllListeners('listening')
      }
    }
    ctx.logger?.warn?.('[game-preview] no free control port')
  })()

  cleanup.push(() => killChild())
  cleanup.push(() => {
    for (const entry of roots.values()) {
      try { entry.watcher?.close() } catch {}
    }
    roots.clear()
  })
  ctx.effect(() => () => {
    for (const fn of cleanup.splice(0)) {
      try { fn() } catch {}
    }
  }, 'game-preview cleanup')

  /* -- agent tools ------------------------------------------------------- */

  const tools = []
  const registerTool = (definition) => {
    try {
      const dispose = ctx.tools.register(definition)
      tools.push(dispose)
      return true
    } catch (error) {
      ctx.logger?.warn?.(`[game-preview] tool ${definition.name} failed:`, String(error))
      return false
    }
  }

  registerTool({
    name: 'game_preview_run',
    description:
      'Start or refresh the game preview panel for the current workspace: launches the dev server (or attaches to the running one), clears the dirty counter and returns the preview URL plus any start-up error. Use it after editing game code so the user can play the new build.',
    parameters: {
      config: { type: 'string', description: 'Config id from game_preview_status, e.g. cocos-web or wechat. Omit to use the detected default.' },
      url: { type: 'string', description: 'Override the preview URL (manual mode).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = await currentRoot(exec)
      try {
        const result = await runPreview(root, args?.config, args?.url)
        return JSON.stringify({
          ok: result.ok !== false,
          root: result.root,
          active: result.active,
          waitedMs: result.waitedMs,
          error: result.error ?? null,
          dirty: result.dirty?.length ?? 0,
        })
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  registerTool({
    name: 'game_preview_status',
    description:
      'Read the game preview state for the current workspace: detected run configurations, the active preview URL, whether a process is running, and which files changed since the last run.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const root = await currentRoot(exec)
      return JSON.stringify(snapshot(root))
    },
  })

  registerTool({
    name: 'game_preview_stop',
    description: 'Stop the dev server the game preview started and clear the active preview.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const root = await currentRoot(exec)
      killChild()
      state.active = null
      return JSON.stringify(snapshot(root))
    },
  })

  async function currentRoot(exec) {
    try {
      const agent = exec?.agent
      if (agent) {
        const dir = ctx.workingDirectory?.get?.(agent)
        if (dir) {
          state.lastRoot = resolve(dir)
          return state.lastRoot
        }
      }
    } catch {}
    return state.lastRoot ?? process.cwd()
  }

  ctx.effect(() => () => {
    for (const dispose of tools.splice(0)) {
      try { dispose?.() } catch {}
    }
  }, 'game-preview tools')

  log('ready')
}
