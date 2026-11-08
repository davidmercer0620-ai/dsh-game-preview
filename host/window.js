/**
 * dsh-game-preview — window capture bridge (Host side).
 *
 * Owns the persistent PowerShell helper (`host/window-capture.ps1`), turns its
 * line protocol into promises and a frame stream, and keeps the last frame plus
 * health metrics for the control API and `/stream`.
 *
 * Zero dependencies: node: builtins only.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const SUPPORTED = process.platform === 'win32'

const PING_TIMEOUT_MS = 8000
const LIST_TIMEOUT_MS = 4000

// Desktop shells, overlays and IME ghosts are never the game; capturing them
// only produces a black stage and a confused user.
const JUNK_TITLE = [
  /^Program Manager$/i,
  /NVIDIA GeForce Overlay/i,
  /Microsoft Text Input Application/i,
  /^Default IME$/i,
  /^MSCTFIME/i,
  /^DesktopWindowXamlSource$/i,
  /^$ /,
]

function isJunkWindow(window) {
  if (!window?.title) return true
  return JUNK_TITLE.some((re) => re.test(window.title))
}

function powershellPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
}

export class WindowCapture {
  #helperPath
  #log
  #child = null
  #rl = null
  #spawnAt = 0
  #pendingList = null
  #pendingPong = null
  #pendingStart = null
  #frames = []          // arrival timestamps for an fps window
  #last = null          // { jpeg, seq, w, h, at, captureMs, encodeMs }
  #subscribers = new Set()
  #state = { running: false, hwnd: null, width: 0, height: 0, startedAt: 0, error: null, drops: 0, black: 0, frames: 0, bytes: 0 }
  #restart = { allowed: true, hwnd: null, options: null }

  constructor({ helperPath, logger } = {}) {
    this.#helperPath = helperPath
    this.#log = logger ?? (() => {})
  }

  static get supported() {
    return SUPPORTED
  }

  /* ------------------------------------------------------------- process */

  async #ensure() {
    if (this.#child && !this.#child.killed) return
    if (!SUPPORTED) throw new Error('窗口捕获只支持 Windows（Win10 1903+）')
    if (!this.#helperPath || !existsSync(this.#helperPath)) throw new Error(`找不到抓帧助手：${this.#helperPath}`)

    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.#helperPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.#child = child
    this.#spawnAt = Date.now()

    child.stderr?.on('data', (buf) => {
      const text = String(buf).trim()
      if (text) this.#log('[capture] ' + text.slice(0, 400))
    })
    child.on('exit', (code) => this.#onExit(code))
    child.on('error', (error) => {
      this.#state.error = String(error?.message ?? error)
    })

    this.#rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.#rl.on('line', (line) => this.#onLine(line))

    await this.#ping()
  }

  async #ping() {
    const child = this.#child
    if (!child) throw new Error('抓帧助手没有启动')
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingPong = null
        reject(new Error('抓帧助手没有响应（PowerShell 启动超时）'))
      }, PING_TIMEOUT_MS)
      this.#pendingPong = () => {
        clearTimeout(timer)
        resolve()
      }
      child.stdin.write('PING\n')
    })
  }

  #onExit(code) {
    const child = this.#child
    this.#child = null
    this.#rl?.close()
    this.#rl = null
    if (this.#pendingList) {
      this.#pendingList.reject(new Error('抓帧助手已退出'))
      this.#pendingList = null
    }
    this.#pendingPong = null
    const wasRunning = this.#state.running
    this.#state.running = false
    if (!wasRunning) return

    // PR3: one silent restart, then surface the failure. A helper that dies right
    // after starting is a real problem, not a hiccup — don't loop on it.
    const crashedYoung = Date.now() - (this.#state.startedAt || 0) < 3000
    if (this.#restart.allowed && this.#restart.hwnd && !crashedYoung) {
      this.#restart.allowed = false
      this.#log(`[capture] helper exited (${code}) with an active session; restarting once`)
      const { hwnd, options } = this.#restart
      this.#state.error = '抓帧助手崩溃，正在重启'
      setTimeout(() => {
        this.start(hwnd, options).catch((error) => {
          this.#state.error = `抓帧助手崩溃：${String(error?.message ?? error)}`
        })
      }, 250)
      return
    }
    this.#state.error = this.#state.error ?? `抓帧助手退出（code ${code}）`
  }

  #onLine(raw) {
    const line = raw.trim()
    if (!line) return
    const space = line.indexOf(' ')
    const cmd = space === -1 ? line : line.slice(0, space)
    const rest = space === -1 ? '' : line.slice(space + 1)

    switch (cmd) {
      case 'PONG': {
        const done = this.#pendingPong
        this.#pendingPong = null
        done?.()
        break
      }
      case 'WIN': {
        if (!this.#pendingList) break
        const [hwnd, pid, w, h, b64] = rest.split(' ')
        let title = ''
        try {
          title = Buffer.from(b64 ?? '', 'base64').toString('utf8')
        } catch {
          title = ''
        }
        const row = { hwnd: Number(hwnd), pid: Number(pid), width: Number(w), height: Number(h), title }
        if (!isJunkWindow(row)) this.#pendingList.rows.push(row)
        break
      }
      case 'END': {
        const pending = this.#pendingList
        this.#pendingList = null
        pending?.resolve(pending.rows)
        break
      }
      case 'STARTED': {
        const [w, h] = rest.split(' ').map(Number)
        this.#state.width = w || 0
        this.#state.height = h || 0
        this.#state.running = true
        this.#state.starting = false
        const pending = this.#pendingStart
        this.#pendingStart = null
        pending?.resolve()
        break
      }
      case 'DATA': {
        // a frame still in flight when the user hit stop must not repaint the stage
        if (!this.#state.running) break
        // DATA <seq> <w> <h> <captureMs> <encodeMs> <black> <base64>
        const parts = rest.split(' ')
        const [seq, w, h, captureMs, encodeMs, black, b64] = parts
        if (!b64) break
        let jpeg
        try {
          jpeg = Buffer.from(b64, 'base64')
        } catch {
          break
        }
        const at = Date.now()
        this.#last = {
          jpeg, seq: Number(seq), width: Number(w), height: Number(h), at,
          captureMs: Number(captureMs), encodeMs: Number(encodeMs),
        }
        this.#state.frames += 1
        this.#state.bytes += jpeg.length
        this.#state.width = Number(w)
        this.#state.height = Number(h)
        this.#state.lastFrameAt = at
        if (black === '1') this.#state.black += 1
        this.#frames.push(at)
        if (this.#frames.length > 60) this.#frames.shift()
        for (const fn of this.#subscribers) {
          try {
            fn(this.#last)
          } catch {
            /* a broken subscriber must not stall the stream */
          }
        }
        break
      }
      case 'STAT': {
        const [frames, drops] = rest.split(' ')
        this.#state.drops = Number(drops) || 0
        break
      }
      case 'ERR': {
        const [code, ...message] = rest.split(' ')
        this.#state.error = describeError(code, message.join(' '))
        this.#state.errorCode = code
        const pending = this.#pendingStart
        this.#pendingStart = null
        if (pending) {
          pending.reject(new Error(this.#state.error))
          this.#state.running = false
          this.#state.starting = false
          this.#restart.hwnd = null
        }
        if (code === 'window-closed') {
          this.#state.running = false
          this.#restart.hwnd = null
        }
        break
      }
      case 'STOPPED': {
        // the helper emits STOPPED for the session it just tore down; while a new
        // start is still being acknowledged that event belongs to the old one
        if (this.#pendingStart || this.#state.starting) break
        this.#state.running = false
        break
      }
      default:
        break
    }
  }

  /* ---------------------------------------------------------------- api */

  async list() {
    await this.#ensure()
    if (!this.#child) throw new Error('抓帧助手没有启动')
    if (this.#pendingList) throw new Error('上一次窗口枚举还没结束')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingList = null
        reject(new Error('枚举窗口超时'))
      }, LIST_TIMEOUT_MS)
      this.#pendingList = {
        rows: [],
        resolve: (rows) => { clearTimeout(timer); resolve(rows) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      }
      this.#child.stdin.write('LIST\n')
    })
  }

  async start(hwnd, options = {}) {
    await this.#ensure()
    if (!this.#child) throw new Error('抓帧助手没有启动')
    const fps = clamp(options.fps ?? 20, 1, 60)
    const maxWidth = clamp(options.maxWidth ?? 0, 0, 4096)
    const quality = clamp(options.quality ?? 70, 10, 95)

    this.#state = {
      ...this.#state,
      running: false, starting: true, hwnd: Number(hwnd), startedAt: Date.now(), error: null, errorCode: null,
      drops: 0, black: 0, frames: 0, bytes: 0,
    }
    this.#frames = []
    this.#last = null
    this.#restart = { allowed: true, hwnd: Number(hwnd), options: { ...options, fps, maxWidth, quality } }

    const confirmed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingStart = null
        reject(new Error('抓帧助手没有确认启动（窗口可能不可见）'))
      }, 3000)
      this.#pendingStart = {
        resolve: () => { clearTimeout(timer); resolve() },
        reject: (error) => { clearTimeout(timer); reject(error) },
      }
    })
    this.#child.stdin.write(`START ${hwnd} ${fps} ${maxWidth} ${quality}\n`)
    try {
      await confirmed
    } catch (error) {
      this.#state.starting = false
      throw error
    }
    return this.status()
  }

  stop() {
    try {
      this.#child?.stdin.write('STOP\n')
    } catch {}
    this.#state.running = false
    this.#state.error = null
    this.#state.errorCode = null
    this.#state.hwnd = null
    this.#restart.hwnd = null
    this.#frames = []
    this.#last = null // a stopped preview must not keep serving a stale picture
    return this.status()
  }

  onFrame(fn) {
    this.#subscribers.add(fn)
    return () => this.#subscribers.delete(fn)
  }

  last() {
    return this.#last
  }

  status() {
    const now = Date.now()
    const recent = this.#frames.filter((t) => now - t < 2000)
    const fps = recent.length > 1 ? (recent.length - 1) / ((recent[recent.length - 1] - recent[0]) / 1000) : recent.length ? 1 : 0
    const stale = Boolean(this.#state.running && this.#last && now - this.#last.at > 3000)
    return {
      supported: SUPPORTED,
      running: Boolean(this.#state.running),
      hwnd: this.#state.hwnd,
      width: this.#state.width,
      height: this.#state.height,
      fps: Math.round(fps * 10) / 10,
      frames: this.#state.frames,
      drops: this.#state.drops,
      black: this.#state.black,
      bytes: this.#state.bytes,
      lastFrameAt: this.#last?.at ?? null,
      stale,
      error: this.#state.error ?? (stale ? '画面已断流超过 3 秒' : null),
      errorCode: this.#state.errorCode ?? null,
      startedAt: this.#state.startedAt || null,
    }
  }

  dispose() {
    this.#subscribers.clear()
    try {
      this.#child?.stdin.write('QUIT\n')
    } catch {}
    const child = this.#child
    this.#child = null
    this.#rl?.close()
    this.#rl = null
    if (child) {
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
      }, 1500)
      timer.unref?.()
    }
    this.#restart.hwnd = null
    this.#state.running = false
  }
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function describeError(code, message) {
  switch (code) {
    case 'window-closed':
      return '游戏窗口已关闭'
    case 'minimized':
      return '窗口最小化时无法捕获，请还原窗口'
    case 'no-size':
      return '窗口尺寸为 0，无法捕获'
    case 'printwindow-failed':
      return '这个窗口抓不到画面（常见于独占全屏），请换成无边框窗口'
    case 'bad-args':
      return `抓帧助手参数错误：${message}`
    default:
      return message ? `${code}: ${message}` : String(code)
  }
}
