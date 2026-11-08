/**
 * dsh-game-preview — Client half.
 *
 * A right-sidebar tab: run configurations on top, the game stage in the middle,
 * and a playtest bar at the bottom. Talks to the Host half over its loopback
 * control API (discovered by probing a small port range).
 *
 * The stage renders either an <iframe> (web preview) or an <img> fed by the
 * Host's multipart /stream (native window capture, v0.2).
 */
window.__ModuleLoader__.load({
  id: 'dsh-game-preview',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const KIND = 'game-preview'
    const ID = 'dsh-game-preview'
    const APP = 'dsh-game-preview'
    // Same-origin first: the desktop app loads its page from file:// and carries
    // fetch over an IPC bridge, so an absolute loopback URL never arrives there.
    const API = '/api/game-preview'
    const PORTS = Array.from({ length: 16 }, (_, i) => 7317 + i)
    const WIDTH_KEY = 'dsh-game-preview.viewport'
    // PC and phone previews differ in both size and aspect, so they get their
    // own stage boxes instead of a single width number.
    const QUALITY = {
      sharp: { label: '🎯 清晰', fps: 20, maxWidth: 0, quality: 72 },
      smooth: { label: '⚡ 流畅', fps: 30, maxWidth: 1100, quality: 62 },
    }

    const VIEWPORTS = {
      auto: { label: '自适应' },
      pc: { label: 'PC', width: 1280, height: 720, ratio: '16 / 9' },
      mobile: { label: '手机', width: 390, height: 844, ratio: '390 / 844' },
    }
    const ROOT_KEY = 'dsh-game-preview.root'

    function readStoredRoot() {
      try {
        return String(window.localStorage.getItem(ROOT_KEY) ?? '')
      } catch {
        return ''
      }
    }

    let endpoint = null
    let health = { port: null, version: null, error: null, mode: null }

    // The panel has no Session of its own; if the page URL carries one, hand it
    // to the Host so it can resolve this session's working directory.
    const SESSION_ID = (() => {
      try {
        const url = String(window.location?.href ?? '')
        const hit =
          /\/s\/([A-Za-z0-9_-]{6,})/.exec(url) ??
          /(?:session|sessionId)=([A-Za-z0-9_-]{6,})/.exec(url)
        return hit ? hit[1] : ''
      } catch {
        return ''
      }
    })()

    /* ------------------------------------------------------------ transport */

    // The desktop shell patches window.fetch and only forwards same-origin
    // "/api" calls, so a loopback fetch never leaves the page. XMLHttpRequest
    // is not patched, which gives us a second way to reach the same server.
    function xhrJson(url, init = {}) {
      return new Promise((resolve, reject) => {
        try {
          const xhr = new XMLHttpRequest()
          xhr.open(init.method ?? 'GET', url, true)
          xhr.setRequestHeader('x-game-preview', '1')
          if (init.body) xhr.setRequestHeader('content-type', 'application/json')
          xhr.timeout = 8000
          xhr.onload = () => {
            let body = {}
            try {
              body = xhr.responseText ? JSON.parse(xhr.responseText) : {}
            } catch {
              body = {}
            }
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body })
          }
          xhr.onerror = () => reject(new Error('XHR 网络错误'))
          xhr.ontimeout = () => reject(new Error('XHR 超时'))
          xhr.send(init.body ?? null)
        } catch (error) {
          reject(error)
        }
      })
    }

    function withTimeout(promise, ms, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)
        promise.then(
          (value) => { clearTimeout(timer); resolve(value) },
          (error) => { clearTimeout(timer); reject(error) },
        )
      })
    }

    function probeOnce(target, via, timeoutMs) {
      const work = (async () => {
        if (via === 'xhr') {
          const res = await xhrJson(target)
          return res.body
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const res = await fetch(target, { headers: { 'x-game-preview': '1' }, signal: controller.signal })
          return await res.json()
        } finally {
          clearTimeout(timer)
        }
      })()
      return withTimeout(work, timeoutMs, `${via} ${target.slice(0, 40)}`)
    }


    /* -------------------------------------------------------- iframe bridge */

    // The shell patches fetch/XHR in the top frame only. A hidden iframe served
    // by the loopback Host talks to it natively, and postMessage carries JSON.
    const bridge = { frame: null, port: null, ready: null, waiters: new Map(), seq: 0 }

    try {
      window.addEventListener('message', (event) => {
        const data = event.data
        if (!data || typeof data !== 'object') return
        if (data.__gp === 'ready') {
          if (bridge.ready) {
            bridge.ready.resolve()
            bridge.ready = null
          }
          return
        }
        if (data.__gp === 'frame') {
          const handler = frameHandlers.get(data.id)
          if (handler) handler(data)
          return
        }
        if (data.__gp === 'res') {
          const waiter = bridge.waiters.get(data.id)
          if (waiter) {
            bridge.waiters.delete(data.id)
            waiter(data)
          }
        }
      })
    } catch {}

    const frameHandlers = new Map()

    /** Stream captured frames without a request/response round trip per frame. */
    function subscribeFrames(onFrame) {
      if (!bridge.frame || !bridge.port) return () => {}
      const id = `f${++bridge.seq}`
      frameHandlers.set(id, onFrame)
      try {
        bridge.frame.contentWindow.postMessage({ __gp: 'sub', id }, '*')
      } catch {}
      return () => {
        frameHandlers.delete(id)
        try {
          bridge.frame.contentWindow.postMessage({ __gp: 'unsub', id }, '*')
        } catch {}
      }
    }

    function connectBridge(port, timeoutMs = 2000) {
      if (bridge.frame && bridge.port === port) return Promise.resolve(true)
      const frame = document.createElement('iframe')
      frame.setAttribute('aria-hidden', 'true')
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
      frame.src = `http://127.0.0.1:${port}/bridge?t=${Date.now()}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          bridge.ready = null
          reject(new Error(`bridge :${port} 握手超时`))
        }, timeoutMs)
        bridge.ready = {
          resolve: () => {
            clearTimeout(timer)
            bridge.frame = frame
            bridge.port = port
            resolve(true)
          },
        }
        try {
          document.body.appendChild(frame)
        } catch {
          clearTimeout(timer)
          reject(new Error('无法插入 bridge iframe'))
        }
      })
    }

    function bridgeCall(path, init = {}, timeoutMs = 4000) {
      if (!bridge.frame || !bridge.port) return Promise.reject(new Error('bridge 未连接'))
      const id = ++bridge.seq
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          bridge.waiters.delete(id)
          reject(new Error(`bridge 超时 ${timeoutMs}ms`))
        }, timeoutMs)
        bridge.waiters.set(id, (data) => {
          clearTimeout(timer)
          if (data.error) reject(new Error(data.error))
          else if (data.status >= 200 && data.status < 300) resolve(data.json ?? {})
          else reject(new Error(data.json?.error ?? `HTTP ${data.status}`))
        })
        bridge.frame.contentWindow.postMessage(
          { __gp: 'req', id, path, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) },
          '*',
        )
      })
    }

    async function httpJson(url, init = {}) {
      if (transport === 'bridge') {
        const apiPath = String(url).replace(/^https?:\/\/127\.0\.0\.1:\d+/, '')
        return bridgeCall(apiPath, init)
      }
      if (transport === 'xhr') {
        const res = await xhrJson(url, init)
        if (!res.ok) throw new Error(res.body?.error ?? `HTTP ${res.status}`)
        return res.body
      }
      const res = await fetch(url, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-game-preview': '1', ...(init.headers ?? {}) },
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body
    }

    let transport = 'fetch'

    async function probe() {
      if (endpoint) return endpoint

      // The desktop shell can hold a patched fetch open forever, so every
      // candidate gets a hard deadline. XHR is tried first: the shell patches
      // fetch, not XMLHttpRequest, and the game iframe proves loopback works.
      const selfOrigin = (() => {
        try {
          const origin = window.location?.origin
          return origin && origin !== 'null' && /^https?:/.test(origin) ? origin : null
        } catch {
          return null
        }
      })()

      // The iframe bridge is first: it is the only channel the shell cannot patch.
      for (const port of PORTS.slice(0, 4)) {
        try {
          await connectBridge(port, 1600)
          const body = await bridgeCall('/api/hello', {}, 2000)
          if (body?.app === APP) {
            endpoint = `http://127.0.0.1:${port}/api`
            transport = 'bridge'
            health = { port, version: body.version ?? null, error: null, mode: 'bridge' }
            return endpoint
          }
        } catch (error) {
          health.lastBridgeNote = String(error?.message ?? error).slice(0, 60)
        }
      }

      const deadline = 1500
      const candidates = [
        { mode: 'origin', via: 'xhr', url: `${API}/hello` },
        ...PORTS.map((port) => ({ mode: 'loopback', via: 'xhr', port, url: `http://127.0.0.1:${port}/api/hello` })),
        ...(selfOrigin ? [{ mode: 'origin', via: 'fetch', url: `${selfOrigin}${API}/hello` }] : []),
        { mode: 'origin', via: 'fetch', url: `${API}/hello` },
        ...PORTS.map((port) => ({ mode: 'loopback', via: 'fetch', port, url: `http://127.0.0.1:${port}/api/hello` })),
      ]

      const notes = []
      let cursor = 0
      // Bounded concurrency: enough to beat one hanging transport, small enough
      // not to hammer 16 ports on every mount.
      const worker = async () => {
        while (cursor < candidates.length) {
          const index = cursor++
          const candidate = candidates[index]
          try {
            const body = await probeOnce(candidate.url, candidate.via, deadline)
            if (body?.app === APP) {
              endpoint = candidate.mode === 'origin' ? API : `http://127.0.0.1:${candidate.port}/api`
              transport = candidate.via
              health = {
                port: candidate.port ?? null,
                version: body.version ?? null,
                error: null,
                mode: candidate.mode,
              }
              return true
            }
            notes.push(`${candidate.url.slice(0, 46)}[${candidate.via}] → app=${body?.app ?? '?'}`)
          } catch (error) {
            notes.push(`${candidate.url.slice(0, 46)}[${candidate.via}] → ${String(error?.message ?? error).slice(0, 44)}`)
          }
        }
        return false
      }

      const workers = Array.from({ length: 4 }, () => worker())
      const results = await Promise.all(workers)
      if (results.some(Boolean)) return endpoint

      health = {
        port: null,
        version: null,
        error: '宿主未响应：所有传输都没通',
        mode: null,
        attempts: [...(health.lastBridgeNote ? [`bridge → ${health.lastBridgeNote}`] : []), ...notes].slice(0, 8),
      }
      return null
    }

    async function call(path, init = {}) {
      let base = await probe()
      if (!base) throw new Error(health.error ?? '宿主未响应：预览服务没有启动')
      // call sites use the loopback shape ('/api/state'); a same-origin base
      // already ends in /api/game-preview, so drop the duplicated prefix
      const rel = path.startsWith('/api/') ? path.slice('/api'.length) : path
      try {
        return await httpJson(base + rel, init)
      } catch (error) {
        // the Host may have restarted under us; re-discover once before failing
        const message = String(error?.message ?? error)
        if (!/超时|网络错误|未连接|Failed|fetch|bridge/i.test(message)) throw error
        endpoint = null
        base = await probe()
        if (!base) throw error
        return httpJson(base + rel, init)
      }
    }

    /* ------------------------------------------------------------ styles */

    const css = `
      .gp-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:inherit}
      .gp-chips{display:flex;gap:6px;padding:8px 10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent)}
      .gp-chip{border:1px solid color-mix(in srgb, currentColor 18%, transparent);background:transparent;color:inherit;
        border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer;white-space:nowrap}
      .gp-chip[data-on="1"]{background:color-mix(in srgb, currentColor 12%, transparent);border-color:color-mix(in srgb, currentColor 30%, transparent)}
      .gp-chip[data-dim="1"]{opacity:.45;cursor:not-allowed}
      .gp-chip-window{display:inline-flex;align-items:center;gap:4px;cursor:default}
      .gp-chip-x{border:0;background:transparent;color:inherit;opacity:.65;cursor:pointer;font-size:11px;padding:0 0 0 2px}
      .gp-chip-x:hover{opacity:1}
      .gp-spinner{width:22px;height:22px;border-radius:50%;border:2px solid color-mix(in srgb, currentColor 22%, transparent);
        border-top-color:color-mix(in srgb, currentColor 70%, transparent);animation:gp-spin .8s linear infinite}
      @keyframes gp-spin{to{transform:rotate(360deg)}}
      .gp-chip-primary{border-color:color-mix(in srgb, currentColor 34%, transparent);font-weight:600}
      .gp-chip-select{appearance:none;padding-right:18px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
        background-position:calc(100% - 9px) 50%,calc(100% - 5px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
      .gp-stage{position:relative;flex:1;min-height:0;display:flex;align-items:stretch;justify-content:center;background:color-mix(in srgb, currentColor 4%, transparent);overflow:hidden}
      .gp-crop{position:absolute;inset:0;overflow:hidden;background:#000}
      .gp-crop-inner{position:absolute;transform-origin:top left}
      .gp-crop-inner .gp-shot{width:100%;height:100%;object-fit:fill}
      .gp-crop-layer{position:absolute;inset:0;z-index:4;cursor:crosshair;background:rgba(10,12,18,.45)}
      .gp-crop-layer .gp-crop-box{position:absolute;border:1px solid #7aa7ff;background:rgba(122,167,255,.16);box-shadow:0 0 0 9999px rgba(0,0,0,.35)}
      .gp-crop-hint{position:absolute;left:50%;top:10px;transform:translateX(-50%);font-size:11px;color:#dbe6ff;background:rgba(12,16,26,.72);
        padding:4px 10px;border-radius:999px;pointer-events:none}
      .gp-device{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;overflow:hidden}
      .gp-device-screen{flex:none;transform-origin:center center;overflow:hidden;background:#000;
        box-shadow:0 0 0 1px color-mix(in srgb, currentColor 20%, transparent), 0 12px 34px rgba(0,0,0,.35)}
      .gp-device[data-vp="pc"] .gp-device-screen{border-radius:10px}
      .gp-device[data-vp="mobile"] .gp-device-screen{border-radius:26px;box-shadow:0 0 0 8px #1b1d22, 0 0 0 9px color-mix(in srgb, currentColor 22%, transparent), 0 18px 42px rgba(0,0,0,.45)}
      .gp-device-fluid{width:100%!important;height:100%!important;transform:none!important;box-shadow:none;border-radius:0}
      .gp-device-tag{position:absolute;bottom:6px;right:10px;font-size:10px;opacity:.5;pointer-events:none}
      .gp-frame{width:100%;height:100%;border:0;background:#000;display:block}
      .gp-shot{width:100%;height:100%;object-fit:contain;background:#000;display:block;image-rendering:auto}
      .gp-shot[data-interactive="1"]{cursor:crosshair;outline:none}
      .gp-shot[data-interactive="1"]:focus-visible{outline:1px solid #7aa7ff}
      .gp-live{position:absolute;left:8px;top:8px;display:flex;gap:6px;align-items:center;pointer-events:none;font-size:10px}
      .gp-live span{background:rgba(12,12,14,.72);color:#eee;border-radius:999px;padding:2px 8px;backdrop-filter:blur(4px)}
      .gp-live span[data-warn="1"]{background:rgba(160,60,30,.85)}
      .gp-bar{display:flex;align-items:center;gap:4px;padding:6px 8px;border-top:1px solid color-mix(in srgb, currentColor 12%, transparent);flex-wrap:wrap}
      .gp-btn{border:1px solid color-mix(in srgb, currentColor 16%, transparent);background:transparent;color:inherit;
        border-radius:7px;padding:3px 9px;font-size:11px;cursor:pointer;line-height:1.5}
      .gp-btn:hover:not(:disabled){background:color-mix(in srgb, currentColor 10%, transparent)}
      .gp-btn:disabled{opacity:.4;cursor:default}
      .gp-btn[data-primary="1"]{background:color-mix(in srgb, currentColor 14%, transparent);font-weight:600}
      .gp-spacer{flex:1}
      .gp-dirty{font-size:11px;opacity:.75;display:flex;align-items:center;gap:5px}
      .gp-dot{width:6px;height:6px;border-radius:50%;background:#e5793a;display:inline-block}
      .gp-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;opacity:.85}
      .gp-input{width:100%;max-width:420px;padding:6px 9px;border-radius:8px;font-size:12px;color:inherit;background:transparent;
        border:1px solid color-mix(in srgb, currentColor 20%, transparent)}
      .gp-select{max-width:100%;padding:5px 8px;border-radius:8px;font-size:11px;color:inherit;
        background:color-mix(in srgb, currentColor 6%, transparent);border:1px solid color-mix(in srgb, currentColor 20%, transparent)}
      .gp-note{font-size:11px;opacity:.6;max-width:420px;line-height:1.6}
      .gp-err{color:#d9534f;font-size:11px;padding:6px 10px}
      .gp-attempts{font-size:10px;opacity:.65;padding:2px 10px 6px;line-height:1.6;word-break:break-all;max-height:110px;overflow:auto}
      .gp-root[data-immersive="1"]{position:relative}
      .gp-root[data-immersive="1"] .gp-stage{padding:0}
      .gp-root[data-immersive="1"] .gp-device{padding:0}
      .gp-root[data-immersive="1"] .gp-frame,.gp-root[data-immersive="1"] .gp-shot{border-radius:0}
      .gp-exit-full{position:absolute;right:10px;top:10px;z-index:5;font-size:11px;padding:3px 10px;border-radius:999px;
        border:1px solid rgba(255,255,255,.25);background:rgba(12,12,14,.62);color:#eee;cursor:pointer;backdrop-filter:blur(4px)}
      .gp-health{display:flex;align-items:flex-start;gap:6px;justify-content:space-between;font-size:10px;opacity:.6;
        padding:4px 10px;border-bottom:1px solid color-mix(in srgb, currentColor 8%, transparent);word-break:break-all;line-height:1.5}
      .gp-hint{color:#c8892f;font-size:11px;padding:6px 10px}
      .gp-picker{display:flex;gap:6px;padding:6px 10px;align-items:center;border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent)}
    `

    function useStyles() {
      // returns a style element rendered inside the panel so unmounting removes it
      return h('style', { 'data-game-preview': '1' }, css)
    }

    /* --------------------------------------------------------- interaction */

    const KEYS = {
      ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
      Enter: 0x0d, Escape: 0x1b, ' ': 0x20, Spacebar: 0x20, Tab: 0x09,
      Shift: 0x10, Control: 0x11, Alt: 0x12, Backspace: 0x08, CapsLock: 0x14,
      Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Insert: 0x2d, Delete: 0x2e,
      ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
      '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0x70 + i])),
    }

    function virtualKey(key) {
      if (KEYS[key] !== undefined) return KEYS[key]
      if (typeof key === 'string' && key.length === 1) {
        const upper = key.toUpperCase()
        const code = upper.charCodeAt(0)
        if (code >= 0x30 && code <= 0x5a) return code
      }
      return 0
    }

    /* -------------------------------------------------------------- crop */

    /**
     * Engine editors show the game inside a docked panel; cropping to that panel
     * is what makes a Unity capture actually look like a game window. The rect
     * is normalised (0..1) against the captured frame and remembered per window.
     */
    function CropOverlay({ onPick, onCancel }) {
      const [start, setStart] = useState(null)
      const [now, setNow] = useState(null)
      const point = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        return {
          x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
          y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        }
      }
      const box = start && now
        ? {
            left: `${Math.min(start.x, now.x) * 100}%`,
            top: `${Math.min(start.y, now.y) * 100}%`,
            width: `${Math.abs(now.x - start.x) * 100}%`,
            height: `${Math.abs(now.y - start.y) * 100}%`,
          }
        : null
      return h('div', {
        className: 'gp-crop-layer',
        onMouseDown: (event) => { event.preventDefault(); setStart(point(event)); setNow(point(event)) },
        onMouseMove: (event) => { if (start) setNow(point(event)) },
        onMouseUp: () => {
          if (!start || !now) return
          const x = Math.min(start.x, now.x)
          const y = Math.min(start.y, now.y)
          const w = Math.abs(now.x - start.x)
          const hh = Math.abs(now.y - start.y)
          if (w > 0.04 && hh > 0.04) onPick({ x, y, w, h: hh })
          setStart(null)
          setNow(null)
        },
        onMouseLeave: () => { setStart(null); setNow(null) },
        onDoubleClick: onCancel,
      },
        h('span', { className: 'gp-crop-hint' }, '按住框选要显示的区域 · 双击取消'),
        box ? h('div', { className: 'gp-crop-box', style: box }) : null)
    }

    /* -------------------------------------------------------- device frame */

    /**
     * A phone preview must be a 390x844 *logical* viewport, or the game's media
     * queries never see a phone. The frame keeps that size and scales the whole
     * thing down to fit whatever space the sidebar gives it.
     */
    function DeviceFrame({ viewport, children }) {
      const hostRef = useRef(null)
      const preset = VIEWPORTS[viewport]?.width ? VIEWPORTS[viewport] : null
      const [scale, setScale] = useState(1)

      useEffect(() => {
        const host = hostRef.current
        if (!host || !preset) {
          setScale(1)
          return undefined
        }
        const fit = () => {
          const rect = host.getBoundingClientRect()
          if (!rect.width || !rect.height) return
          const next = Math.min(1, (rect.width - 12) / preset.width, (rect.height - 12) / preset.height)
          setScale(Math.max(0.1, Math.round(next * 1000) / 1000))
        }
        fit()
        let observer = null
        try {
          observer = new ResizeObserver(fit)
          observer.observe(host)
        } catch {
          window.addEventListener('resize', fit)
        }
        return () => {
          if (observer) observer.disconnect()
          else window.removeEventListener('resize', fit)
        }
      }, [preset, viewport])

      const inner = preset
        ? h('div', {
            className: 'gp-device-screen',
            style: { width: preset.width, height: preset.height, transform: `scale(${scale})` },
          }, children)
        : h('div', { className: 'gp-device-screen gp-device-fluid' }, children)

      return h('div', { className: 'gp-device', 'data-vp': viewport, ref: hostRef },
        inner,
        preset ? h('span', { className: 'gp-device-tag' }, `${preset.width}×${preset.height} · ${Math.round(scale * 100)}%`) : null)
    }

    /* ------------------------------------------------------- window stage */

    /**
     * Native windows arrive either as one MJPEG <img> (loopback) or as polled
     * JPEG bytes (same-origin, where <img> cannot reach the control API).
     */
    function WindowStage({ mode, fallbackUrl, reloadKey, alt, onError, interaction, imageRef }) {
      const live = mode === 'origin' || mode === 'bridge'
      const [src, setSrc] = useState(live ? null : fallbackUrl)
      useEffect(() => {
        if (!live) {
          setSrc(`${fallbackUrl}${fallbackUrl.includes('?') ? '&' : '?'}t=${reloadKey}`)
          return undefined
        }
        let alive = true
        let timer = null
        let currentUrl = null
        let unsubscribe = null

        const show = (blob) => {
          if (!alive) return
          const next = URL.createObjectURL(blob)
          if (currentUrl) URL.revokeObjectURL(currentUrl)
          currentUrl = next
          setSrc(next)
        }

        if (mode === 'bridge') {
          // push: the bridge iframe long-polls the Host and forwards every frame
          const handle = (data) => {
            try {
              const binary = atob(data.jpeg)
              const bytes = new Uint8Array(binary.length)
              for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
              show(new Blob([bytes], { type: 'image/jpeg' }))
            } catch {
              /* a truncated frame is simply skipped */
            }
          }
          unsubscribe = subscribeFrames(handle)
          // a hidden panel must not keep decoding 15 frames per second
          const onVisibility = () => {
            if (document.hidden) {
              unsubscribe?.()
              unsubscribe = null
            } else if (!unsubscribe) {
              unsubscribe = subscribeFrames(handle)
            }
          }
          document.addEventListener('visibilitychange', onVisibility)
          return () => {
            alive = false
            document.removeEventListener('visibilitychange', onVisibility)
            unsubscribe?.()
            if (currentUrl) URL.revokeObjectURL(currentUrl)
          }
        }

        const tick = async () => {
          try {
            const res = await fetch(`${API}/frame?t=${Date.now()}`, { headers: { 'x-game-preview': '1' } })
            if (res.status === 200 && alive) show(await res.blob())
          } catch {
            /* the host may be restarting; the next tick retries */
          }
          if (alive) timer = setTimeout(tick, 70)
        }
        void tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          if (currentUrl) URL.revokeObjectURL(currentUrl)
        }
      }, [live, mode, fallbackUrl, reloadKey])
      const live_ = interaction && interaction.enabled
      const norm = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        if (!rect.width || !rect.height) return { x: 0, y: 0 }
        return {
          x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
          y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        }
      }
      return h('img', {
        className: 'gp-shot',
        ref: imageRef,
        src: src ?? undefined,
        alt: alt ?? 'game window',
        onError,
        'data-interactive': live_ ? '1' : '0',
        tabIndex: live_ ? 0 : -1,
        onMouseMove: live_ ? (event) => interaction.send({ type: 'move', ...norm(event) }) : undefined,
        onMouseDown: live_ ? (event) => { event.preventDefault(); interaction.send({ type: 'down', ...norm(event), button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' }) } : undefined,
        onMouseUp: live_ ? (event) => { event.preventDefault(); interaction.send({ type: 'up', ...norm(event), button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' }) } : undefined,
        onContextMenu: live_ ? (event) => event.preventDefault() : undefined,
        onWheel: live_ ? (event) => { event.preventDefault(); interaction.send({ type: 'wheel', delta: event.deltaY < 0 ? 120 : -120 }) } : undefined,
        onKeyDown: live_ ? (event) => {
          const vk = virtualKey(event.key)
          if (!vk) return
          event.preventDefault()
          interaction.send({ type: 'key', vk, down: true })
        } : undefined,
        onKeyUp: live_ ? (event) => {
          const vk = virtualKey(event.key)
          if (!vk) return
          event.preventDefault()
          interaction.send({ type: 'key', vk, down: false })
        } : undefined,
      })
    }

    /* --------------------------------------------------------- interaction */

    /* -------------------------------------------------------------- crop */

    /**
     * Engine editors show the game inside a docked panel; cropping to that panel
     * is what makes a Unity capture actually look like a game window. The rect
     * is normalised (0..1) against the captured frame and remembered per window.
     */
    /* -------------------------------------------------------- device frame */

    /**
     * A phone preview must be a 390x844 *logical* viewport, or the game's media
     * queries never see a phone. The frame keeps that size and scales the whole
     * thing down to fit whatever space the sidebar gives it.
     */
    function DeviceFrame({ viewport, children }) {
      const hostRef = useRef(null)
      const preset = VIEWPORTS[viewport]?.width ? VIEWPORTS[viewport] : null
      const [scale, setScale] = useState(1)

      useEffect(() => {
        const host = hostRef.current
        if (!host || !preset) {
          setScale(1)
          return undefined
        }
        const fit = () => {
          const rect = host.getBoundingClientRect()
          if (!rect.width || !rect.height) return
          const next = Math.min(1, (rect.width - 12) / preset.width, (rect.height - 12) / preset.height)
          setScale(Math.max(0.1, Math.round(next * 1000) / 1000))
        }
        fit()
        let observer = null
        try {
          observer = new ResizeObserver(fit)
          observer.observe(host)
        } catch {
          window.addEventListener('resize', fit)
        }
        return () => {
          if (observer) observer.disconnect()
          else window.removeEventListener('resize', fit)
        }
      }, [preset, viewport])

      const inner = preset
        ? h('div', {
            className: 'gp-device-screen',
            style: { width: preset.width, height: preset.height, transform: `scale(${scale})` },
          }, children)
        : h('div', { className: 'gp-device-screen gp-device-fluid' }, children)

      return h('div', { className: 'gp-device', 'data-vp': viewport, ref: hostRef },
        inner,
        preset ? h('span', { className: 'gp-device-tag' }, `${preset.width}×${preset.height} · ${Math.round(scale * 100)}%`) : null)
    }

    /* ------------------------------------------------------- window stage */

    /**
     * Native windows arrive either as one MJPEG <img> (loopback) or as polled
     * JPEG bytes (same-origin, where <img> cannot reach the control API).
     */
    function WindowStage({ mode, fallbackUrl, reloadKey, alt, onError, interaction, imageRef }) {
      const isOrigin = mode === 'origin'
      const [src, setSrc] = useState(isOrigin ? null : fallbackUrl)
      useEffect(() => {
        if (!isOrigin) {
          setSrc(`${fallbackUrl}${fallbackUrl.includes('?') ? '&' : '?'}t=${reloadKey}`)
          return undefined
        }
        let alive = true
        let timer = null
        let currentUrl = null
        const tick = async () => {
          try {
            const res = await fetch(`${API}/frame?t=${Date.now()}`, { headers: { 'x-game-preview': '1' } })
            if (res.status === 200 && alive) {
              const blob = await res.blob()
              if (alive) {
                const next = URL.createObjectURL(blob)
                if (currentUrl) URL.revokeObjectURL(currentUrl)
                currentUrl = next
                setSrc(next)
              }
            }
          } catch {
            /* the host may be restarting; the next tick retries */
          }
          if (alive) timer = setTimeout(tick, 70)
        }
        void tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          if (currentUrl) URL.revokeObjectURL(currentUrl)
        }
      }, [isOrigin, fallbackUrl, reloadKey])
      const live_ = interaction && interaction.enabled
      const norm = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        if (!rect.width || !rect.height) return { x: 0, y: 0 }
        return {
          x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
          y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        }
      }
      return h('img', {
        className: 'gp-shot',
        ref: imageRef,
        src: src ?? undefined,
        alt: alt ?? 'game window',
        onError,
        'data-interactive': live_ ? '1' : '0',
        tabIndex: live_ ? 0 : -1,
        onMouseMove: live_ ? (event) => interaction.send({ type: 'move', ...norm(event) }) : undefined,
        onMouseDown: live_ ? (event) => { event.preventDefault(); interaction.send({ type: 'down', ...norm(event), button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' }) } : undefined,
        onMouseUp: live_ ? (event) => { event.preventDefault(); interaction.send({ type: 'up', ...norm(event), button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' }) } : undefined,
        onContextMenu: live_ ? (event) => event.preventDefault() : undefined,
        onWheel: live_ ? (event) => { event.preventDefault(); interaction.send({ type: 'wheel', delta: event.deltaY < 0 ? 120 : -120 }) } : undefined,
        onKeyDown: live_ ? (event) => {
          const vk = virtualKey(event.key)
          if (!vk) return
          event.preventDefault()
          interaction.send({ type: 'key', vk, down: true })
        } : undefined,
        onKeyUp: live_ ? (event) => {
          const vk = virtualKey(event.key)
          if (!vk) return
          event.preventDefault()
          interaction.send({ type: 'key', vk, down: false })
        } : undefined,
      })
    }

    /**
     * Static games: prefer the Host's single-file bundle so the page can run
     * from a blob URL (a file:// host cannot reach the loopback server), and
     * fall back to the served directory URL when bundling is unavailable.
     */
    function GameStage({ bundlePath, fallbackUrl, reloadKey, viewport, title }) {
      // without a bundle the served URL can render right away
      const [src, setSrc] = useState(bundlePath ? null : fallbackUrl)
      useEffect(() => {
        let alive = true
        let created = null
        if (!bundlePath) {
          setSrc(fallbackUrl)
          return undefined
        }
        ;(async () => {
          try {
            const res = await fetch(`${bundlePath}&t=${Date.now()}`, { headers: { 'x-game-preview': '1' } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const html = await res.text()
            created = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
            if (alive) setSrc(created)
          } catch {
            if (alive) setSrc(fallbackUrl)
          }
        })()
        return () => {
          alive = false
          if (created) URL.revokeObjectURL(created)
        }
      }, [bundlePath, fallbackUrl, reloadKey])

      if (!src) return h('div', { className: 'gp-empty' }, h('div', { className: 'gp-note' }, '正在打包游戏…'))
      return h('iframe', {
        key: `${src}#${viewport}`,
        className: 'gp-frame',
        'data-vp': viewport,
        src,
        title: title ?? 'game preview',
        sandbox: 'allow-scripts allow-pointer-lock allow-popups allow-modals',
        allow: 'autoplay; fullscreen; gamepad',
      })
    }

    /* ------------------------------------------------------------- panel */

    function Panel() {
      const [snap, setSnap] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [reloadKey, setReloadKey] = useState(0)
      const [viewport, setViewportState] = useState(() => {
        try {
          const saved = String(window.localStorage.getItem(WIDTH_KEY) ?? '')
          return VIEWPORTS[saved] ? saved : 'auto'
        } catch {
          return 'auto'
        }
      })
      const [manualRoot, setManualRoot] = useState('')
      const [rootOverride, setRootOverride] = useState(readStoredRoot)
      const [manualUrl, setManualUrl] = useState('')
      const [immersive, setImmersive] = useState(false)
      const [crop, setCrop] = useState({ mode: false, rect: null })
      const [pointerMode, setPointerMode] = useState(false)
      const [quality, setQualityState] = useState(() => {
        try {
          const saved = String(window.localStorage.getItem('dsh-game-preview.quality') ?? '')
          return QUALITY[saved] ? saved : 'sharp'
        } catch {
          return 'sharp'
        }
      })
      const [windows, setWindows] = useState(null)
      const [roots, setRoots] = useState(null)
      const [winBusy, setWinBusy] = useState(false)
      const alive = useRef(true)
      const reported = useRef(false)

      const setViewport = useCallback((next) => {
        setViewportState(next)
        try {
          window.localStorage.setItem(WIDTH_KEY, next)
        } catch {}
      }, [])

      const reportEnv = useCallback(async (note) => {
        try {
          const loc = window.location
          await fetch(`${API}/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-game-preview': '1' },
            body: JSON.stringify({
              note,
              href: String(loc?.href ?? '').slice(0, 300),
              origin: String(loc?.origin ?? ''),
              protocol: String(loc?.protocol ?? ''),
              mode: health.mode,
              transport,
              port: health.port,
              version: health.version,
              error: health.error,
              ua: String(navigator?.userAgent ?? '').slice(0, 160),
            }),
          })
        } catch {}
      }, [])

      const refresh = useCallback(async () => {
        const query = []
        if (rootOverride) query.push(`root=${encodeURIComponent(rootOverride)}`)
        else if (SESSION_ID) query.push(`session=${encodeURIComponent(SESSION_ID)}`)
        try {
          if (!reported.current) {
            reported.current = true
            void reportEnv('first-state')
          }
          const next = await call('/api/state' + (query.length ? `?${query.join('&')}` : ''))
          if (alive.current) {
            setSnap(next)
            setError(null)
          }
        } catch (err) {
          if (alive.current) {
            setError(String(err?.message ?? err))
            if (!reported.current) {
              reported.current = true
              void reportEnv('first-state-failed')
            }
          }
        }
      }, [rootOverride, reportEnv])

      useEffect(() => {
        alive.current = true
        void refresh()
        const timer = setInterval(() => { void refresh() }, 1500)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [refresh])

      const run = useCallback(async (configId) => {
        setBusy(true)
        setError(null)
        try {
          if (configId) window.localStorage.setItem(`dsh-game-preview.config:${snap?.root ?? ''}`, configId)
        } catch {}
        try {
          if (configId && /-native$/.test(String(configId))) window.localStorage.removeItem('dsh-game-preview.window')
        } catch {}
        try {
          const next = await call('/api/run', {
            method: 'POST',
            body: JSON.stringify({ configId, url: manualUrl || undefined }),
          })
          setSnap(next)
          setReloadKey((n) => n + 1)
          if (next?.error) setError(next.error)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [manualUrl, snap?.root])

      const reconnect = useCallback(async () => {
        endpoint = null
        health = { port: null, version: null, error: null, mode: null }
        setBusy(true)
        try {
          await refresh()
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const stop = useCallback(async () => {
        setBusy(true)
        try {
          setSnap(await call('/api/stop', { method: 'POST', body: '{}' }))
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      const detect = useCallback(async () => {
        if (!manualRoot.trim()) return
        setBusy(true)
        try {
          setSnap(await call('/api/detect', { method: 'POST', body: JSON.stringify({ root: manualRoot.trim() }) }))
          setError(null)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [manualRoot])

      const openRoots = useCallback(async () => {
        setWinBusy(true)
        try {
          const next = await call('/api/roots')
          setRoots(next.roots ?? [])
          if (!(next.roots ?? []).length) setError('没有开着的会话目录可切：直接在下面填路径')
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setWinBusy(false)
        }
      }, [])

      const pickRoot = useCallback(async (dir) => {
        if (!dir) return
        setRoots(null)
        setRootOverride(dir)
        try {
          window.localStorage.setItem(ROOT_KEY, dir)
        } catch {}
        setBusy(true)
        try {
          const next = await call('/api/detect', { method: 'POST', body: JSON.stringify({ root: dir }) })
          setSnap(next)
          setError(null)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      const imageRef = useRef(null)

      const saveShot = useCallback(async () => {
        const img = imageRef.current
        if (!img || !img.src) {
          setError('还没有画面可以导出')
          return
        }
        try {
          if (!img.src.startsWith('blob:')) {
            setError('当前传输方式不支持导出画面（外部打开后用系统截图）')
            return
          }
          const blob = await (await fetch(img.src)).blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `game-preview-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 5000)
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [])

      const lastMove = useRef(0)
      const sendInput = useCallback((event) => {
        const now = Date.now()
        if (event.type === 'move' && now - lastMove.current < 45) return
        lastMove.current = now
        // fire and forget: input must not queue behind a slow request
        void call('/api/input', { method: 'POST', body: JSON.stringify(event) }).catch(() => {})
      }, [])

      useEffect(() => {
        const onHotkey = (event) => {
          const tag = String(event.target?.tagName ?? '').toLowerCase()
          if (tag === 'input' || tag === 'textarea' || event.target?.isContentEditable) return
          if (event.key === 'Escape') {
            if (pointerMode) { setPointerMode(false); return }
            if (immersive) setImmersive(false)
            return
          }
          if (event.key === 'f' || event.key === 'F') {
            if (!pointerMode) setImmersive((on) => !on)
            return
          }
          if ((event.key === 'r' || event.key === 'R') && !pointerMode) {
            setReloadKey((n) => n + 1)
          }
        }
        window.addEventListener('keydown', onHotkey)
        return () => window.removeEventListener('keydown', onHotkey)
      }, [pointerMode, immersive])

      useEffect(() => {
        if (!pointerMode) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setPointerMode(false)
            return
          }
          const vk = virtualKey(event.key)
          if (!vk) return
          event.preventDefault()
          sendInput({ type: 'key', vk, down: event.type === 'keydown' })
        }
        window.addEventListener('keydown', onKey)
        window.addEventListener('keyup', onKey)
        return () => {
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('keyup', onKey)
        }
      }, [pointerMode, sendInput])

      const detachWindow = useCallback(async () => {
        try {
          setSnap(await call('/api/window/stop', { method: 'POST', body: '{}' }))
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [])

      const redetect = useCallback(async () => {
        if (!snap?.root) return
        setBusy(true)
        try {
          setSnap(await call('/api/detect', { method: 'POST', body: JSON.stringify({ root: snap.root }) }))
          setError(null)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [snap?.root])

      const openPicker = useCallback(async () => {
        setWinBusy(true)
        try {
          const next = await call('/api/window/list')
          setWindows(next.windows ?? [])
          if (!(next.windows ?? []).length) setError('没有可捕获的窗口')
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setWinBusy(false)
        }
      }, [])

      const attach = useCallback(async (hwnd) => {
        setWinBusy(true)
        try {
          const preset = QUALITY[quality]
          const next = await call('/api/window/attach', {
            method: 'POST',
            body: JSON.stringify({ hwnd, options: { fps: preset.fps, maxWidth: preset.maxWidth, quality: preset.quality } }),
          })
          try {
            window.localStorage.setItem('dsh-game-preview.window', JSON.stringify({ title: next?.active?.windowTitle ?? '' }))
          } catch {}
          setSnap(next)
          setWindows(null)
          setReloadKey((n) => n + 1)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setWinBusy(false)
        }
      }, [])

      // no workspace known (idle session, first run): ask the host what it could use
      useEffect(() => {
        if (!snap || snap.root || roots || winBusy) return
        void openRoots()
      }, [snap, roots, winBusy, openRoots])

      const configs = snap?.configs ?? []

      const active = snap?.active ?? null
      const dirty = snap?.dirty ?? []
      const capture = snap?.capture ?? null
      const isWindow = active?.kind === 'window'
      const url = active?.url ?? null
      // Build outputs beat dev servers beat engine editors beat the WeChat shell.
      const rankOf = (cfg) => {
        const id = String(cfg.id ?? '')
        if (id.startsWith('static@')) return 0
        if (id === 'static') return 1
        if (id.startsWith('node-dev')) return 2
        if (id.startsWith('cocos-web')) return 3
        if (id.startsWith('wechat')) return 4
        if (cfg.kind === 'native') return 5
        return 9
      }
      const ordered = [...configs].sort((a, b) => rankOf(a) - rankOf(b))
      const lastUsed = (() => {
        try {
          const saved = String(window.localStorage.getItem(`dsh-game-preview.config:${snap?.root ?? ''}`) ?? '')
          return configs.find((c) => c.id === saved) ?? null
        } catch {
          return null
        }
      })()
      const primaryCfg = active
        ? (configs.find((c) => c.id === active.id) ?? ordered[0])
        : (lastUsed ?? ordered[0])

      // reopen the last captured window instead of making the user pick again
      const restoreWindow = useCallback(async () => {
        let saved = null
        try {
          saved = JSON.parse(window.localStorage.getItem('dsh-game-preview.window') ?? 'null')
        } catch {}
        if (!saved?.title) return false
        try {
          const preset = QUALITY[quality]
          const next = await call('/api/window/attach', {
            method: 'POST',
            body: JSON.stringify({ title: saved.title, options: { fps: preset.fps, maxWidth: preset.maxWidth, quality: preset.quality } }),
          })
          setSnap(next)
          return true
        } catch {
          try {
            window.localStorage.removeItem('dsh-game-preview.window')
          } catch {}
          return false
        }
      }, [quality])

      const switchQuality = useCallback(async (next) => {
        setQualityState(next)
        try {
          window.localStorage.setItem('dsh-game-preview.quality', next)
        } catch {}
        const preset = QUALITY[next]
        if (!active || active.kind !== 'window') return
        setBusy(true)
        try {
          setSnap(await call('/api/window/config', {
            method: 'POST',
            body: JSON.stringify({ fps: preset.fps, maxWidth: preset.maxWidth, quality: preset.quality }),
          }))
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [active])


      const cropKey = (active) =>
        `dsh-game-preview.crop:${active?.windowTitle ?? active?.id ?? 'stage'}`

      useEffect(() => {
        if (!active) return
        let stored = null
        try {
          stored = JSON.parse(window.localStorage.getItem(cropKey(active)) ?? 'null')
        } catch {}
        setCrop({ mode: false, rect: stored })
      }, [active?.windowTitle, active?.id])

      const saveCrop = useCallback((rect) => {
        setCrop({ mode: false, rect })
        try {
          if (rect) window.localStorage.setItem(cropKey(active), JSON.stringify(rect))
          else window.localStorage.removeItem(cropKey(active))
        } catch {}
      }, [active])

      const canCapture = capture?.supported !== false

      const others = ordered.filter((cfg) => cfg.id !== primaryCfg?.id)
      const chips = [
        primaryCfg
          ? h('button', {
              key: 'primary',
              className: 'gp-chip gp-chip-primary',
              title: primaryCfg.url ?? primaryCfg.detail ?? '',
              disabled: busy,
              onClick: () => void run(primaryCfg.id),
            }, `▶ ${primaryCfg.title.replace(/（.*?）/g, '')}`)
          : null,
        others.length
          ? h('select', {
              key: 'more',
              className: 'gp-chip gp-chip-select',
              title: `还有 ${others.length} 个配置`,
              value: '',
              disabled: busy,
              onChange: (e) => {
                if (e.target.value) {
                  void run(e.target.value)
                  e.target.value = ''
                }
              },
            },
              h('option', { value: '' }, `其他 ${others.length} 个…`),
              others.map((cfg) => h('option', {
                key: cfg.id,
                value: cfg.id,
                disabled: cfg.kind === 'native' && !canCapture,
              }, `${cfg.title}${cfg.detail ? ` — ${cfg.detail}` : ''}`)))
          : null,
      ]

      const empty = !url
        ? h('div', { className: 'gp-empty' },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '还没有运行中的预览'),
            h('div', { className: 'gp-note' },
              snap?.root
                ? (configs.length && configs.every((c) => c.kind === 'manual')
                    ? `扫描了 ${snap.root}，没找到可运行的配置：填一个已在跑的 URL，或让 agent 帮你起服务。`
                    : '点上方配置启动；或者在对话里让 agent 调用 game_preview_run。')
                : '填入项目目录后检测，或者在对话里让 agent 跑一次游戏预览。'),
            h('input', {
              className: 'gp-input',
              placeholder: '项目目录，例如 D:\\games\\my-game',
              value: manualRoot,
              onChange: (e) => setManualRoot(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') void detect() },
            }),
            h('button', { className: 'gp-btn', disabled: busy || !manualRoot.trim(), onClick: () => void detect() }, '检测这个目录'))
        : null

      const liveBadges = []
      if (isWindow) {
        const age = capture?.lastFrameAt ? Math.max(0, Date.now() - capture.lastFrameAt) : null
        liveBadges.push(h('span', { key: 'fps', 'data-warn': capture?.fps && capture.fps < 5 ? '1' : '0' },
          capture?.fps ? `${capture.fps} fps${age !== null ? ` · ${Math.min(999, Math.round(age))}ms` : ''}` : '连接中'))
        if (capture?.stale || (capture?.errorCode && capture.errorCode !== 'minimized')) {
          liveBadges.push(h('span', { key: 'stale', 'data-warn': '1' }, capture?.errorCode === 'window-closed' ? '窗口已关闭' : '已断流'))
        }
        if (capture?.width) liveBadges.push(h('span', { key: 'size' }, `${capture.width}×${capture.height}`))
        if (active?.windowTitle) {
          liveBadges.push(h('span', { key: 'win', title: active.windowTitle },
            String(active.windowTitle).slice(0, 28)))
        }
      }

      const stage = url
        ? isWindow
          ? h('div', { className: 'gp-stage' },
              crop.rect
                ? h('div', { className: 'gp-crop' },
                    h('div', {
                      className: 'gp-crop-inner',
                      style: {
                        width: `${100 / crop.rect.w}%`,
                        height: `${100 / crop.rect.h}%`,
                        left: `${-(crop.rect.x / crop.rect.w) * 100}%`,
                        top: `${-(crop.rect.y / crop.rect.h) * 100}%`,
                      },
                    },
                      h(WindowStage, {
                        key: `${url}#${reloadKey}`,
                        mode: health.mode,
                        fallbackUrl: url,
                        reloadKey,
                        alt: active?.windowTitle ?? 'game window',
                        onError: () => setError('画面流断了：点 ⟳ 重载重新连接'),
                        interaction: { enabled: pointerMode, send: sendInput },
                        imageRef,
                      })))
                : h(DeviceFrame, { viewport },
                    h(WindowStage, {
                      key: `${url}#${reloadKey}`,
                      mode: health.mode,
                      fallbackUrl: url,
                      reloadKey,
                      alt: active?.windowTitle ?? 'game window',
                      onError: () => setError('画面流断了：点 ⟳ 重载重新连接'),
                      interaction: { enabled: pointerMode, send: sendInput },
                      imageRef,
                    })),
              crop.mode
                ? h(CropOverlay, {
                    onPick: saveCrop,
                    onCancel: () => setCrop({ mode: false, rect: crop.rect }),
                  })
                : null,
              liveBadges.length ? h('div', { className: 'gp-live' }, liveBadges) : null)
          : h('div', { className: 'gp-stage' },
              h(DeviceFrame, { viewport },
                h(GameStage, {
                  bundlePath: active?.bundlePath,
                  fallbackUrl: url,
                  reloadKey,
                  viewport,
                  title: active?.title ?? 'game preview',
                })))
        : empty

      const blackHint = isWindow && capture?.errorCode === 'printwindow-failed'
        ? '这个窗口抓不到画面（常见于独占全屏）：把游戏改成窗口/无边框模式再重试。'
        : isWindow && capture?.black > 3
          ? '连续全黑帧：可能是独占全屏，或游戏刚启动还没画第一帧。'
          : isWindow && capture?.errorCode === 'minimized'
            ? '窗口最小化时无法捕获，请还原游戏窗口。'
            : null

      const rootPicker = roots
        ? h('div', { className: 'gp-picker' },
            h('select', {
              className: 'gp-select',
              defaultValue: '',
              disabled: busy,
              onChange: (e) => void pickRoot(e.target.value),
            },
              h('option', { value: '' }, `选择会话目录（${roots.length}）`),
              roots.map((r) => h('option', { key: r.dir, value: r.dir }, r.dir))),
            h('input', {
              className: 'gp-input',
              style: { maxWidth: 220 },
              placeholder: '或者填一个新路径',
              value: manualRoot,
              onChange: (e) => setManualRoot(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') void pickRoot(manualRoot.trim()) },
            }),
            h('button', { className: 'gp-btn', onClick: () => setRoots(null) }, '取消'))
        : null

      const picker = windows
        ? h('div', { className: 'gp-picker' },
            h('select', {
              className: 'gp-select',
              defaultValue: '',
              disabled: winBusy,
              onChange: (e) => { if (e.target.value) void attach(e.target.value) },
            },
              h('option', { value: '' }, `选择窗口（${windows.length}）`),
              windows.slice(0, 40).map((w) => h('option', { key: w.hwnd, value: String(w.hwnd) },
                `${w.title.slice(0, 48)} — ${w.width}×${w.height}`))),
            h('button', { className: 'gp-btn', onClick: () => setWindows(null) }, '取消'))
        : null

      if (!snap && !error) {
        return h('div', { className: 'gp-root' },
          useStyles(),
          h('div', { className: 'gp-empty' },
            h('div', { className: 'gp-spinner', 'aria-hidden': 'true' }),
            h('div', { className: 'gp-note' }, '正在连接游戏预览宿主…')))
      }

      if (immersive) {
        return h('div', { className: 'gp-root', 'data-immersive': '1' },
          useStyles(),
          stage,
          h('button', {
            className: 'gp-exit-full',
            onClick: () => setImmersive(false),
            title: '退出满屏',
          }, '✕ 退出满屏'))
      }

      const autoRan = useRef(false)
      useEffect(() => {
        if (autoRan.current || !snap || active) return
        try {
          if (window.localStorage.getItem('dsh-game-preview.autoRun') === '0') return
        } catch {}
        autoRan.current = true
        void (async () => {
          if (await restoreWindow()) return
          if (primaryCfg && primaryCfg.kind !== 'manual' && !primaryCfg.missing) void run(primaryCfg.id)
        })()
      }, [snap, active, primaryCfg, run, restoreWindow])

      return h('div', { className: 'gp-root' },
        useStyles(),
        h('div', { className: 'gp-chips' },
          chips.length ? chips : h('span', { className: 'gp-chip' }, '未检测到项目'),
          canCapture
            ? h('button', { className: 'gp-chip', disabled: winBusy, title: '把任意已运行的窗口接进舞台', onClick: () => void openPicker() }, '选择窗口')
            : null,
          snap?.root
            ? h('button', {
                className: 'gp-chip',
                disabled: winBusy,
                title: `${snap.root}（点击切换项目）`,
                onClick: () => void openRoots(),
              }, `📁 ${String(snap.root).split(/[\\/]/).filter(Boolean).pop() ?? snap.root} ▾`)
            : null,
          isWindow && active?.windowTitle
            ? h('span', { className: 'gp-chip gp-chip-window', title: active.windowTitle },
                `🪟 ${String(active.windowTitle).slice(0, 18)}`,
                h('button', {
                  className: 'gp-chip-x',
                  title: '停止抓帧',
                  onClick: () => void detachWindow(),
                }, '✕'))
            : null,
          h('span', { className: 'gp-spacer' }),
          h('span', { className: 'gp-dirty', title: dirty.length ? `待运行：${dirty.slice(0, 12).join('、')}${dirty.length > 12 ? ' …' : ''}` : '已同步' },
            dirty.length ? [h('span', { key: 'd', className: 'gp-dot' }), `${dirty.length}`] : '')),
        rootPicker,
        picker,
        !health.mode || error
          ? h('div', { className: 'gp-health' },
          health.mode
            ? `宿主 v${health.version ?? '?'} · ${
                health.mode === 'origin' ? '同源' : health.mode === 'bridge' ? `:${health.port}(iframe桥)` : ':' + health.port
              }${snap?.root ? ' · ' + snap.root : ''}`
            : (health.error ?? '正在连接宿主…'),
            h('button', { className: 'gp-btn', disabled: busy, onClick: () => void reconnect() }, '重新连接'))
          : null,
        error ? h('div', { className: 'gp-err' }, error) : null,
        !health.mode && health.attempts
          ? h('div', { className: 'gp-attempts' }, health.attempts.map((line, i) => h('div', { key: i }, line)))
          : null,
        blackHint
          ? h('div', { className: 'gp-hint' },
              blackHint,
              canCapture ? h('button', { className: 'gp-btn', style: { marginLeft: 8 }, onClick: () => void openPicker() }, '换一个窗口') : null)
          : null,
        stage,
        h('div', { className: 'gp-bar' },
          h('button', { className: 'gp-btn', 'data-primary': '1', disabled: busy || !configs.length, onClick: () => void run(active?.id) }, '▶ 运行'),
          h('button', { className: 'gp-btn', disabled: !url, title: '重新加载预览', onClick: () => setReloadKey((n) => n + 1) }, '⟳ 重载'),
          h('button', { className: 'gp-btn', disabled: busy || !snap?.root, title: '重新扫描这个项目的运行配置', onClick: () => void redetect() }, '🔄 检测'),
          h('button', { className: 'gp-btn', disabled: busy || (!snap?.running && !capture?.running), onClick: () => void stop() }, '⏹ 停止'),
          h('span', { className: 'gp-spacer' }),
          Object.entries(VIEWPORTS).map(([key, preset]) => h('button', {
            key,
            className: 'gp-btn',
            'data-primary': viewport === key ? '1' : '0',
            title: preset.width ? `${preset.width}×${preset.height}` : '铺满舞台',
            onClick: () => setViewport(key),
          }, preset.label)),
          isWindow
            ? h('button', {
                className: 'gp-btn',
                title: quality === 'sharp' ? '当前：原尺寸 + 高质量（更清晰，约 15–20fps）' : '当前：降采样 + 快速编码（更跟手，约 28–30fps）',
                disabled: busy,
                onClick: () => void switchQuality(quality === 'sharp' ? 'smooth' : 'sharp'),
              }, QUALITY[quality].label)
            : null,
          isWindow
            ? h('button', {
                className: 'gp-btn',
                'data-primary': pointerMode ? '1' : '0',
                title: pointerMode ? '正在转发鼠标/键盘（Esc 退出）' : '把鼠标和键盘转发给这个窗口，直接在面板里玩',
                onClick: () => setPointerMode((on) => !on),
              }, pointerMode ? '🖱 操作中' : '🖱 操作')
            : null,
          isWindow
            ? h('button', {
                className: 'gp-btn',
                'data-primary': crop.mode ? '1' : '0',
                title: crop.rect ? '重新框选显示区域' : '只显示窗口里的一块（比如 Unity 的 Game 视图）',
                onClick: () => setCrop({ mode: !crop.mode, rect: crop.rect }),
              }, '✂ 裁剪')
            : null,
          isWindow && crop.rect
            ? h('button', { className: 'gp-btn', title: '恢复整个窗口', onClick: () => saveCrop(null) }, '全窗')
            : null,
          isWindow
            ? h('button', { className: 'gp-btn', title: '把当前画面存成 JPG', onClick: () => void saveShot() }, '⤓ 截图')
            : null,
          h('button', { className: 'gp-btn', title: '隐藏所有控件，画面铺满', onClick: () => { setViewport('auto'); setImmersive(true) } }, '⛶ 满屏'),
          h('button', { className: 'gp-btn', disabled: !url, onClick: () => url && window.open(url, '_blank', 'noopener') }, '↗ 外部')),
      )
    }

    /* -------------------------------------------------------- open button */

    function OpenButton() {
      const open = useCallback(() => {
        try {
          const right = ctxRef && ctxRef.get?.('sidebarRight')
          if (right && typeof right.openTab === 'function') right.openTab(KIND)
        } catch {}
      }, [])
      return h('button', {
        type: 'button',
        title: '游戏预览',
        'aria-label': '游戏预览',
        onClick: open,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, border: 0, borderRadius: 7, background: 'transparent',
          color: 'inherit', cursor: 'pointer',
        },
      }, h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 2.5, y: 5.5, width: 19, height: 13, rx: 2.2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M10 10l4.5 2.5L10 15z', fill: 'currentColor' })))
    }

    /* --------------------------------------------------------- registration */

    let ctxRef = null

    return {
      inject: ['slots'],
      apply(ctx) {
        ctxRef = ctx
        ctx.inject(['sidebarRightTabs'], (inner) => {
          const tabs = inner.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return undefined
          const disposers = []
          try {
            disposers.push(tabs.register({
              id: ID,
              kind: KIND,
              title: () => '游戏预览',
              guide: [{
                order: 30,
                title: () => '游戏预览',
                description: () => '边写边玩，改完再跑',
              }],
            }))
            disposers.push(inner.slots.inject('sidebar.right.pane.tab', () =>
              inner.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, Panel)))
          } catch {
            for (const dispose of disposers) { try { dispose() } catch {} }
            return undefined
          }
          return () => { for (const dispose of disposers) { try { dispose() } catch {} } }
        })

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'game-preview-open', order: 40 }, OpenButton))
      },
    }
  },
})
