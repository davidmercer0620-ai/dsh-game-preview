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

    async function httpJson(url, init = {}) {
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
        attempts: notes.slice(0, 8),
      }
      return null
    }

    async function call(path, init = {}) {
      const base = await probe()
      if (!base) throw new Error(health.error ?? '宿主未响应：预览服务没有启动')
      // call sites use the loopback shape ('/api/state'); a same-origin base
      // already ends in /api/game-preview, so drop the duplicated prefix
      const rel = path.startsWith('/api/') ? path.slice('/api'.length) : path
      return httpJson(base + rel, init)
    }

    /* ------------------------------------------------------------ styles */

    const css = `
      .gp-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:inherit}
      .gp-chips{display:flex;gap:6px;padding:8px 10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent)}
      .gp-chip{border:1px solid color-mix(in srgb, currentColor 18%, transparent);background:transparent;color:inherit;
        border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer;white-space:nowrap}
      .gp-chip[data-on="1"]{background:color-mix(in srgb, currentColor 12%, transparent);border-color:color-mix(in srgb, currentColor 30%, transparent)}
      .gp-chip[data-dim="1"]{opacity:.45;cursor:not-allowed}
      .gp-stage{position:relative;flex:1;min-height:0;display:flex;align-items:stretch;justify-content:center;background:color-mix(in srgb, currentColor 4%, transparent);overflow:hidden}
      .gp-vp{display:flex;align-items:center;justify-content:center;width:100%;height:100%;padding:10px;box-sizing:border-box;min-height:0}
      .gp-vp[data-vp="pc"] .gp-frame{height:100%;width:auto;aspect-ratio:16 / 9;max-width:100%;border-radius:8px;box-shadow:0 0 0 1px color-mix(in srgb, currentColor 18%, transparent)}
      .gp-vp[data-vp="mobile"] .gp-frame{width:min(100%,390px);height:auto;aspect-ratio:390 / 844;max-height:100%;border-radius:18px;box-shadow:0 0 0 1px color-mix(in srgb, currentColor 22%, transparent), 0 10px 30px rgba(0,0,0,.35)}
      .gp-vp[data-vp="pc"] .gp-shot,.gp-vp[data-vp="mobile"] .gp-shot{border-radius:8px}
      .gp-frame{width:100%;height:100%;border:0;background:#000;display:block}
      .gp-shot{width:100%;height:100%;object-fit:contain;background:#000;display:block;image-rendering:auto}
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
      .gp-health{display:flex;align-items:flex-start;gap:6px;justify-content:space-between;font-size:10px;opacity:.6;
        padding:4px 10px;border-bottom:1px solid color-mix(in srgb, currentColor 8%, transparent);word-break:break-all;line-height:1.5}
      .gp-hint{color:#c8892f;font-size:11px;padding:6px 10px}
      .gp-picker{display:flex;gap:6px;padding:6px 10px;align-items:center;border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent)}
    `

    function useStyles() {
      // returns a style element rendered inside the panel so unmounting removes it
      return h('style', { 'data-game-preview': '1' }, css)
    }

    /* ------------------------------------------------------- window stage */

    /**
     * Native windows arrive either as one MJPEG <img> (loopback) or as polled
     * JPEG bytes (same-origin, where <img> cannot reach the control API).
     */
    function WindowStage({ mode, fallbackUrl, reloadKey, alt, onError }) {
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
      return h('img', { className: 'gp-shot', src: src ?? undefined, alt: alt ?? 'game window', onError })
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
      }, [manualUrl])

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
          const next = await call('/api/window/attach', { method: 'POST', body: JSON.stringify({ hwnd }) })
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
      const canCapture = capture?.supported !== false

      const chips = configs.map((cfg) => {
        const dim = cfg.kind === 'native' && !canCapture
        return h('button', {
          key: cfg.id,
          className: 'gp-chip',
          'data-on': active?.id === cfg.id ? '1' : '0',
          'data-dim': dim ? '1' : '0',
          title: dim ? '窗口捕获只支持 Windows' : (cfg.url ?? cfg.detail ?? ''),
          onClick: () => { if (!dim) void run(cfg.id) },
        }, cfg.title)
      })

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
        liveBadges.push(h('span', { key: 'fps', 'data-warn': capture?.fps && capture.fps < 5 ? '1' : '0' },
          capture?.fps ? `${capture.fps} fps` : '连接中'))
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
              h('div', { className: 'gp-vp', 'data-vp': viewport },
                h(WindowStage, {
                  key: `${url}#${reloadKey}`,
                  mode: health.mode,
                  fallbackUrl: url,
                  reloadKey,
                  alt: active?.windowTitle ?? 'game window',
                  onError: () => setError('画面流断了：点 ⟳ 重载重新连接'),
                })),
              liveBadges.length ? h('div', { className: 'gp-live' }, liveBadges) : null)
          : h('div', { className: 'gp-stage' },
              h('div', { className: 'gp-vp', 'data-vp': viewport },
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
                title: snap.root,
                onClick: () => void openRoots(),
              }, `📁 ${String(snap.root).split(/[\\/]/).filter(Boolean).pop() ?? snap.root} ▾`)
            : null,
          h('span', { className: 'gp-spacer' }),
          h('span', { className: 'gp-dirty' },
            dirty.length ? [h('span', { key: 'd', className: 'gp-dot' }), `${dirty.length} 处改动待运行`] : '已同步')),
        rootPicker,
        picker,
        h('div', { className: 'gp-health' },
          health.mode
            ? `宿主 v${health.version ?? '?'} · ${health.mode === 'origin' ? '同源' : ':' + health.port}${transport === 'xhr' ? '(xhr)' : ''}${snap?.root ? ' · ' + snap.root : ''}`
            : (health.error ?? '正在连接宿主…'),
          h('button', { className: 'gp-btn', disabled: busy, onClick: () => void reconnect() }, '重新连接')),
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
          h('button', { className: 'gp-btn', disabled: !url, onClick: () => setReloadKey((n) => n + 1) }, '⟳ 重载'),
          h('button', { className: 'gp-btn', disabled: busy || (!snap?.running && !capture?.running), onClick: () => void stop() }, '⏹ 停止'),
          h('span', { className: 'gp-spacer' }),
          Object.entries(VIEWPORTS).map(([key, preset]) => h('button', {
            key,
            className: 'gp-btn',
            'data-primary': viewport === key ? '1' : '0',
            title: preset.width ? `${preset.width}×${preset.height}` : '铺满舞台',
            onClick: () => setViewport(key),
          }, preset.label)),
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
