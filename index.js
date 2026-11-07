/**
 * dsh-game-preview — Host half.
 *
 * Owns the workspace scan, the dev-server lifecycle, the dirty-file watcher and
 * a small loopback control API the panel talks to. Zero runtime dependencies:
 * only node: builtins and the Cordis context.
 */
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WindowCapture } from './host/window.js'

export const inject = ['tools']

const APP_ID = 'dsh-game-preview'
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()
const BASE_PORT = 7317
const PORT_TRIES = 16
const HERE = dirname(fileURLToPath(import.meta.url))

const IGNORE = [
  'node_modules', '.git', 'dist', 'build', 'temp', 'library', 'logs',
  '.dsh-game-preview', 'out', 'bin', 'obj', '.cache', '.vscode',
]

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm',
}

function mimeOf(file) {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

function staticToken(dir) {
  return Buffer.from(dir, 'utf8').toString('base64url')
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

/* ------------------------------------------------------- engine launching */

function findOnPath(pattern) {
  const dirs = String(process.env.PATH ?? '').split(';').filter(Boolean)
  for (const dir of dirs) {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    // newest-looking match wins so Godot_v4.x beats an old 3.x install
    const hit = names
      .filter((name) => pattern.test(name))
      .sort()
      .pop()
    if (hit) return join(dir, hit)
  }
  return null
}

function findUnityEditor() {
  const hub = 'C:/Program Files/Unity/Hub/Editor'
  try {
    const versions = readdirSync(hub).sort()
    for (const version of versions.reverse()) {
      const exe = join(hub, version, 'Editor', 'Unity.exe')
      if (existsSync(exe)) return exe
    }
  } catch {}
  const plain = 'C:/Program Files/Unity/Editor/Unity.exe'
  return existsSync(plain) ? plain : null
}

/**
 * Resolve how to launch a native engine project. Returns { exe, args } or { error }.
 * Godot runs the main scene directly (the fast loop); Unity opens the editor
 * because Play mode has no headless equivalent without an editor script.
 */
function nativeLaunch(cfg, config, root) {
  if (cfg.engine === 'godot') {
    const exe = config.godotExe || findOnPath(/^godot[^\\/]*\.exe$/i)
    if (!exe || !existsSync(exe)) {
      return {
        error:
          '没找到 Godot 可执行文件：安装到非默认位置时，在插件配置 godotExe 里填绝对路径（例如 D:\\Godot\\Godot_v4.3-stable_win64.exe）',
      }
    }
    return { exe, args: ['--path', root] }
  }
  if (cfg.engine === 'unity') {
    const exe = config.unityExe || findUnityEditor()
    if (!exe || !existsSync(exe)) {
      return {
        error:
          '没找到 Unity.exe：装到非默认盘时，在插件配置 unityExe 里填绝对路径（<版本>\\Editor\\Unity.exe）',
      }
    }
    return { exe, args: ['-projectPath', root] }
  }
  return { error: `未知的原生引擎：${cfg.engine}` }
}

/* ------------------------------------------------------------- html bundle */

const BUNDLE_MAX_BYTES = 12 * 1024 * 1024

function inlineAsset(dir, rel) {
  try {
    const file = resolve(dir, rel)
    if (file !== dir && !file.startsWith(dir + sep)) return null
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > BUNDLE_MAX_BYTES) return null
    return { file, data: readFileSync(file), ext: file.slice(file.lastIndexOf('.')).toLowerCase() }
  } catch {
    return null
  }
}

/**
 * Turn a multi-file static game into one HTML string: scripts and stylesheets
 * are inlined and same-directory media becomes data URLs, so the page can run
 * from a blob URL where a file:// host cannot reach a loopback server.
 */
function bundleHtml(dir, entryRel) {
  const entry = inlineAsset(dir, entryRel || 'index.html')
  if (!entry) throw new Error(`找不到入口文件：${entryRel || 'index.html'}`)
  let html = entry.data.toString('utf8')
  const dirOfEntry = dirname(resolve(dir, entryRel || 'index.html'))
  const warned = new Set()

  html = html.replace(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi, (match, src) => {
    if (/^(https?:|data:|\/\/)/i.test(src)) return match
    const asset = inlineAsset(dirOfEntry, src)
    if (!asset) {
      warned.add(src)
      return match
    }
    return `<script>\n${asset.data.toString('utf8')}\n</script>`
  })

  html = html.replace(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, (match, href) => {
    if (/^(https?:|data:|\/\/)/i.test(href)) return match
    const asset = inlineAsset(dirOfEntry, href)
    if (!asset) {
      warned.add(href)
      return match
    }
    return `<style>\n${asset.data.toString('utf8')}\n</style>`
  })

  // same-directory images referenced from markup or CSS
  html = html.replace(/(["'])([\.\/\w-]+\.(?:png|jpe?g|webp|gif|svg|ico))\1/gi, (match, quote, ref) => {
    if (/^(https?:|data:)/i.test(ref)) return match
    const asset = inlineAsset(dirOfEntry, ref)
    if (!asset) return match
    const mime = MIME[asset.ext] ?? 'application/octet-stream'
    return `${quote}data:${mime};base64,${asset.data.toString('base64')}${quote}`
  })

  return { html, inlined: [...warned] }
}

/* --------------------------------------------------- same-origin responses */

const API_PREFIX = '/api/game-preview'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/* ------------------------------------------------------------- detection */

const SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview']

/** First runnable package script, in the order a game project usually wants it. */
function pickScript(pkg) {
  for (const name of SCRIPT_ORDER) {
    const body = pkg?.scripts?.[name]
    if (typeof body === 'string' && body.trim()) return { name, body }
  }
  return null
}

/** A port from the script itself, or from the file it runs (tools/serve.mjs often hardcodes one). */
function guessDevUrl(dir, pkg, script) {
  const body = String(script?.body ?? '')
  const inline = /(?:--port[= ]|\bPORT=)(\d{2,5})/.exec(body)?.[1]
  if (inline) return `http://localhost:${inline}`

  const file = /node\s+(?:\.\/)?([\w./-]+\.(?:mjs|js|cjs|ts))/.exec(body)?.[1]
  if (file) {
    try {
      const text = readFileSync(join(dir, file), 'utf8').slice(0, 8000)
      const port =
        /(?:PORT\s*=\s*|listen\s*\(\s*|port\s*[:=]\s*)(\d{4,5})/.exec(text)?.[1] ??
        /localhost:(\d{4,5})/.exec(text)?.[1]
      if (port) return `http://localhost:${port}`
    } catch {}
  }

  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
  if (deps.next) return 'http://localhost:3000'
  if (deps.vite) return 'http://localhost:5173'
  if (deps['@vue/cli-service']) return 'http://localhost:8080'
  return 'http://localhost:5173'
}

/** Configs this one directory can offer. `dir` is relative to the scanned root. */
function configsAt(dir, rel, pkg) {
  const out = []
  const label = rel === '.' ? '' : `（${rel}）`
  const dirField = rel === '.' ? undefined : rel

  // Cocos Creator: settings/ + assets/, or a settings/v2 tree
  if ((has(dir, 'settings') && has(dir, 'assets')) || has(dir, 'settings/v2')) {
    out.push({
      id: rel === '.' ? 'cocos-web' : `cocos-web@${rel}`,
      dir: dirField,
      kind: 'web',
      title: `Cocos · Web${label}`,
      detail: '编辑器预览 :7456（HMR）',
      url: 'http://localhost:7456',
      estimatedMs: 1200,
      reload: 'hmr',
    })
  }

  // WeChat mini game project (usually produced by Cocos)
  if (has(dir, 'project.config.json') && has(dir, 'game.json')) {
    out.push({
      id: rel === '.' ? 'wechat' : `wechat@${rel}`,
      dir: dirField,
      kind: 'wechat',
      title: `微信小游戏${label}`,
      detail: '构建目录 + 开发者工具',
      projectPath: '.',
      estimatedMs: 90000,
      reload: 'hard',
    })
  }

  // Godot / Unity: native window capture (v0.2)
  if (has(dir, 'project.godot')) {
    out.push({
      id: rel === '.' ? 'godot-native' : `godot-native@${rel}`,
      dir: dirField,
      kind: 'native',
      engine: 'godot',
      title: `Godot · 原生${label}`,
      detail: '运行主场景 + 窗口捕获',
      windowMatch: 'Godot|游戏|Game',
      estimatedMs: 6000,
      reload: 'manual',
    })
  }
  if (has(dir, 'Assets') && (has(dir, 'ProjectSettings') || has(dir, 'ProjectSettings/ProjectVersion.txt'))) {
    out.push({
      id: rel === '.' ? 'unity-native' : `unity-native@${rel}`,
      dir: dirField,
      kind: 'native',
      engine: 'unity',
      title: `Unity · 原生${label}`,
      detail: '打开编辑器 + 窗口捕获',
      windowMatch: 'Unity',
      estimatedMs: 8000,
      reload: 'manual',
    })
  }

  // Generic node dev server, including serve/preview style scripts
  const script = pickScript(pkg)
  if (script) {
    out.push({
      id: rel === '.' ? 'node-dev' : `node-dev@${rel}`,
      dir: dirField,
      kind: 'web',
      title: `Web · ${script.name}${label}`,
      detail: `npm run ${script.name}`,
      url: guessDevUrl(dir, pkg, script),
      cmd: `npm run ${script.name}`,
      estimatedMs: 5000,
      reload: 'hmr',
    })
  }

  // Static single page
  const html = has(dir, 'index.html') ? 'index.html' : listDir(dir).find((n) => n.toLowerCase().endsWith('.html') && !n.startsWith('.'))
  if (html) {
    out.push({
      id: rel === '.' ? 'static' : `static@${rel}`,
      dir: dirField,
      kind: 'web',
      title: `静态 HTML${label}`,
      detail: '本地文件',
      file: html,
      estimatedMs: 200,
      reload: 'manual',
    })
  }

  return out
}

/**
 * Scan the workspace root and its immediate subdirectories. Game projects are
 * routinely nested (a WeChat shell with the real Cocos project in `cocos/`), so
 * a root-only check reports "nothing detected" on perfectly good projects.
 */
function detect(root) {
  const configs = []
  const seen = new Set()
  const add = (cfg) => {
    const key = `${cfg.kind}:${cfg.dir ?? '.'}:${cfg.id}`
    if (seen.has(key)) return
    seen.add(key)
    configs.push(cfg)
  }

  const rootPkg = has(root, 'package.json') ? safeJson(join(root, 'package.json')) : null
  for (const cfg of configsAt(root, '.', rootPkg)) add(cfg)

  let subdirs = []
  try {
    subdirs = readdirSync(root).filter((name) => !name.startsWith('.') && !IGNORE.includes(name))
  } catch {
    subdirs = []
  }
  for (const name of subdirs) {
    const dir = join(root, name)
    let stat = null
    try {
      stat = statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const pkg = has(dir, 'package.json') ? safeJson(join(dir, 'package.json')) : null
    for (const cfg of configsAt(dir, name.split(sep).join('/'), pkg)) add(cfg)
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
  const proc = { child: null, config: null, startedAt: 0, logTail: [], exe: null }
  const state = { active: null, lastRoot: null, lastError: null }
  const capture = new WindowCapture({
    helperPath: join(HERE, 'host', 'window-capture.ps1'),
    logger: log,
  })

  /* -- which workspace is the panel looking at ------------------------- */

  function timestampOf(candidate) {
    const session = candidate?.session ?? candidate
    const raw = session?.header?.createdAt ?? session?.createdAt ?? candidate?.createdAt ?? 0
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }

  /** Working directory of a live Agent, whichever shape the services expose. */
  function dirOfAgent(candidate) {
    const wd = ctx.get('workingDirectory')
    for (const target of [candidate?.session, candidate]) {
      if (!target) continue
      try {
        const dir = wd?.get?.(target)
        if (typeof dir === 'string' && dir) return dir
      } catch {}
      try {
        const dir = target?.header?.cwd ?? target?.cwd
        if (typeof dir === 'string' && dir) return dir
      } catch {}
    }
    return null
  }

  function liveAgentDirs() {
    const agents = ctx.get('agents')
    let list = []
    try {
      list = agents?.roots?.() ?? agents?.list?.() ?? []
    } catch {}
    return list
      .map((agent) => ({ dir: dirOfAgent(agent), at: timestampOf(agent) }))
      .filter((row) => row.dir)
      .sort((a, b) => b.at - a.at)
  }

  /** Every workspace DSH has on record, independent of whether an agent is live. */
  function registryDirs() {
    const registry = ctx.get('workspaceRegistry')
    let list = []
    try {
      list = registry?.list?.() ?? []
    } catch {}
    const out = []
    for (const entry of list) {
      const dir = typeof entry === 'string' ? entry : (entry?.path ?? entry?.directory ?? entry?.root)
      if (typeof dir === 'string' && dir) out.push(dir)
    }
    return out
  }

  /**
   * The panel has no Session of its own, and the Host only learns a workspace
   * from a tool call. A live agent is the freshest signal, but an idle session
   * has none, so the registry is the durable fallback.
   */
  function discoverRoot(sessionId) {
    if (sessionId) {
      const agents = ctx.get('agents')
      let agent = null
      try {
        agent = agents?.get?.(sessionId)
      } catch {}
      const dir = agent ? dirOfAgent(agent) : null
      try {
        if (dir && existsSync(dir)) return resolve(dir)
      } catch {}
    }
    const hit = liveAgentDirs().find((row) => {
      try {
        return existsSync(row.dir)
      } catch {
        return false
      }
    })
    if (hit) return resolve(hit.dir)
    for (const dir of registryDirs()) {
      try {
        if (existsSync(dir)) return resolve(dir)
      } catch {}
    }
    try {
      const fallback = ctx.get('workingDirectory')?.defaultDirectory
      if (fallback && existsSync(fallback)) return resolve(fallback)
    } catch {}
    return null
  }

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
    const caps = capture.status()
    return {
      ok: true,
      app: APP_ID,
      version: VERSION,
      root: entry?.root ?? null,
      configs: entry?.configs ?? [],
      dirty: entry ? [...entry.dirty] : [],
      active: state.active,
      running: Boolean(proc.child),
      error: state.lastError ?? caps.error ?? null,
      ports: servedPorts,
      capture: {
        supported: caps.supported,
        running: caps.running,
        hwnd: caps.hwnd,
        width: caps.width,
        height: caps.height,
        fps: caps.fps,
        frames: caps.frames,
        bytes: caps.bytes,
        drops: caps.drops,
        black: caps.black,
        stale: caps.stale,
        lastFrameAt: caps.lastFrameAt,
        error: caps.error,
        errorCode: caps.errorCode,
      },
    }
  }

  /* -- process control -------------------------------------------------- */

  function killChild() {
    const child = proc.child
    proc.child = null
    proc.config = null
    proc.exe = null
    capture.stop()
    if (!child) return
    const pid = child.pid
    try {
      // a shell-spawned dev server owns its own children; killing the shell alone leaks them
      if (process.platform === 'win32' && pid) {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
      } else {
        child.kill()
      }
    } catch {}
  }

  function collectOutput(child) {
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
        if (code !== 0) state.lastError = `${proc.config?.title ?? 'dev server'} 退出（code ${code}）`
        capture.stop()
      }
    })
  }

  function spawnCommand(cmd, cwd, label) {
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, detached: false })
    proc.child = child
    proc.config = { title: label }
    proc.startedAt = Date.now()
    proc.logTail = []
    collectOutput(child)
    return child
  }

  /** Spawn an engine executable without a shell so `child.pid` owns the game window. */
  function spawnDirect(exe, args, cwd, label) {
    const child = spawn(exe, args, { cwd, shell: false, windowsHide: false, detached: false })
    proc.child = child
    proc.config = { title: label }
    proc.exe = exe
    proc.startedAt = Date.now()
    proc.logTail = []
    child.on('error', (error) => {
      state.lastError = `${label} 启动失败：${String(error?.message ?? error)}`
      capture.stop()
    })
    collectOutput(child)
    return child
  }

  /* -- window discovery ------------------------------------------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function waitForWindow({ pid, titlePattern, timeoutMs = 20000 }) {
    const started = Date.now()
    let lastError = null
    while (Date.now() - started < timeoutMs) {
      try {
        const windows = await capture.list()
        const byPid = pid ? windows.find((w) => w.pid === pid && w.width >= 200 && w.height >= 150) : null
        if (byPid) return byPid
        if (titlePattern) {
          let re
          try {
            re = new RegExp(titlePattern, 'i')
          } catch {
            re = null
          }
          const byTitle = windows.find(
            (w) => w.width >= 200 && w.height >= 150 && (re ? re.test(w.title) : w.title.includes(titlePattern)),
          )
          if (byTitle) return byTitle
        }
      } catch (error) {
        lastError = error
      }
      if (!proc.child) break // the engine died before showing a window
      await sleep(400)
    }
    if (lastError) log('window discovery failed:', String(lastError))
    return null
  }

  function captureOptions() {
    return {
      fps: Number(config.captureFps ?? 20),
      maxWidth: Number(config.captureWidth ?? 0),
      quality: Number(config.captureQuality ?? 70),
    }
  }

  function resolveConfig(root, configId) {
    const entry = ensureRoot(root)
    if (!entry.configs) entry.configs = detect(entry.root)
    return entry.configs.find((c) => c.id === configId) ?? entry.configs[0]
  }

  function rootsPayload() {
    const seenDirs = new Set()
    const candidates = [
      ...liveAgentDirs().map((row) => ({ dir: row.dir, live: true })),
      ...registryDirs().map((dir) => ({ dir, live: false })),
    ]
    const roots = candidates
      .filter((row) => {
        try {
          if (!existsSync(row.dir)) return false
        } catch {
          return false
        }
        const dir = resolve(row.dir)
        if (seenDirs.has(dir)) return false
        seenDirs.add(dir)
        return true
      })
      .map((row) => ({ dir: resolve(row.dir), at: 0, live: row.live }))
    return { ok: true, roots, current: state.lastRoot ?? discoverRoot() ?? null }
  }

  async function attachWindow(body) {
    let win = null
    if (body?.hwnd) {
      const windows = await capture.list()
      win = windows.find((w) => String(w.hwnd) === String(body.hwnd)) ?? null
    } else if (body?.title) {
      const windows = await capture.list()
      win = windows.find((w) => w.title.includes(body.title)) ?? null
    }
    if (!win) throw new Error('没有选中窗口：先枚举窗口，再传 hwnd 或标题片段')
    const options = { ...captureOptions(), ...(body.options ?? {}) }
    const started = await capture.start(win.hwnd, options)
    state.active = {
      id: body.configId ?? 'window',
      title: win.title || '窗口捕获',
      kind: 'window',
      hwnd: win.hwnd,
      windowTitle: win.title,
      width: win.width,
      height: win.height,
      url: `${originOf()}/stream?hwnd=${win.hwnd}&t=${Date.now()}`,
      startedAt: Date.now(),
    }
    return { ...snapshot(state.lastRoot ?? undefined), capture: started }
  }

  /* -- HTTP control API ------------------------------------------------- */

  const servedPorts = []
  const staticRoots = new Set() // absolute directories the static route may serve
  const requestLog = [] // last few control-API calls, for "the panel is blank" reports
  let server = null

  function allowedOrigins() {
    const list = new Set()
    try {
      const ws = ctx.get('webServer')
      const self = ws?.getOrigin?.()
      if (self) list.add(self)
    } catch {}
    for (const origin of config.allowedOrigins ?? []) {
      if (typeof origin === 'string' && origin) list.add(origin)
    }
    return list
  }

  function originAllowed(origin) {
    if (!origin) return true // same-origin / non-browser callers (curl, the agent)
    if (allowedOrigins().has(origin)) return true
    // the panel itself is served from the DSH web origin, which is always loopback
    return LOOPBACK_ORIGIN.test(origin)
  }

  function corsHeaders(request) {
    const origin = request.headers.origin
    const allow = origin && originAllowed(origin) ? origin : 'null'
    return {
      'access-control-allow-origin': allow,
      'access-control-allow-headers': 'content-type, x-game-preview',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      vary: 'origin',
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

  function originOf() {
    return `http://127.0.0.1:${servedPorts[0] ?? BASE_PORT}`
  }

  function streamFrames(req, res, headers) {
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
      'cache-control': 'no-store, no-transform',
      'access-control-allow-origin': headers['access-control-allow-origin'],
      vary: 'origin',
    })
    let closed = false
    const writeFrame = (frame) => {
      if (closed || res.writableEnded) return
      try {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\n\r\n`)
        res.write(frame.jpeg)
        res.write('\r\n')
      } catch {
        closed = true
      }
    }
    const last = capture.last()
    if (last && Date.now() - last.at < 2000) writeFrame(last)
    const unsubscribe = capture.onFrame(writeFrame)
    // an idle stream still needs traffic, or the browser drops it after a few seconds
    const keepalive = setInterval(() => {
      if (closed || res.writableEnded) return
      try {
        res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 0\r\n\r\n\r\n')
      } catch {
        closed = true
      }
    }, 5000)
    keepalive.unref?.()
    const done = () => {
      closed = true
      clearInterval(keepalive)
      unsubscribe()
    }
    req.on('close', done)
    req.on('error', done)
    res.on('close', done)
  }

  async function handle(req, res) {
    const headers = corsHeaders(req)
    const origin = req.headers.origin
    if (!originAllowed(origin)) {
      send(res, headers, { ok: false, error: 'origin not allowed' }, 403)
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (path !== '/api/debug') {
      requestLog.push({
        at: Date.now(),
        path,
        query: url.search || '',
        origin: req.headers.origin ?? '',
        ua: String(req.headers['user-agent'] ?? '').slice(-60),
      })
      if (requestLog.length > 40) requestLog.shift()
    }

    if (path === '/api/hello') {
      send(res, headers, {
        ok: true,
        app: APP_ID,
        version: VERSION,
        ports: servedPorts,
        tools: tools.length,
        capture: capture.status().supported,
      })
      return
    }

    if (path === '/api/state') {
      const requested = url.searchParams.get('root') ?? undefined
      const sessionId = url.searchParams.get('session') ?? undefined
      let explicit = requested
      try {
        if (explicit && !existsSync(explicit)) explicit = undefined
      } catch {
        explicit = undefined
      }
      const root = explicit ?? state.lastRoot ?? discoverRoot(sessionId) ?? undefined
      send(res, headers, snapshot(root ?? undefined))
      return
    }

    if (path === '/api/detect') {
      const body = await readBody(req)
      const target = body?.root ?? state.lastRoot ?? discoverRoot(body?.session)
      if (!target) {
        send(res, headers, { ok: false, error: '需要一个项目目录：把路径填进面板，或在对话里说一次工作区' }, 400)
        return
      }
      if (!existsSync(target)) {
        send(res, headers, { ok: false, error: `目录不存在：${target}` }, 404)
        return
      }
      const entry = ensureRoot(target)
      entry.configs = detect(entry.root)
      state.lastRoot = entry.root
      send(res, headers, snapshot(entry.root))
      return
    }

    if (path === '/api/run' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const result = await runPreview(body.root ?? state.lastRoot, body.configId, body.url, body.waitMs, body.window)
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

    /* -- native window capture ---------------------------------------- */

    // read-only introspection: which services this plugin can actually reach
    if (path === '/api/debug') {
      let routeSelfTest = null
      try {
        const conn = ctx.get('connection')
        const handler = typeof conn?.createSharedFetchHandler === 'function' ? conn.createSharedFetchHandler('/api') : null
        const stubPeer = new Proxy({}, { get: () => ({ kind: 'self-test', id: 'self-test' }) })
        const tryPath = async (target) => {
          try {
            const response = await handler.fetch(new Request(`http://127.0.0.1${target}`), stubPeer)
            return `${target} → ${response.status} ${String(await response.text()).slice(0, 80)}`
          } catch (error) {
            return `${target} → ERR ${String(error?.message ?? error).slice(0, 80)}`
          }
        }
        routeSelfTest = handler
          ? {
              hasHandler: true,
              attempts: [
                await tryPath('/api/game-preview/hello'),
                await tryPath('/game-preview/hello'),
                await tryPath('/api/game-preview/state'),
              ],
            }
          : { hasHandler: false }
      } catch (error) {
        routeSelfTest = { error: String(error?.message ?? error) }
      }
      const probe = {}
      for (const name of ['workingDirectory', 'agents', 'workspaceRegistry', 'webServer', 'sessions']) {
        let service = null
        try {
          service = ctx.get(name) ?? null
        } catch {}
        const info = { present: Boolean(service), type: typeof service }
        if (service) {
          try {
            info.keys = Object.keys(service).slice(0, 12)
          } catch {}
          try {
            if (typeof service.list === 'function') {
              const rows = service.list()
              info.listLength = Array.isArray(rows) ? rows.length : null
              const first = Array.isArray(rows) ? rows[0] : null
              info.firstKeys = first && typeof first === 'object' ? Object.keys(first).slice(0, 12) : null
              info.firstPath =
                first && typeof first === 'object'
                  ? (first.path ?? first.record?.path ?? first.directory ?? null)
                  : null
            }
          } catch (error) {
            info.listError = String(error?.message ?? error)
          }
        }
        probe[name] = info
      }
      send(res, headers, {
        ok: true,
        probe,
        liveAgentDirs: liveAgentDirs().map((r) => r.dir),
        registryDirs: registryDirs(),
        fetchRoutes: fetchRoutes.length,
        fetchRoutePaths: [...routePaths],
        sameOrigin: Boolean(ctx.get('connection')?.fetch?.register),
        routeSelfTest,
        lastRequests: requestLog.slice(-15),
      })
      return
    }

    if (path === '/api/roots') {
      send(res, headers, rootsPayload())
      return
    }

    if (path === '/api/window/list') {
      try {
        const windows = await capture.list()
        send(res, headers, { ok: true, windows, capture: capture.status() })
      } catch (error) {
        send(res, headers, { ok: false, error: String(error?.message ?? error) }, 500)
      }
      return
    }

    if (path === '/api/window/attach' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        send(res, headers, await attachWindow(body))
      } catch (error) {
        send(res, headers, { ok: false, error: String(error?.message ?? error) }, 500)
      }
      return
    }

    if (path === '/api/window/stop' && req.method === 'POST') {
      capture.stop()
      if (state.active?.kind === 'window') state.active = null
      send(res, headers, snapshot(state.lastRoot ?? undefined))
      return
    }

    // single latest frame, for clients that would rather poll than hold a stream
    if (path === '/api/frame') {
      const frame = capture.last()
      if (!frame || Date.now() - frame.at > 5000) {
        res.writeHead(204, { ...headers, 'cache-control': 'no-store' })
        res.end()
        return
      }
      res.writeHead(200, {
        ...headers,
        'content-type': 'image/jpeg',
        'content-length': String(frame.jpeg.length),
        'cache-control': 'no-store',
        'x-frame-seq': String(frame.seq),
      })
      res.end(frame.jpeg)
      return
    }

    // multipart JPEG stream — an <img src> can consume this directly
    if (path === '/stream') {
      streamFrames(req, res, headers)
      return
    }

    // static directory serving: relative URLs inside the game keep working
    if (path.startsWith('/static/')) {
      const rest = path.slice('/static/'.length)
      const slash = rest.indexOf('/')
      const token = slash === -1 ? rest : rest.slice(0, slash)
      let dir = ''
      try {
        dir = resolve(Buffer.from(token, 'base64url').toString('utf8'))
      } catch {
        send(res, headers, { ok: false, error: 'bad root token' }, 400)
        return
      }
      if (!staticRoots.has(dir)) {
        send(res, headers, { ok: false, error: 'root not registered' }, 403)
        return
      }
      let rel = ''
      try {
        rel = decodeURIComponent(slash === -1 ? '' : rest.slice(slash + 1))
      } catch {
        send(res, headers, { ok: false, error: 'bad path' }, 400)
        return
      }
      const target = resolve(dir, rel || 'index.html')
      if (target !== dir && !target.startsWith(dir + sep)) {
        send(res, headers, { ok: false, error: 'containment' }, 403)
        return
      }
      try {
        const data = readFileSync(target)
        res.writeHead(200, { ...headers, 'content-type': mimeOf(target) })
        res.end(data)
      } catch {
        send(res, headers, { ok: false, error: 'not found' }, 404)
      }
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
      try {
        const data = readFileSync(target)
        res.writeHead(200, { ...headers, 'content-type': mimeOf(target) })
        res.end(data)
      } catch {
        send(res, headers, { ok: false, error: 'not found' }, 404)
      }
      return
    }

    send(res, headers, { ok: false, error: 'not found' }, 404)
  }

  async function runPreview(rootArg, configId, overrideUrl, waitMs, windowRef) {
    const root = rootArg ?? state.lastRoot
    if (!root) throw new Error('还没有工作区：先在对话里让我跑一次预览，或在面板里填入项目路径')
    const cfg = resolveConfig(root, configId)
    if (!cfg) throw new Error('这个项目没有可运行的配置')
    state.lastRoot = resolve(root)
    state.lastError = null
    const entry = ensureRoot(state.lastRoot)
    entry.dirty.clear()
    // a nested project (root/cocos, root/game) runs from its own directory
    const workdir = resolve(state.lastRoot, cfg.dir ?? '.')

    if (overrideUrl) cfg.url = overrideUrl

    if (cfg.kind === 'manual') {
      if (!overrideUrl) throw new Error('手动模式需要在面板里填一个 URL')
      state.active = { id: cfg.id, title: cfg.title, kind: cfg.kind, url: overrideUrl, startedAt: Date.now() }
      return { ...snapshot(state.lastRoot), waitedMs: 0 }
    }

    if (windowRef && cfg.kind !== 'native') {
      const windows = await capture.list()
      const win =
        windows.find((w) => String(w.hwnd) === String(windowRef)) ??
        windows.find((w) => w.title.toLowerCase().includes(String(windowRef).toLowerCase()))
      if (!win) throw new Error(`没找到匹配「${windowRef}」的窗口：先跑一次 game_preview_windows 看看有哪些`)
      await capture.start(win.hwnd, captureOptions())
      state.active = {
        id: cfg.id, title: win.title || cfg.title, kind: 'window',
        hwnd: win.hwnd, windowTitle: win.title, width: win.width, height: win.height,
        url: `${originOf()}/stream?hwnd=${win.hwnd}&t=${Date.now()}`, startedAt: Date.now(),
      }
      return { ...snapshot(state.lastRoot), waitedMs: 0 }
    }

    if (cfg.kind === 'native') {
      if (!WindowCapture.supported) throw new Error('窗口捕获只支持 Windows（Win10 1903 及以上）')
      const launch = nativeLaunch(cfg, config, workdir)
      if (launch.error) throw new Error(launch.error)
      const startedAt = Date.now()
      const child = spawnDirect(launch.exe, launch.args, workdir, cfg.title)
      const win = await waitForWindow({
        pid: child.pid,
        titlePattern: cfg.windowMatch,
        timeoutMs: Number(config.captureWaitMs ?? 30000),
      })
      if (!win) {
        throw new Error(
          `没找到游戏窗口（${Math.round((Date.now() - startedAt) / 1000)}s）：确认 ${cfg.title} 已经启动；` +
            'Unity 还要在编辑器里按一次 Play，或者用面板上的「选择窗口」手动挑一个',
        )
      }
      await capture.start(win.hwnd, captureOptions())
      state.active = {
        id: cfg.id,
        title: cfg.title,
        kind: 'window',
        hwnd: win.hwnd,
        windowTitle: win.title,
        width: win.width,
        height: win.height,
        url: `${originOf()}/stream?hwnd=${win.hwnd}&t=${Date.now()}`,
        startedAt: Date.now(),
      }
      return { ...snapshot(state.lastRoot), waitedMs: Date.now() - startedAt }
    }

    if (cfg.kind === 'wechat') {
      const cli = findWechatCli(config)
      if (!cli) throw new Error('没找到微信开发者工具 cli.bat：请在插件配置 wechatCli 里填写绝对路径')
      const projectPath = resolve(workdir, cfg.projectPath ?? '.')
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
    // Cocos: the editor owns the preview server, so start it when a path is configured
    if (String(cfg.id).startsWith('cocos-web') && config.cocosEditor && existsSync(config.cocosEditor)) {
      spawnDirect(config.cocosEditor, ['--project', workdir], workdir, cfg.title)
    }
    if (cfg.cmd && !proc.child) spawnCommand(cfg.cmd, workdir, cfg.title)
    if (cfg.file) {
      // root the static server at the workspace, not the subdirectory: an ES
      // module may import '../src/x.js' from inside web/
      const serveRoot = state.lastRoot
      staticRoots.add(serveRoot)
      const entryPath = (cfg.dir ? `${cfg.dir}/` : '') + cfg.file
      const entryAbs = resolve(workdir, cfg.file)
      let moduleEntry = false
      try {
        moduleEntry = /<script[^>]+type\s*=\s*["']module/i.test(readFileSync(entryAbs, 'utf8').slice(0, 20000))
      } catch {}
      state.active = {
        id: cfg.id, title: cfg.title, kind: 'file',
        url: `${originOf()}/static/${staticToken(serveRoot)}/${entryPath.split('/').map(encodeURIComponent).join('/')}`,
        // same-origin bundle: the panel can play this from a blob URL even when
        // the desktop page cannot reach the loopback server at all. ES modules
        // with relative imports cannot survive inlining, so those keep the
        // served URL only.
        ...(moduleEntry
          ? {}
          : { bundlePath: `${API_PREFIX}/bundle?root=${encodeURIComponent(workdir)}&file=${encodeURIComponent(cfg.file)}` }),
        startedAt: Date.now(),
      }
      return { ...snapshot(state.lastRoot), waitedMs: 0 }
    }
    const ok = await waitFor(cfg.url, waitMs ?? config.waitForMs ?? 60000)
    state.active = {
      id: cfg.id, title: cfg.title, kind: 'web', url: cfg.url,
      startedAt: Date.now(), ready: ok,
    }
    if (!ok) {
      const seconds = Math.round((Date.now() - started) / 1000)
      state.lastError = String(cfg.id).startsWith('cocos-web')
        ? `Cocos 预览服务 ${cfg.url} 没起来（${seconds}s）。在 Cocos Creator 里点一次「浏览器预览」，或把编辑器路径填进 config.cocosEditor，下次我帮你启动。`
        : `等 ${cfg.url} 超时（${seconds}s）：${cfg.cmd ? '看面板下方日志里 dev server 的报错' : '确认服务已启动'}` 
    }
    return { ...snapshot(state.lastRoot), ok, waitedMs: Date.now() - started, ready: ok }
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
  cleanup.push(() => capture.dispose())
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
      config: { type: 'string', description: 'Config id from game_preview_status, e.g. cocos-web, godot-native, unity-native. Omit to use the detected default.' },
      url: { type: 'string', description: 'Override the preview URL (manual mode).' },
      window: { type: 'string', description: 'Attach window capture to this HWND or window-title fragment instead of launching anything. Use after game_preview_windows.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = await currentRoot(exec)
      try {
        const result = await runPreview(root, args?.config, args?.url, undefined, args?.window)
        return JSON.stringify({
          ok: result.ok !== false,
          root: result.root,
          active: result.active,
          waitedMs: result.waitedMs,
          error: result.error ?? null,
          dirty: result.dirty?.length ?? 0,
          capture: result.capture ?? null,
        })
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  registerTool({
    name: 'game_preview_windows',
    description:
      'List the capturable top-level windows on this Windows machine (hwnd, pid, size, title). Use it to find the HWND of a running game or editor window, then pass it to game_preview_run via the window parameter.',
    parameters: {
      filter: { type: 'string', description: 'Optional case-insensitive substring matched against the window title.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const windows = await capture.list()
        const filter = String(args?.filter ?? '').toLowerCase()
        const rows = windows
          .filter((w) => !filter || w.title.toLowerCase().includes(filter))
          .map((w) => ({ hwnd: w.hwnd, pid: w.pid, width: w.width, height: w.height, title: w.title }))
        return JSON.stringify({ ok: true, supported: WindowCapture.supported, total: windows.length, windows: rows.slice(0, 40) })
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
        const dir = dirOfAgent(agent)
        if (dir) {
          state.lastRoot = resolve(dir)
          return state.lastRoot
        }
      }
    } catch {}
    return state.lastRoot ?? discoverRoot() ?? process.cwd()
  }

  ctx.effect(() => () => {
    for (const dispose of tools.splice(0)) {
      try { dispose?.() } catch {}
    }
  }, 'game-preview tools')

  /* -- same-origin routes for the panel --------------------------------
   * The desktop app loads its page from file:// and carries fetch over an
   * IPC bridge, so an absolute http://127.0.0.1:7317 call never reaches the
   * loopback server there. Every panel request therefore also exists as a
   * same-origin /api/game-preview/* route registered on the connection.
   */

  const fetchRoutes = []
  const routePaths = new Set()
  function sameOriginRoutes() {
    const connection = ctx.get('connection')
    const register = connection?.fetch?.register
    if (typeof register !== 'function') return

    const add = (path, methods, fetch, requestBody) => {
      try {
        const route = { path, methods, requestBody: requestBody ?? 'buffered', fetch }
        fetchRoutes.push(register.call(connection.fetch, route))
        routePaths.add(path)
      } catch (error) {
        log('fetch route failed', path, String(error))
      }
    }

    const urlOf = (request, fallback) => {
      try {
        const raw = String(request?.url ?? '')
        return new URL(raw, fallback).searchParams
      } catch {
        return new URLSearchParams()
      }
    }

    add(`${API_PREFIX}/hello`, ['GET'], () =>
      jsonResponse({ ok: true, app: APP_ID, version: VERSION, tools: tools.length, capture: WindowCapture.supported }),
    )

    add(`${API_PREFIX}/state`, ['GET'], (request) => {
      const params = urlOf(request, originOf())
      const requested = params.get('root') ?? undefined
      let explicit = requested
      try {
        if (explicit && !existsSync(explicit)) explicit = undefined
      } catch {
        explicit = undefined
      }
      const root = explicit ?? state.lastRoot ?? discoverRoot(params.get('session') ?? undefined) ?? undefined
      return jsonResponse(snapshot(root ?? undefined))
    })

    add(`${API_PREFIX}/roots`, ['GET'], () => jsonResponse(rootsPayload()))

    add(`${API_PREFIX}/detect`, ['POST'], async (request) => {
      let body = {}
      try {
        body = await request.json()
      } catch {}
      const target = body?.root ?? state.lastRoot ?? discoverRoot(body?.session)
      if (!target) return jsonResponse({ ok: false, error: '需要一个项目目录' }, 400)
      if (!existsSync(target)) return jsonResponse({ ok: false, error: `目录不存在：${target}` }, 404)
      const entry = ensureRoot(target)
      entry.configs = detect(entry.root)
      state.lastRoot = entry.root
      return jsonResponse(snapshot(entry.root))
    }, 'buffered')

    add(`${API_PREFIX}/run`, ['POST'], async (request) => {
      let body = {}
      try {
        body = await request.json()
      } catch {}
      try {
        return jsonResponse(await runPreview(body.root ?? state.lastRoot, body.configId, body.url, body.waitMs, body.window))
      } catch (error) {
        state.lastError = String(error?.message ?? error)
        return jsonResponse({ ok: false, error: state.lastError }, 500)
      }
    }, 'buffered')

    add(`${API_PREFIX}/stop`, ['POST'], () => {
      killChild()
      state.active = null
      return jsonResponse(snapshot(state.lastRoot ?? undefined))
    })

    add(`${API_PREFIX}/window/list`, ['GET'], async () => {
      try {
        return jsonResponse({ ok: true, windows: await capture.list(), capture: capture.status() })
      } catch (error) {
        return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    })

    add(`${API_PREFIX}/window/stop`, ['POST'], () => {
      capture.stop()
      if (state.active?.kind === 'window') state.active = null
      return jsonResponse(snapshot(state.lastRoot ?? undefined))
    })

    add(`${API_PREFIX}/window/attach`, ['POST'], async (request) => {
      let body = {}
      try {
        body = await request.json()
      } catch {}
      try {
        const attach = await attachWindow(body)
        return jsonResponse(attach)
      } catch (error) {
        return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    }, 'buffered')

    add(`${API_PREFIX}/frame`, ['GET'], () => {
      const frame = capture.last()
      if (!frame || Date.now() - frame.at > 5000) return new Response(null, { status: 204 })
      return new Response(frame.jpeg, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-frame-seq': String(frame.seq) },
      })
    })

    add(`${API_PREFIX}/bundle`, ['GET'], (request) => {
      const params = urlOf(request, originOf())
      const dir = resolve(params.get('root') ?? '')
      const file = params.get('file') ?? 'index.html'
      if (!staticRoots.has(dir)) return jsonResponse({ ok: false, error: 'root not registered' }, 403)
      try {
        const bundle = bundleHtml(dir, file)
        return new Response(bundle.html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        })
      } catch (error) {
        return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    })

    add(`${API_PREFIX}/log`, ['GET'], () =>
      jsonResponse({ ok: true, lines: proc.logTail, active: state.active, running: Boolean(proc.child) }),
    )
  }

  ctx.effect(() => {
    sameOriginRoutes()
    return () => {
      for (const dispose of fetchRoutes.splice(0)) {
        try { dispose?.() } catch {}
      }
    }
  }, 'game-preview fetch routes')

  log('ready')
}
