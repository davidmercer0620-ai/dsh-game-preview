/**
 * dsh-game-preview — Client half.
 *
 * A right-sidebar tab: run configurations on top, the game stage in the middle,
 * and a playtest bar at the bottom. Talks to the Host half over its loopback
 * control API (discovered by probing a small port range).
 */
window.__ModuleLoader__.load({
  id: 'dsh-game-preview',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const KIND = 'game-preview'
    const ID = 'dsh-game-preview'
    const PORTS = Array.from({ length: 16 }, (_, i) => 7317 + i)
    const WIDTHS = ['100%', '768px', '375px']

    let endpoint = null

    async function probe() {
      if (endpoint) return endpoint
      for (const port of PORTS) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/hello`, {
            headers: { 'x-game-preview': '1' },
          })
          if (!res.ok) continue
          const body = await res.json()
          if (body?.app === 'dsh-game-preview') {
            endpoint = `http://127.0.0.1:${port}`
            return endpoint
          }
        } catch {
          /* port closed, keep probing */
        }
      }
      return null
    }

    async function call(path, init = {}) {
      const base = await probe()
      if (!base) throw new Error('宿主未响应：预览服务没有启动')
      const res = await fetch(base + path, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-game-preview': '1', ...(init.headers ?? {}) },
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body
    }

    /* ------------------------------------------------------------ styles */

    const css = `
      .gp-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:inherit}
      .gp-chips{display:flex;gap:6px;padding:8px 10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent)}
      .gp-chip{border:1px solid color-mix(in srgb, currentColor 18%, transparent);background:transparent;color:inherit;
        border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer;white-space:nowrap}
      .gp-chip[data-on="1"]{background:color-mix(in srgb, currentColor 12%, transparent);border-color:color-mix(in srgb, currentColor 30%, transparent)}
      .gp-chip[data-dim="1"]{opacity:.45;cursor:not-allowed}
      .gp-stage{flex:1;min-height:0;display:flex;align-items:stretch;justify-content:center;background:color-mix(in srgb, currentColor 4%, transparent);overflow:hidden}
      .gp-frame{width:100%;height:100%;border:0;background:#000;display:block}
      .gp-frame[data-narrow="1"]{margin:8px 0;border-radius:10px;box-shadow:0 0 0 1px color-mix(in srgb, currentColor 18%, transparent);height:calc(100% - 16px)}
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
      .gp-note{font-size:11px;opacity:.6;max-width:420px;line-height:1.6}
      .gp-err{color:#d9534f;font-size:11px;padding:6px 10px}
    `

    function useStyles() {
      // returns a style element rendered inside the panel so unmounting removes it
      return h('style', { 'data-game-preview': '1' }, css)
    }

    /* ------------------------------------------------------------- panel */

    function Panel() {
      const [snap, setSnap] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [reloadKey, setReloadKey] = useState(0)
      const [width, setWidth] = useState(0)
      const [manualRoot, setManualRoot] = useState('')
      const [manualUrl, setManualUrl] = useState('')
      const alive = useRef(true)

      const refresh = useCallback(async () => {
        try {
          const next = await call('/api/state')
          if (alive.current) {
            setSnap(next)
            setError(null)
          }
        } catch (err) {
          if (alive.current) setError(String(err?.message ?? err))
        }
      }, [])

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

      const configs = snap?.configs ?? []
      const active = snap?.active ?? null
      const dirty = snap?.dirty ?? []
      const url = active?.url ?? null

      const chips = configs.map((cfg) => {
        const dim = cfg.kind === 'native'
        return h('button', {
          key: cfg.id,
          className: 'gp-chip',
          'data-on': active?.id === cfg.id ? '1' : '0',
          'data-dim': dim ? '1' : '0',
          title: dim ? `${cfg.detail ?? ''}` : (cfg.url ?? cfg.detail ?? ''),
          onClick: () => { if (!dim) void run(cfg.id) },
        }, cfg.title)
      })

      const empty = !url
        ? h('div', { className: 'gp-empty' },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '还没有运行中的预览'),
            h('div', { className: 'gp-note' },
              snap?.root
                ? '点上方配置启动；或者在对话里让 agent 调用 game_preview_run。'
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

      return h('div', { className: 'gp-root' },
        useStyles(),
        h('div', { className: 'gp-chips' },
          chips.length ? chips : h('span', { className: 'gp-chip' }, '未检测到项目'),
          h('span', { className: 'gp-spacer' }),
          h('span', { className: 'gp-dirty' },
            dirty.length ? [h('span', { key: 'd', className: 'gp-dot' }), `${dirty.length} 处改动待运行`] : '已同步')),
        error ? h('div', { className: 'gp-err' }, error) : null,
        h('div', { className: 'gp-stage' },
          url
            ? h('iframe', {
                key: `${url}#${reloadKey}#${width}`,
                className: 'gp-frame',
                src: url,
                'data-narrow': width > 0 ? '1' : '0',
                style: width > 0 ? { width: WIDTHS[width], maxWidth: '100%' } : undefined,
                title: 'game preview',
                allow: 'autoplay; fullscreen; gamepad',
              })
            : empty),
        h('div', { className: 'gp-bar' },
          h('button', { className: 'gp-btn', 'data-primary': '1', disabled: busy || !configs.length, onClick: () => void run(active?.id) }, '▶ 运行'),
          h('button', { className: 'gp-btn', disabled: !url, onClick: () => setReloadKey((n) => n + 1) }, '⟳ 重载'),
          h('button', { className: 'gp-btn', disabled: busy || !snap?.running, onClick: () => void stop() }, '⏹ 停止'),
          h('span', { className: 'gp-spacer' }),
          h('button', { className: 'gp-btn', disabled: !url, onClick: () => setWidth((w) => (w + 1) % WIDTHS.length) }, WIDTHS[width]),
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
