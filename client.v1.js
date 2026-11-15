// cross-workspace client v1.0 rewrite — single top-level `view`, explicit handlers.
// Browser half only: no bundler, no JSX, no Harness client imports. Host contract
// (tools, actions, store v2, delivery semantics) is unchanged; this file only
// renders state and calls the existing management API.

window.__ModuleLoader__.load({
  id: 'dsh-cross-workspace',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API_PATH = '/plugins/dsh-cross-workspace/api'
    const API_HEADERS = { 'content-type': 'application/json', 'x-dsh-cross-workspace': '1' }
    const LIMIT = 300
    const POLL_MS = 4000
    const BUILD_STAMP = '1.0.0-rewrite 7d24f28'

    async function apiCall(action, payload, signal) {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this shell')
      const options = {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: API_HEADERS,
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      }
      if (signal) options.signal = signal
      const response = await fetch(API_PATH, options)
      let body = null
      try { body = await response.json() } catch (error) {
        const failure = new Error('HTTP ' + response.status)
        failure.status = response.status
        throw failure
      }
      if (!response.ok || !body || body.ok !== true) {
        const info = body && body.error ? body.error : null
        const failure = new Error(info && info.message ? String(info.message) : 'HTTP ' + response.status)
        failure.code = info && info.code ? info.code : ''
        failure.status = response.status
        throw failure
      }
      return body.value
    }

    function getService(ctx, name) {
      if (!ctx || typeof ctx.get !== 'function') return undefined
      try { return ctx.get(name) } catch (error) { return undefined }
    }

    function isZhLocale(ctx) {
      try {
        const snapshot = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
        const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
        return active.toLowerCase().indexOf('zh') === 0
      } catch (error) { return false }
    }

    function useLocaleActive(ctx) {
      const subscribe = React.useCallback(function (listener) {
        const locale = ctx ? ctx.locale : null
        if (!locale || typeof locale.subscribe !== 'function') return function () {}
        const off = locale.subscribe(listener)
        return typeof off === 'function' ? off : function () {}
      }, [ctx])
      const getSnapshot = React.useCallback(function () {
        try {
          const snapshot = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
          return snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
        } catch (error) { return '' }
      }, [ctx])
      const active = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return typeof active === 'string' ? active : ''
    }

    function useText(ctx) {
      const active = useLocaleActive(ctx)
      return React.useMemo(function () {
        const zh = String(active || '').toLowerCase().indexOf('zh') === 0
        return function (zhText, enText) { return zh ? zhText : enText }
      }, [active])
    }

    function useApi(runtime) {
      const controllers = React.useRef(new Set())
      React.useEffect(function () {
        return function () {
          controllers.current.forEach(function (controller) {
            try { controller.abort() } catch (error) {}
            if (runtime && runtime.controllers) runtime.controllers.delete(controller)
          })
          controllers.current.clear()
        }
      }, [runtime])
      return React.useCallback(function (action, payload) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        if (controller) {
          controllers.current.add(controller)
          if (runtime && runtime.controllers) runtime.controllers.add(controller)
        }
        return (controller ? apiCall(action, payload, controller.signal) : apiCall(action, payload))
          .finally(function () {
            if (!controller) return
            controllers.current.delete(controller)
            if (runtime && runtime.controllers) runtime.controllers.delete(controller)
          })
      }, [runtime])
    }

    function useSessionsSnapshot(props) {
      const supplied = props && typeof props.useSessions === 'function' ? props.useSessions : null
      const fallback = React.useCallback(function () { return null }, [])
      const useStore = supplied || fallback
      return useStore(function (snapshot) { return snapshot })
    }

    function useUiWorkspaceSessionId(ctx) {
      const subscribe = React.useCallback(function (listener) {
        const service = getService(ctx, 'uiWorkspace')
        const selection = service ? service.selection : null
        if (!selection || typeof selection.subscribe !== 'function') return function () {}
        const off = selection.subscribe(listener)
        return typeof off === 'function' ? off : function () {}
      }, [ctx])
      const getSnapshot = React.useCallback(function () {
        const service = getService(ctx, 'uiWorkspace')
        const selection = service ? service.selection : null
        if (!selection || typeof selection.getSnapshot !== 'function') return ''
        try {
          const snapshot = selection.getSnapshot()
          return snapshot && typeof snapshot.sessionId === 'string' ? snapshot.sessionId : ''
        } catch (error) { return '' }
      }, [ctx])
      const value = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return typeof value === 'string' && value ? value : null
    }

    function sessionIdFromSessions(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return null
      const current = snapshot.current
      if (typeof current === 'string' && current) return current
      if (current && typeof current === 'object') {
        if (typeof current.sessionId === 'string' && current.sessionId) return current.sessionId
        if (typeof current.id === 'string' && current.id) return current.id
      }
      return null
    }

    function viewerPayload(sessionId, data) {
      const viewer = data && data.viewer && typeof data.viewer === 'object' ? data.viewer : null
      const payload = {}
      const id = sessionId || (viewer && typeof viewer.sessionId === 'string' ? viewer.sessionId : '')
      if (id) payload.sessionId = id
      if (viewer && typeof viewer.workspacePath === 'string' && viewer.workspacePath) payload.workspacePath = viewer.workspacePath
      return payload
    }

    function isAbortError(error) {
      return !!error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
    }
    function errorMessage(error, t) {
      if (!error) return t('未知错误', 'Unknown error')
      if (typeof error.message === 'string' && error.message) return error.message
      return String(error)
    }
    function basename(path) {
      if (typeof path !== 'string' || !path) return ''
      const parts = path.split(/[\\/]+/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : path
    }
    function clip(value, max) {
      const text = value == null ? '' : String(value)
      return text.length > max ? text.slice(0, max - 1) + '…' : text
    }
    function partyLabel(party, t) {
      if (!party || typeof party !== 'object') return t('未知', 'Unknown')
      if (party.groupName || party.groupId) return party.groupName || party.groupId
      return party.sessionTitle || party.workspaceTitle || party.sessionId || party.workspacePath || t('未知', 'Unknown')
    }
    function subjectOf(mail, t) {
      return mail && typeof mail.subject === 'string' && mail.subject.trim() ? mail.subject.trim() : t('（无主题）', '(no subject)')
    }
    function statusLabel(delivery, t) {
      const mode = delivery && typeof delivery.mode === 'string' ? delivery.mode : 'none'
      if (mode === 'wake') return t('已投递', 'Delivered')
      if (mode === 'queued') return t('排队', 'Queued')
      if (mode === 'failed') return t('失败', 'Failed')
      if (mode === 'mailbox') return t('信箱', 'Mailbox')
      return t('无目标', 'None')
    }
    function statusTone(delivery) {
      const mode = delivery && delivery.mode
      if (mode === 'wake') return 'ok'
      if (mode === 'queued') return 'warn'
      if (mode === 'failed') return 'bad'
      if (mode === 'mailbox') return 'mail'
      return 'none'
    }
    function canRetry(delivery) {
      return !!delivery && delivery.mode === 'failed' && (typeof delivery.attempts !== 'number' || delivery.attempts < 5)
    }
    function timeLabel(ts, now, t) {
      if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return ''
      const diff = Math.max(0, (now || Date.now()) - ts)
      if (diff < 60000) return t('刚刚', 'just now')
      if (diff < 3600000) return Math.floor(diff / 60000) + t(' 分钟前', ' min ago')
      if (diff < 86400000) return Math.floor(diff / 3600000) + t(' 小时前', ' h ago')
      try { return new Date(ts).toLocaleString() } catch (error) { return '' }
    }
    function rangeTotals(days, range) {
      const slice = Array.isArray(days) ? days.slice(-range) : []
      const out = { sent: 0, received: 0, delivered: 0, queued: 0, failed: 0, mailbox: 0, none: 0, total: 0 }
      slice.forEach(function (day) {
        out.sent += day.sent || 0
        out.received += day.received || 0
        out.delivered += day.delivered || 0
        out.queued += day.queued || 0
        out.failed += day.failed || 0
        out.mailbox += day.mailbox || 0
        out.none += day.none || 0
      })
      out.total = out.delivered + out.queued + out.failed + out.mailbox + out.none
      return out
    }

    // ---------------------------------------------------------------------------
    // CSS — dark default, light via [data-theme=light]; project accent teal.
    // ---------------------------------------------------------------------------
    const CSS = `
.dshcw-v1{--cw-bg:#0B1220;--cw-card:#121B2B;--cw-text:#E5EDF7;--cw-muted:#8FA1B8;--cw-border:#24324A;--cw-soft:#1A2638;--cw-accent:#00A2BD;--cw-on-accent:#061016;--cw-ink:#7DD8E8;--cw-soft-accent:rgba(79,195,217,.14);--cw-2:#7FB2FF;--cw-ok:#4ADE80;--cw-warn:#FBBF24;--cw-bad:#F87171;--cw-mail:#9CA3AF;--cw-none:#9CA3AF;color-scheme:dark;height:100%;min-height:0;display:flex;flex-direction:column;gap:12px;padding:14px 14px calc(14px + env(safe-area-inset-bottom));box-sizing:border-box;background:var(--cw-bg);color:var(--cw-text);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.dshcw-v1[data-theme="light"]{--cw-bg:#F5F7FA;--cw-card:#FFFFFF;--cw-text:#111827;--cw-muted:#6B7280;--cw-border:#E2E8F0;--cw-soft:#F1F5F9;--cw-accent:#00A2BD;--cw-on-accent:#0B1A1F;--cw-ink:#006B7D;--cw-soft-accent:#E6F7FA;--cw-2:#3B82F6;--cw-ok:#15803D;--cw-warn:#B45309;--cw-bad:#B91C1C;--cw-mail:#2563EB;--cw-none:#6B7280;color-scheme:light}
.dshcw-v1 *{box-sizing:border-box}
.dshcw-v1 button,.dshcw-v1 input,.dshcw-v1 select,.dshcw-v1 textarea{font:inherit;color:inherit}
.dshcw-v1 button{cursor:pointer}
.dshcw-v1 .cw-top{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:nowrap}
.dshcw-v1 .cw-title{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.dshcw-v1 .cw-title h1{margin:0;font-size:20px;line-height:26px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshcw-v1 .cw-stamp{font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--cw-ink);border:1px solid var(--cw-accent);border-radius:999px;padding:2px 8px;white-space:nowrap}
.dshcw-v1 .cw-scope{font-size:10px;color:var(--cw-muted);white-space:nowrap}
.dshcw-v1 .cw-actions{display:flex;align-items:center;gap:8px;flex:none;min-width:0}
.dshcw-v1 .cw-btn{min-height:32px;border:1px solid var(--cw-border);border-radius:10px;background:var(--cw-card);padding:0 11px;font-size:12px;color:var(--cw-text)}
.dshcw-v1 .cw-btn:hover{border-color:var(--cw-accent)}
.dshcw-v1 .cw-btn.primary{background:var(--cw-accent);border-color:var(--cw-accent);color:var(--cw-on-accent);font-weight:600}
.dshcw-v1 .cw-btn.ghost{border-color:transparent;background:transparent;color:var(--cw-muted)}
.dshcw-v1 .cw-input{min-height:32px;border:1px solid var(--cw-border);border-radius:10px;background:var(--cw-card);padding:0 10px;font-size:12px;min-width:0;color:var(--cw-text)}
.dshcw-v1 .cw-seg{display:inline-flex;border:1px solid var(--cw-border);border-radius:10px;overflow:hidden}
.dshcw-v1 .cw-seg button{min-height:28px;border:0;border-radius:0;background:transparent;padding:0 8px;font-size:11px;color:var(--cw-muted)}
.dshcw-v1 .cw-seg button.on{background:var(--cw-soft-accent);color:var(--cw-ink);font-weight:600}
.dshcw-v1 .cw-icon{width:32px;height:32px;border:1px solid var(--cw-border);border-radius:10px;background:var(--cw-card);padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:14px;color:var(--cw-muted)}
.dshcw-v1 .cw-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;overflow:auto}
.dshcw-v1 .cw-dash{display:flex;flex-direction:column;gap:12px;min-width:0}
.dshcw-v1 .cw-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.dshcw-v1 .cw-kpi{display:flex;flex-direction:column;gap:4px;padding:16px;border:1px solid var(--cw-border);border-radius:20px;background:var(--cw-card);text-align:left;min-width:0;color:var(--cw-text)}
.dshcw-v1 .cw-kpi.click:hover{border-color:var(--cw-accent)}
.dshcw-v1 .cw-kpi .l{font-size:11px;color:var(--cw-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshcw-v1 .cw-kpi strong{font-size:24px;line-height:30px;font-weight:700;font-variant-numeric:tabular-nums}
.dshcw-v1 .cw-kpi .h{font-size:10px;color:var(--cw-muted)}
.dshcw-v1 .cw-kpi.accent strong{color:var(--cw-ink)}.dshcw-v1 .cw-kpi.danger strong{color:var(--cw-bad)}
.dshcw-v1 .cw-grid2{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:12px;min-width:0}
.dshcw-v1 .cw-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;min-width:0}
.dshcw-v1 .cw-card{border:1px solid var(--cw-border);border-radius:20px;background:var(--cw-card);padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0;overflow:hidden}
.dshcw-v1 .cw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.dshcw-v1 .cw-head h2{margin:0;font-size:13px;line-height:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshcw-v1 .cw-head span,.dshcw-v1 .cw-head .cw-link{font-size:10px;color:var(--cw-muted)}
.dshcw-v1 .cw-link{border:0;background:transparent;color:var(--cw-ink);font-size:11px;padding:0;white-space:nowrap}
.dshcw-v1 .cw-bars{display:flex;align-items:flex-end;gap:8px;height:180px;min-height:180px;padding-top:4px}
.dshcw-v1 .cw-bar{flex:1;height:100%;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}
.dshcw-v1 .cw-bar-pair{flex:1;display:flex;align-items:flex-end;gap:2px;width:100%;min-height:0}
.dshcw-v1 .cw-bar-pair i{flex:1;display:block;border-radius:3px 3px 0 0;min-height:2px;transform-origin:bottom;animation:cwBar 240ms ease-out both}
.dshcw-v1 .cw-recv{background:var(--cw-accent)}.dshcw-v1 .cw-sent{background:var(--cw-2)}
.dshcw-v1 .cw-bar b{font-size:10px;color:var(--cw-muted);font-weight:400}.dshcw-v1 .cw-bar em{font-size:10px;font-style:normal;font-variant-numeric:tabular-nums}
.dshcw-v1 .cw-donut-wrap{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.dshcw-v1 .cw-donut{width:150px;height:150px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;position:relative;animation:cwFade 240ms ease-out both}
.dshcw-v1 .cw-donut:after{content:"";position:absolute;inset:20px;border-radius:50%;background:var(--cw-card)}
.dshcw-v1 .cw-donut div{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center}
.dshcw-v1 .cw-donut strong{font-size:18px;font-variant-numeric:tabular-nums}.dshcw-v1 .cw-donut span{font-size:10px;color:var(--cw-muted)}
.dshcw-v1 .cw-legend{display:grid;gap:5px;flex:1;min-width:0}
.dshcw-v1 .cw-legend div{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--cw-muted);min-width:0}
.dshcw-v1 .cw-legend i{width:8px;height:8px;border-radius:2px;flex:none}.dshcw-v1 .cw-legend b{margin-left:auto;color:var(--cw-text);font-variant-numeric:tabular-nums}
.dshcw-v1 .cw-row{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 4px;border:0;border-radius:8px;background:transparent;color:var(--cw-muted);text-align:left;font-size:11px;min-width:0}
.dshcw-v1 .cw-row:hover{background:var(--cw-soft);color:var(--cw-text)}.dshcw-v1 .cw-row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcw-v1 .cw-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dshcw-v1 .cw-stats div{display:flex;flex-direction:column;gap:1px;padding:8px;border-radius:12px;background:var(--cw-soft);min-width:0}
.dshcw-v1 .cw-stats strong{font-size:16px;font-variant-numeric:tabular-nums}.dshcw-v1 .cw-stats span{font-size:10px;color:var(--cw-muted)}
.dshcw-v1 .cw-table{display:flex;flex-direction:column;min-width:0}
.dshcw-v1 .cw-tr{display:grid;grid-template-columns:74px minmax(90px,1fr) minmax(120px,2.4fr) 88px 56px;align-items:center;gap:8px;min-height:40px;border-bottom:1px solid var(--cw-border);font-size:11px;min-width:0}
.dshcw-v1 .cw-th{min-height:26px;font-size:10px;color:var(--cw-muted)}
.dshcw-v1 .cw-subject{min-width:0;border:0;background:transparent;color:var(--cw-text);text-align:left;padding:0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshcw-v1 .cw-pill{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 7px;font-size:10px;background:var(--cw-soft);white-space:nowrap}
.dshcw-v1 .cw-dot{width:6px;height:6px;border-radius:50%;background:var(--cw-none)}.dshcw-v1 .cw-dot.ok{background:var(--cw-ok)}.dshcw-v1 .cw-dot.warn{background:var(--cw-warn)}.dshcw-v1 .cw-dot.bad{background:var(--cw-bad)}.dshcw-v1 .cw-dot.mail{background:var(--cw-mail)}
.dshcw-v1 .cw-list{display:flex;flex-direction:column;gap:8px}
.dshcw-v1 .cw-list .cw-row{border:1px solid var(--cw-border);background:var(--cw-card);border-radius:12px;padding:10px 12px;min-height:46px;color:var(--cw-text)}
.dshcw-v1 .cw-list small{display:block;font-size:10px;color:var(--cw-muted)}
.dshcw-v1 .cw-empty{border:1px dashed var(--cw-border);border-radius:12px;padding:18px;color:var(--cw-muted);font-size:12px}
.dshcw-v1 .cw-notice{border:1px solid var(--cw-accent);border-radius:12px;background:var(--cw-soft-accent);color:var(--cw-ink);padding:8px 10px;font-size:12px}
.dshcw-v1 .cw-error{border:1px solid var(--cw-bad);border-radius:12px;color:var(--cw-bad);padding:8px 10px;font-size:12px}
.dshcw-v1 .cw-subhead{display:flex;align-items:center;gap:8px;min-width:0}
.dshcw-v1 .cw-subhead h2{margin:0;font-size:16px;flex:1}
.dshcw-v1 .cw-detail{border:1px solid var(--cw-border);border-radius:12px;background:var(--cw-card);padding:16px;display:flex;flex-direction:column;gap:10px}
.dshcw-v1 .cw-detail h2{margin:0;font-size:16px}.dshcw-v1 .cw-detail p{margin:0;white-space:pre-wrap;color:var(--cw-muted)}
.dshcw-v1 .cw-overlay{position:fixed;inset:0;z-index:60;background:rgba(2,6,23,.52);display:flex;align-items:flex-end;justify-content:center;padding:20px}
.dshcw-v1 .cw-sheet{width:min(440px,100%);max-height:78vh;overflow:auto;background:var(--cw-card);border:1px solid var(--cw-border);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:10px;animation:cwSheet 180ms ease-out both}
.dshcw-v1 .cw-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--cw-muted)}
.dshcw-v1 .cw-field input,.dshcw-v1 .cw-field select,.dshcw-v1 .cw-field textarea{min-height:36px;border:1px solid var(--cw-border);border-radius:10px;background:var(--cw-bg);color:var(--cw-text);padding:8px 10px;font-size:12px}
.dshcw-v1 .cw-field textarea{min-height:110px;resize:vertical}
.dshcw-v1 .cw-sheet-actions{display:flex;justify-content:flex-end;gap:8px}
.dshcw-v1 .cw-menu{position:absolute;right:0;top:38px;z-index:40;width:150px;padding:4px;border:1px solid var(--cw-border);border-radius:10px;background:var(--cw-card);display:grid;gap:1px}
.dshcw-v1 .cw-menu button{min-height:30px;border:0;border-radius:7px;background:transparent;color:var(--cw-text);text-align:left;padding:0 9px;font-size:12px}
.dshcw-v1 .cw-menu button:hover{background:var(--cw-soft)}
.dshcw-v1 .cw-log{font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--cw-muted);border-top:1px solid var(--cw-border);padding-top:6px;max-height:70px;overflow:auto;flex:none}
.dshcw-v1 .cw-graph{position:relative;min-height:260px;border:1px solid var(--cw-border);border-radius:12px;background:var(--cw-card);overflow:hidden}
.dshcw-v1 .cw-graph svg{position:absolute;inset:0;width:100%;height:100%}
.dshcw-v1 .cw-node{position:absolute;transform:translate(-50%,-50%);border:1px solid var(--cw-border);border-radius:999px;background:var(--cw-card);padding:6px 10px;font-size:11px;color:var(--cw-text)}
.dshcw-v1 .cw-node.main{border-color:var(--cw-accent);color:var(--cw-ink)}
.dshcw-v1 .cw-view{display:flex;flex-direction:column;gap:12px;min-width:0;animation:cwView 140ms ease-out both}
.dshcw-v1 .cw-kpis .cw-kpi{animation:cwKpi 170ms ease-out both}
.dshcw-v1 .cw-kpis .cw-kpi:nth-child(1){animation-delay:0ms}.dshcw-v1 .cw-kpis .cw-kpi:nth-child(2){animation-delay:18ms}.dshcw-v1 .cw-kpis .cw-kpi:nth-child(3){animation-delay:36ms}.dshcw-v1 .cw-kpis .cw-kpi:nth-child(4){animation-delay:54ms}.dshcw-v1 .cw-kpis .cw-kpi:nth-child(5){animation-delay:72ms}.dshcw-v1 .cw-kpis .cw-kpi:nth-child(6){animation-delay:90ms}
.dshcw-v1 .cw-table .cw-tr:not(.cw-th){animation:cwRow 100ms ease-out both}
.dshcw-v1 .cw-table .cw-tr:nth-child(2){animation-delay:0ms}.dshcw-v1 .cw-table .cw-tr:nth-child(3){animation-delay:12ms}.dshcw-v1 .cw-table .cw-tr:nth-child(4){animation-delay:24ms}.dshcw-v1 .cw-table .cw-tr:nth-child(5){animation-delay:36ms}.dshcw-v1 .cw-table .cw-tr:nth-child(6){animation-delay:48ms}.dshcw-v1 .cw-table .cw-tr:nth-child(7){animation-delay:60ms}.dshcw-v1 .cw-table .cw-tr:nth-child(8){animation-delay:72ms}.dshcw-v1 .cw-table .cw-tr:nth-child(9){animation-delay:84ms}
@keyframes cwView{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes cwKpi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes cwBar{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes cwFade{from{opacity:.35}to{opacity:1}}
@keyframes cwRow{from{opacity:0}to{opacity:1}}
@keyframes cwSheet{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.dshcw-v1 button:focus-visible,.dshcw-v1 input:focus-visible,.dshcw-v1 select:focus-visible,.dshcw-v1 textarea:focus-visible{outline:2px solid var(--cw-ink);outline-offset:2px}
@media(max-width:1100px){.dshcw-v1 .cw-scope{display:none}.dshcw-v1 .cw-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.dshcw-v1 .cw-grid2,.dshcw-v1 .cw-grid3{grid-template-columns:minmax(0,1fr)}}
@media(max-width:860px){.dshcw-v1 .cw-top{flex-wrap:wrap}.dshcw-v1 .cw-actions{width:100%;flex-wrap:wrap}.dshcw-v1 .cw-actions .cw-input{flex:1 1 140px;width:100%}.dshcw-v1 .cw-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.dshcw-v1 .cw-kpi:nth-child(n+5){display:none}.dshcw-v1 .cw-tr{grid-template-columns:1fr auto;gap:3px 8px;padding:8px 0}.dshcw-v1 .cw-th{display:none}.dshcw-v1 .cw-tr > span:nth-child(1){grid-column:1;font-size:10px}.dshcw-v1 .cw-tr > span:nth-child(4){grid-column:2;grid-row:1}.dshcw-v1 .cw-tr > span:nth-child(2){grid-column:1}.dshcw-v1 .cw-tr > span:nth-child(5){grid-column:2;grid-row:2}.dshcw-v1 .cw-subject{grid-column:1/-1;white-space:normal;overflow-wrap:anywhere}}
@media(prefers-reduced-motion:reduce){.dshcw-v1 *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`

    function Styles() { return h('style', null, CSS) }

    function Button(props) {
      const variant = props.variant || 'default'
      return h('button', {
        type: 'button',
        className: 'cw-btn' + (variant === 'primary' ? ' primary' : variant === 'ghost' ? ' ghost' : ''),
        onClick: props.onClick,
        disabled: props.disabled,
        title: props.title,
        'aria-label': props.label,
        ref: props.buttonRef,
      }, props.children)
    }

    function Kpi(props) {
      const Tag = props.onClick ? 'button' : 'div'
      return h(Tag, {
        type: props.onClick ? 'button' : undefined,
        className: 'cw-kpi' + (props.onClick ? ' click' : '') + (props.tone ? ' ' + props.tone : ''),
        onClick: props.onClick,
        key: props.k,
      },
        h('span', { className: 'l' }, props.label),
        h('strong', null, String(props.value)),
        props.hint ? h('span', { className: 'h' }, props.hint) : null)
    }

    function StatusPill(props) {
      return h('span', { className: 'cw-pill' },
        h('i', { className: 'cw-dot ' + props.tone }),
        props.label)
    }

    function Empty(props) {
      return h('div', { className: 'cw-empty' }, props.children)
    }

    // ---------------------------------------------------------------------------
    // Dashboard / messages / groups / workspaces / graph / settings / compose
    // ---------------------------------------------------------------------------

    function buildStatePayload(viewerSessionId, mySessionId, scopeWorkspacePath, scopeGroupId, limit, showAll) {
      const scoped = !!(scopeWorkspacePath || scopeGroupId)
      const management = scoped || showAll === true
      const payload = { limit: limit, filter: management ? 'all' : (viewerSessionId ? 'inbox' : 'all') }
      if (!management && viewerSessionId) payload.sessionId = viewerSessionId
      else if (!management && mySessionId) payload.sessionId = mySessionId
      if (scopeWorkspacePath) payload.workspacePathFilter = scopeWorkspacePath
      if (scopeGroupId) payload.groupIdFilter = scopeGroupId
      return payload
    }

    function stateSignature(value) {
      if (!value || typeof value !== 'object') return ''
      const messages = Array.isArray(value.messages) ? value.messages.map(function (mail) {
        return [mail.id, mail.read === true, mail.editedAt || 0, mail.delivery && mail.delivery.mode, mail.delivery && mail.delivery.attempts]
      }) : []
      const groups = Array.isArray(value.groups) ? value.groups.map(function (group) { return [group.id, group.name, group.unread, group.memberCount] }) : []
      const workspaces = Array.isArray(value.workspaces) ? value.workspaces.map(function (workspace) { return [workspace.path, workspace.title, workspace.unread] }) : []
      return JSON.stringify({ viewer: value.viewer, stats: value.stats, messages: messages, groups: groups, workspaces: workspaces })
    }

    function DashboardView(props) {
      const t = props.t
      const stats = props.stats
      const messages = props.messages || []
      const groups = props.groups || []
      const workspaces = props.workspaces || []
      const totals = stats ? rangeTotals(stats.days, props.range) : { sent: 0, received: 0, delivered: 0, queued: 0, failed: 0, mailbox: 0, none: 0, total: 0 }
      const success = totals.total > 0 ? Math.round(totals.delivered / totals.total * 100) : null
      const rangeLabel = props.range === 1 ? t('今日', 'Today') : props.range === 30 ? t('近30天', '30 days') : t('近7天', '7 days')
      const query = props.search.trim().toLowerCase()
      const filtered = messages.filter(function (mail) {
        if (!query) return true
        return [mail.subject, mail.body, partyLabel(mail.from, t)].join(' ').toLowerCase().indexOf(query) >= 0
      })
      const recent = filtered.slice(0, props.rows)
      const chartDays = stats ? stats.days.slice(-7) : []
      const max = Math.max(1, ...chartDays.map(function (day) { return day.sent + day.received }))
      const donut = [
        ['delivered', totals.delivered, 'var(--cw-ok)'],
        ['queued', totals.queued, 'var(--cw-warn)'],
        ['failed', totals.failed, 'var(--cw-bad)'],
        ['mailbox', totals.mailbox, 'var(--cw-mail)'],
        ['none', totals.none, 'var(--cw-none)'],
      ]
      let cursor = 0
      const stops = donut.map(function (item) {
        const start = cursor / Math.max(1, totals.total) * 100
        cursor += item[1]
        return item[2] + ' ' + start + '% ' + cursor / Math.max(1, totals.total) * 100 + '%'
      })
      const donutBg = totals.total > 0 ? 'conic-gradient(' + stops.join(',') + ')' : 'var(--cw-soft)'
      if (!stats) return h('div', { className: 'cw-view' }, h(Empty, null, t('正在加载统计…', 'Loading stats…')))
      if (stats.total === 0) {
        return h('div', { className: 'cw-view' },
          h('div', { className: 'cw-card' },
            h('h2', null, t('还没有投递记录', 'No delivery records yet')),
            h('p', { style: { margin: 0, color: 'var(--cw-muted)', fontSize: 12 } }, t('发第一条消息，KPI 和图表会从这里开始。', 'Send your first message; KPIs and charts start here.')),
            h(Button, { variant: 'primary', onClick: props.onNew }, t('发第一条', 'Send first message'))))
      }
      return h('div', { className: 'cw-view' },
        h('div', { className: 'cw-kpis' },
          h(Kpi, { k: 'unread', label: t('未读', 'Unread'), value: stats.unread, hint: t('点击查看', 'Open'), tone: 'accent', onClick: props.onUnread }),
          h(Kpi, { k: 'sent', label: t('已发出', 'Sent'), value: totals.sent, hint: rangeLabel }),
          h(Kpi, { k: 'failed', label: t('失败待重试', 'Failed / retry'), value: totals.failed, hint: rangeLabel, tone: 'danger' }),
          h(Kpi, { k: 'groups', label: t('群组', 'Groups'), value: stats.groups, hint: t('点击查看', 'Open'), onClick: props.onGroups }),
          h(Kpi, { k: 'workspaces', label: t('工作区', 'Workspaces'), value: stats.workspaces, hint: t('点击查看', 'Open'), onClick: props.onWorkspaces }),
          h(Kpi, { k: 'success', label: t('成功率', 'Success rate'), value: success === null ? '—' : success + '%', hint: rangeLabel })),
        h('div', { className: 'cw-grid2' },
          h('section', { className: 'cw-card' },
            h('div', { className: 'cw-head' }, h('h2', null, t('近 7 天收发量', 'Last 7 days')), h('span', null, t('收 / 发', 'received / sent'))),
            chartDays.some(function (day) { return day.sent + day.received > 0 })
              ? h('div', { className: 'cw-bars' }, chartDays.map(function (day) {
                  return h('div', { className: 'cw-bar', key: day.date, title: day.date },
                    h('div', { className: 'cw-bar-pair' },
                      h('i', { className: 'cw-recv', style: { height: Math.max(2, day.received / max * 100) + '%' } }),
                      h('i', { className: 'cw-sent', style: { height: Math.max(2, day.sent / max * 100) + '%' } })),
                    h('b', null, day.date.slice(5)), h('em', null, String(day.sent + day.received)))
                }))
              : h(Empty, null, t('近 7 天还没有数据', 'No data in the last 7 days'))),
          h('section', { className: 'cw-card' },
            h('div', { className: 'cw-head' }, h('h2', null, t('投递状态分布', 'Delivery status')), h('span', null, t('按消息计', 'per message'))),
            h('div', { className: 'cw-donut-wrap' },
              h('div', { className: 'cw-donut', style: { background: donutBg } },
                h('div', null, h('strong', null, success === null ? '—' : success + '%'), h('span', null, t('成功率', 'success')))),
              h('div', { className: 'cw-legend' },
                [['已投递', totals.delivered, 'var(--cw-ok)'], ['排队', totals.queued, 'var(--cw-warn)'], ['失败', totals.failed, 'var(--cw-bad)'], ['信箱', totals.mailbox, 'var(--cw-mail)'], ['无目标', totals.none, 'var(--cw-none)']].map(function (row) {
                  return h('div', { key: row[0] }, h('i', { style: { background: row[2] } }), h('span', { className: 'grow' }, row[0]), h('b', null, String(row[1])))
                }))))),
        h('div', { className: 'cw-grid3' },
          h('section', { className: 'cw-card' },
            h('div', { className: 'cw-head' }, h('h2', null, t('群组', 'Groups')), h('button', { type: 'button', className: 'cw-link', onClick: props.onGroups }, t('管理 →', 'Manage →'))),
            groups.length === 0 ? h(Empty, null, t('还没有群组', 'No groups')) : groups.slice(0, 3).map(function (group) {
              return h('button', { type: 'button', className: 'cw-row', key: group.id, onClick: function () { props.onGroup(group) } },
                h('span', { className: 'grow' }, group.name || group.id), h('span', null, String(group.unread || 0) + t(' 未读', ' unread')))
            })),
          h('section', { className: 'cw-card' },
            h('div', { className: 'cw-head' }, h('h2', null, t('工作区消息量', 'Workspace volume')), h('button', { type: 'button', className: 'cw-link', onClick: props.onWorkspaces }, t('查看 →', 'View →'))),
            workspaces.length === 0 ? h(Empty, null, t('还没有工作区', 'No workspaces')) : workspaces.slice(0, 3).map(function (workspace) {
              return h('div', { className: 'cw-row', key: workspace.path },
                h('span', { className: 'grow' }, workspace.title || basename(workspace.path)), h('span', null, String(workspace.unread || 0)))
            })),
          h('section', { className: 'cw-card' },
            h('div', { className: 'cw-head' }, h('h2', null, t('消息量', 'Messages')), h('span', null, rangeLabel + ' · ' + totals.total)),
            h('div', { className: 'cw-stats' },
              h('div', null, h('strong', null, String(totals.mailbox)), h('span', null, t('信箱', 'Mailbox'))),
              h('div', null, h('strong', null, String(totals.failed)), h('span', null, t('失败', 'Failed'))),
              h('div', null, h('strong', null, String(totals.queued)), h('span', null, t('排队', 'Queued'))),
              h('div', null, h('strong', null, String(totals.none)), h('span', null, t('无目标', 'None')))))),
        h('section', { className: 'cw-card' },
          h('div', { className: 'cw-head' },
            h('h2', null, t('最近消息', 'Recent messages')),
            h('div', { style: { display: 'flex', gap: 10 } },
              h('button', { type: 'button', className: 'cw-link', onClick: props.onAllMessages }, t('全部消息 →', 'All messages →')),
              props.rows < 20 && filtered.length > props.rows ? h('button', { type: 'button', className: 'cw-link', onClick: props.onMoreRows }, t('查看更多', 'Show more')) : null,
              query ? h('span', null, filtered.length + t(' 条结果', ' results')) : null)),
          h('div', { className: 'cw-table' },
            h('div', { className: 'cw-tr cw-th' }, h('span', null, t('时间', 'Time')), h('span', null, t('来源', 'From')), h('span', null, t('主题', 'Subject')), h('span', null, t('状态', 'Status')), h('span', null, '')),
            recent.length === 0 ? h(Empty, null, t('没有匹配的消息', 'No matching messages')) : recent.map(function (mail) {
              const retry = canRetry(mail.delivery)
              return h('div', { className: 'cw-tr', key: mail.id },
                h('span', { style: { color: 'var(--cw-muted)' } }, timeLabel(mail.createdAt, props.now, t)),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, partyLabel(mail.from, t)),
                h('button', { type: 'button', className: 'cw-subject', onClick: function () { props.onOpen(mail) } }, subjectOf(mail, t)),
                h('span', null, h(StatusPill, { tone: statusTone(mail.delivery), label: statusLabel(mail.delivery, t) })),
                h('span', null, retry ? h('button', { type: 'button', className: 'cw-link', onClick: function () { props.onRetry(mail) } }, t('重试', 'Retry')) : null))
            }))))
    }

    function MessagesView(props) {
      const t = props.t
      const query = props.search.trim().toLowerCase()
      const messages = (props.messages || []).filter(function (mail) {
        if (query && [mail.subject, mail.body, partyLabel(mail.from, t)].join(' ').toLowerCase().indexOf(query) < 0) return false
        if (props.filter === 'unread') return mail.read !== true
        return true
      })
      return h('div', { className: 'cw-view' },
        h('div', { className: 'cw-subhead' },
          h(Button, { variant: 'ghost', onClick: props.onBack }, '← ' + t('仪表盘', 'Dashboard')),
          h('h2', null, t('消息', 'Messages')),
          h('span', { className: 'cw-pill' }, props.filter === 'unread' ? t('未读', 'Unread') : t('全部', 'All'))),
        messages.length === 0 ? h(Empty, null, t('没有消息', 'No messages')) : h('div', { className: 'cw-list' },
          messages.map(function (mail) {
            return h('button', { type: 'button', className: 'cw-row', key: mail.id, onClick: function () { props.onOpen(mail) } },
              h('span', { className: 'grow' }, subjectOf(mail, t), h('small', null, partyLabel(mail.from, t) + ' · ' + timeLabel(mail.createdAt, props.now, t))),
              h(StatusPill, { tone: statusTone(mail.delivery), label: statusLabel(mail.delivery, t) }))
          })))
    }

    function DetailView(props) {
      const t = props.t
      const mail = props.mail
      if (!mail) return h('div', { className: 'cw-view' }, h(Button, { onClick: props.onBack }, '← ' + t('返回', 'Back')), h(Empty, null, t('消息不存在', 'Message not found')))
      return h('div', { className: 'cw-view' },
        h('div', { className: 'cw-subhead' },
          h(Button, { variant: 'ghost', onClick: props.onBack }, '← ' + t('返回', 'Back')),
          h('h2', null, t('消息详情', 'Message'))),
        h('div', { className: 'cw-detail' },
          h('h2', null, subjectOf(mail, t)),
          h('div', null, h(StatusPill, { tone: statusTone(mail.delivery), label: statusLabel(mail.delivery, t) })),
          h('p', null, (mail.body || '') || t('（无正文）', '(no body)')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(Button, { variant: 'primary', onClick: function () { props.onReply(mail) } }, t('回复', 'Reply')),
            h(Button, { onClick: function () { props.onMark(mail) } }, mail.read ? t('标为未读', 'Mark unread') : t('标为已读', 'Mark read')),
            canRetry(mail.delivery) ? h(Button, { onClick: function () { props.onRetry(mail) } }, t('重试', 'Retry')) : null)))
    }

    function GroupsView(props) {
      const t = props.t
      return h('div', { className: 'cw-view' },
        h('div', { className: 'cw-subhead' },
          h(Button, { variant: 'ghost', onClick: props.onBack }, '← ' + t('仪表盘', 'Dashboard')),
          h('h2', null, t('群组', 'Groups')),
          h(Button, { variant: 'primary', onClick: props.onCreate }, t('新建群组', 'New group'))),
        props.groups.length === 0 ? h(Empty, null, t('还没有群组', 'No groups yet')) : h('div', { className: 'cw-list' },
          props.groups.map(function (group) {
            return h('div', { className: 'cw-row', key: group.id },
              h('button', { type: 'button', className: 'grow', style: { border: 0, background: 'transparent', textAlign: 'left', padding: 0 }, onClick: function () { props.onOpen(group) } },
                group.name || group.id, h('small', null, String(group.memberCount || (group.members || []).length) + t(' 位成员', ' members') + ' · ' + String(group.unread || 0) + t(' 未读', ' unread'))),
              h(Button, { variant: 'ghost', onClick: function () { props.onEdit(group) } }, t('编辑', 'Edit')))
          })))
    }

    function WorkspacesView(props) {
      const t = props.t
      return h('div', { className: 'cw-view' },
        h('div', { className: 'cw-subhead' }, h(Button, { variant: 'ghost', onClick: props.onBack }, '← ' + t('仪表盘', 'Dashboard')), h('h2', null, t('工作区', 'Workspaces'))),
        h('div', { className: 'cw-list' },
          (props.workspaces || []).map(function (workspace) {
            return h('div', { key: workspace.path, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('button', { type: 'button', className: 'cw-row', onClick: function () { props.onWorkspace(workspace) } },
                h('span', { className: 'grow' }, workspace.title || basename(workspace.path)), h('span', null, String(workspace.unread || 0))),
              (workspace.sessions || []).map(function (session) {
                return h('button', { type: 'button', className: 'cw-row', key: session.sessionId, style: { paddingLeft: 18 }, onClick: function () { props.onSession(workspace, session) } },
                  h('span', { className: 'grow' }, session.title || session.sessionId), h('span', null, session.running ? t('运行中', 'Running') : ''))
              }))
          })))
    }

    function GraphView(props) {
      const t = props.t
      const messages = props.messages || []
      const nodes = messages.slice(0, 4)
      return h('div', { className: 'cw-view' },
        h('div', { className: 'cw-subhead' }, h(Button, { variant: 'ghost', onClick: props.onBack }, '← ' + t('仪表盘', 'Dashboard')), h('h2', null, t('交流图', 'Graph'))),
        h('div', { className: 'cw-graph' },
          h('svg', { viewBox: '0 0 600 260', 'aria-hidden': 'true' },
            h('line', { x1: 300, y1: 130, x2: 110, y2: 60, stroke: 'var(--cw-border)' }),
            h('line', { x1: 300, y1: 130, x2: 490, y2: 70, stroke: 'var(--cw-border)' }),
            h('line', { x1: 300, y1: 130, x2: 470, y2: 205, stroke: 'var(--cw-border)' })),
          h('button', { type: 'button', className: 'cw-node main', style: { left: '50%', top: '50%' }, onClick: props.onBack }, t('我', 'Me')),
          nodes.map(function (mail, index) {
            const positions = [{ left: '18%', top: '24%' }, { left: '82%', top: '27%' }, { left: '78%', top: '76%' }, { left: '22%', top: '78%' }]
            return h('button', { type: 'button', className: 'cw-node', key: mail.id, style: positions[index], onClick: function () { props.onOpen(mail) } }, clip(partyLabel(mail.from, t), 12))
          })))
    }

    function SettingsView(props) {
      const t = props.t
      return h('div', { className: 'cw-view' },
        h('div', { className: 'cw-subhead' }, h(Button, { variant: 'ghost', onClick: props.onBack }, '← ' + t('仪表盘', 'Dashboard')), h('h2', null, t('设置', 'Settings'))),
        h('div', { className: 'cw-card' },
          h('p', { style: { margin: 0, color: 'var(--cw-muted)', fontSize: 12 } }, t('投递、唤醒、保留与清理设置仍在 Harness 设置页的「跨工作区信使」分节。', 'Delivery, wake, retention and cleanup live in Harness Settings under “Cross-workspace courier”.')),
          h(Button, { variant: 'primary', onClick: props.onOpen }, t('打开设置', 'Open settings'))))
    }

    function ComposeView(props) {
      const t = props.t
      const [target, setTarget] = React.useState(props.replyTo ? 'reply' : 'group')
      const [groupId, setGroupId] = React.useState((props.groups[0] || {}).id || '')
      const [sessionId, setSessionId] = React.useState('')
      const [workspacePath, setWorkspacePath] = React.useState((props.workspaces[0] || {}).path || '')
      const [subject, setSubject] = React.useState(props.replyTo ? 'Re: ' + subjectOf(props.replyTo, t) : '')
      const [body, setBody] = React.useState('')
      const [wake, setWake] = React.useState(false)
      const [sending, setSending] = React.useState(false)
      const [error, setError] = React.useState('')
      const sessions = []
      ;(props.workspaces || []).forEach(function (workspace) {
        (workspace.sessions || []).forEach(function (session) { sessions.push({ workspace: workspace, session: session }) })
      })
      function send() {
        if (sending) return
        if (!subject.trim() && !body.trim()) { setError(t('主题和正文不能都为空。', 'Subject and body cannot both be empty.')); return }
        const payload = { subject: subject.trim(), body: body, files: [], wake: wake }
        if (props.mySessionId) payload.fromSessionId = props.mySessionId
        if (target === 'reply' && props.replyTo) {
          payload.replyTo = props.replyTo.id
          const replyToGroup = props.replyTo.to && (props.replyTo.to.groupId || props.replyTo.to.groupName)
          if (replyToGroup) {
            const groupIdValue = props.replyTo.to.groupId
            const group = (props.groups || []).find(function (item) { return item.id === groupIdValue })
            payload.to = 'group:' + ((group && group.name) || props.replyTo.to.groupName || groupIdValue)
            payload.groupId = groupIdValue
          } else {
            payload.to = partyLabel(props.replyTo.from, t)
            if (props.replyTo.from && props.replyTo.from.sessionId) payload.toSessionId = props.replyTo.from.sessionId
          }
        } else if (target === 'group') {
          const group = (props.groups || []).find(function (item) { return item.id === groupId }) || props.groups[0]
          if (!group) { setError(t('请选择群组。', 'Choose a group.')); return }
          payload.to = 'group:' + (group.name || group.id)
          payload.groupId = group.id
        } else if (target === 'workspace') {
          if (!workspacePath) { setError(t('请选择工作区。', 'Choose a workspace.')); return }
          payload.to = workspacePath
        } else {
          if (!sessionId) { setError(t('请选择会话。', 'Choose a session.')); return }
          payload.to = sessionId
          payload.toSessionId = sessionId
        }
        setSending(true)
        setError('')
        props.onSend(payload).then(function (value) {
          props.onSent(value)
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () { setSending(false) })
      }
      return h('div', { className: 'cw-overlay' },
        h('div', { className: 'cw-sheet', role: 'dialog', 'aria-modal': 'true' },
          h('h2', { style: { margin: 0, fontSize: 15 } }, t('新消息', 'New message')),
          props.replyTo ? h('div', { className: 'cw-pill' }, t('回复：', 'Reply: ') + subjectOf(props.replyTo, t)) : null,
          h('label', { className: 'cw-field' }, t('收件人类型', 'Recipient type'),
            h('select', { value: target, onChange: function (event) { setTarget(event.target.value) } },
              props.replyTo ? h('option', { value: 'reply' }, t('回复原消息', 'Reply to message')) : null,
              h('option', { value: 'group' }, t('群组', 'Group')),
              h('option', { value: 'workspace' }, t('工作区', 'Workspace')),
              h('option', { value: 'session' }, t('会话', 'Session')))),
          target === 'group' ? h('label', { className: 'cw-field' }, t('群组', 'Group'),
            h('select', { value: groupId, onChange: function (event) { setGroupId(event.target.value) } },
              (props.groups || []).map(function (group) { return h('option', { key: group.id, value: group.id }, group.name || group.id) }))) : null,
          target === 'workspace' ? h('label', { className: 'cw-field' }, t('工作区', 'Workspace'),
            h('select', { value: workspacePath, onChange: function (event) { setWorkspacePath(event.target.value) } },
              (props.workspaces || []).map(function (workspace) { return h('option', { key: workspace.path, value: workspace.path }, workspace.title || basename(workspace.path)) }))) : null,
          target === 'session' ? h('label', { className: 'cw-field' }, t('会话', 'Session'),
            h('select', { value: sessionId, onChange: function (event) { setSessionId(event.target.value) } },
              h('option', { value: '' }, t('请选择', 'Choose')),
              sessions.map(function (item) { return h('option', { key: item.session.sessionId, value: item.session.sessionId }, (item.session.title || item.session.sessionId) + ' · ' + (item.workspace.title || basename(item.workspace.path))) }))) : null,
          h('label', { className: 'cw-field' }, t('主题', 'Subject'), h('input', { value: subject, onChange: function (event) { setSubject(event.target.value) } })),
          h('label', { className: 'cw-field' }, t('正文', 'Body'), h('textarea', { value: body, onChange: function (event) { setBody(event.target.value) } })),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--cw-muted)' } },
            h('input', { type: 'checkbox', checked: wake, onChange: function (event) { setWake(event.target.checked) } }), t('尝试唤醒目标', 'Try to wake target')),
          error ? h('div', { className: 'cw-error' }, error) : null,
          h('div', { className: 'cw-sheet-actions' },
            h(Button, { onClick: props.onCancel, disabled: sending }, t('取消', 'Cancel')),
            h(Button, { variant: 'primary', onClick: send, disabled: sending }, sending ? t('发送中…', 'Sending…') : t('发送', 'Send')))))
    }

    function GroupEditorView(props) {
      const t = props.t
      const group = props.group
      const [name, setName] = React.useState(group ? (group.name || '') : '')
      const [members, setMembers] = React.useState(group && Array.isArray(group.memberSessionIds) ? group.memberSessionIds.slice() : (group && Array.isArray(group.members) ? group.members.map(function (item) { return item.sessionId }) : []))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const sessions = []
      ;(props.workspaces || []).forEach(function (workspace) {
        (workspace.sessions || []).forEach(function (session) { sessions.push({ workspace: workspace, session: session }) })
      })
      function toggle(sessionId) {
        setMembers(function (current) {
          return current.indexOf(sessionId) >= 0 ? current.filter(function (item) { return item !== sessionId }) : current.concat(sessionId)
        })
      }
      function save() {
        if (!name.trim()) { setError(t('群组名称不能为空。', 'Group name is required.')); return }
        setBusy(true); setError('')
        const action = group ? 'groupUpdate' : 'groupCreate'
        const payload = group ? { id: group.id, name: name.trim(), sessionIds: members } : { name: name.trim(), sessionIds: members }
        props.onSave(action, payload).then(function (value) { props.onSaved(value) })
          .catch(function (reason) { if (!isAbortError(reason)) setError(errorMessage(reason, t)) })
          .finally(function () { setBusy(false) })
      }
      return h('div', { className: 'cw-view' },
        h('div', { className: 'cw-subhead' }, h(Button, { variant: 'ghost', onClick: props.onCancel }, '← ' + t('群组', 'Groups')), h('h2', null, group ? t('编辑群组', 'Edit group') : t('新建群组', 'New group'))),
        h('div', { className: 'cw-card' },
          h('label', { className: 'cw-field' }, t('名称', 'Name'), h('input', { value: name, onChange: function (event) { setName(event.target.value) } })),
          h('div', { className: 'cw-field' }, t('成员会话', 'Member sessions'),
            h('div', { style: { display: 'grid', gap: 4, maxHeight: 260, overflow: 'auto' } },
              sessions.length === 0 ? h(Empty, null, t('没有可选会话', 'No selectable sessions')) : sessions.map(function (item) {
                return h('label', { key: item.session.sessionId, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                  h('input', { type: 'checkbox', checked: members.indexOf(item.session.sessionId) >= 0, onChange: function () { toggle(item.session.sessionId) } }),
                  (item.session.title || item.session.sessionId) + ' · ' + (item.workspace.title || basename(item.workspace.path)))
              }))),
          error ? h('div', { className: 'cw-error' }, error) : null,
          h('div', { className: 'cw-sheet-actions' },
            h(Button, { onClick: props.onCancel, disabled: busy }, t('取消', 'Cancel')),
            h(Button, { variant: 'primary', onClick: save, disabled: busy }, busy ? t('保存中…', 'Saving…') : t('保存', 'Save')))))
    }

    // ---------------------------------------------------------------------------
    // App — single top-level view
    // ---------------------------------------------------------------------------
    function App(props) {
      const ctx = props.ctx
      const runtime = props.runtime
      const t = useText(ctx)
      const call = useApi(runtime)
      const sessionsSnapshot = useSessionsSnapshot(props)
      const browserSessionId = useUiWorkspaceSessionId(ctx)
      const mySessionId = sessionIdFromSessions(sessionsSnapshot) || browserSessionId
      const [view, setView] = React.useState(props.initialView || 'dashboard')
      const [params, setParams] = React.useState(props.initialParams || {})
      const [data, setData] = React.useState(props.initialData || null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [loading, setLoading] = React.useState(!props.initialData)
      const [range, setRange] = React.useState(7)
      const [rows, setRows] = React.useState(6)
      const [search, setSearch] = React.useState('')
      const [theme, setTheme] = React.useState(function () {
        try { return window.localStorage.getItem('dshcw-theme') === 'light' ? 'light' : 'dark' } catch (e) { return 'dark' }
      })
      const [menuOpen, setMenuOpen] = React.useState(false)
      const newButtonRef = React.useRef(null)
      const [scopeWorkspacePath, setScopeWorkspacePath] = React.useState(null)
      const [scopeGroupId, setScopeGroupId] = React.useState(null)
      const [showAll, setShowAll] = React.useState(false)
      const [viewerSessionId, setViewerSessionId] = React.useState(mySessionId)
      const seq = React.useRef(0)
      const mounted = React.useRef(true)
      const sigRef = React.useRef('')
      const loadedRef = React.useRef(!!props.initialData)
      const lastStateAtRef = React.useRef(0)
      React.useEffect(function () { mounted.current = true; return function () { mounted.current = false } }, [])
      React.useEffect(function () {
        try { window.localStorage.setItem('dshcw-theme', theme) } catch (e) {}
      }, [theme])
      React.useEffect(function () {
        if (!showAll && !scopeWorkspacePath && !scopeGroupId && mySessionId && !viewerSessionId) setViewerSessionId(mySessionId)
      }, [mySessionId, viewerSessionId, scopeWorkspacePath, scopeGroupId, showAll])
      const load = React.useCallback(function (quiet) {
        const current = ++seq.current
        if (!quiet) setLoading(true)
        const payload = buildStatePayload(viewerSessionId, mySessionId, scopeWorkspacePath, scopeGroupId, LIMIT, showAll)
        return call('state', payload).then(function (value) {
          if (!mounted.current || current !== seq.current) return
          const signature = stateSignature(value)
          const changed = !loadedRef.current || signature !== sigRef.current
          sigRef.current = signature
          loadedRef.current = true
          if (!changed) {
            const at = Date.now()
            if (at - lastStateAtRef.current > 60000) {
              lastStateAtRef.current = at
              setData(function (previous) { return previous ? Object.assign({}, previous, { now: at }) : previous })
            }
            setError(''); setLoading(false)
            return
          }
          lastStateAtRef.current = Date.now()
          setData(value || null); setError(''); setLoading(false)
        }).catch(function (reason) {
          if (!mounted.current || isAbortError(reason)) return
          setError(errorMessage(reason, t)); setLoading(false)
        })
      }, [call, t, viewerSessionId, mySessionId, scopeWorkspacePath, scopeGroupId])
      React.useEffect(function () { void load(false) }, [load])
      React.useEffect(function () {
        let timer = null
        let stopped = false
        function delay() {
          if (document.hidden) return 15000
          if (typeof document.hasFocus === 'function' && !document.hasFocus()) return 12000
          return POLL_MS
        }
        function schedule() {
          if (stopped) return
          timer = window.setTimeout(run, delay())
        }
        function run() {
          if (stopped) return
          if (document.hidden) { schedule(); return }
          load(true).finally(schedule)
        }
        function onVisibility() { if (!document.hidden) { if (timer) window.clearTimeout(timer); schedule() } }
        function onFocus() { if (timer) window.clearTimeout(timer); schedule() }
        function onBlur() { if (timer) window.clearTimeout(timer); schedule() }
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('focus', onFocus)
        window.addEventListener('blur', onBlur)
        schedule()
        return function () {
          stopped = true
          if (timer) window.clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('focus', onFocus)
          window.removeEventListener('blur', onBlur)
        }
      }, [load])
      function clearScope() {
        setScopeGroupId(null)
        setScopeWorkspacePath(null)
      }
      function navigate(next, nextParams, options) {
        setView(next); setParams(nextParams || {}); setMenuOpen(false); setNotice('')
        if (!(options && options.keepScope)) clearScope()
        if (!(options && options.keepAll)) setShowAll(false)
      }
      function back() {
        clearScope()
        setShowAll(false)
        navigate('dashboard')
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(function () {
            if (newButtonRef.current && typeof newButtonRef.current.focus === 'function') newButtonRef.current.focus()
          })
        }
      }
      function openMessage(mail) {
        if (!mail) return
        navigate('detail', { messageId: mail.id }, { keepScope: true, keepAll: true })
        if (!mail.read) {
          const viewer = viewerPayload(viewerSessionId || mySessionId, data)
          call('read', Object.assign({ id: mail.id }, viewer)).then(function (value) {
            if (value && value.message) setData(function (current) {
              if (!current) return current
              return Object.assign({}, current, { messages: (current.messages || []).map(function (item) { return item.id === value.message.id ? value.message : item }) })
            })
          }).catch(function (reason) { if (!isAbortError(reason)) setError(errorMessage(reason, t)) })
        }
      }
      function markMessage(mail) {
        if (!mail) return
        const viewer = viewerPayload(viewerSessionId || mySessionId, data)
        call('mark', Object.assign({ id: mail.id, read: mail.read !== true }, viewer)).then(function () {
          setNotice(mail.read ? t('已标为未读。', 'Marked unread.') : t('已标为已读。', 'Marked read.'))
          void load(true)
        }).catch(function (reason) { if (!isAbortError(reason)) setError(errorMessage(reason, t)) })
      }
      function retryMessage(mail) {
        if (!mail) return
        call('deliver', { id: mail.id }).then(function () {
          setNotice(t('已重新投递。', 'Delivery retried.'))
          void load(true)
        }).catch(function (reason) { if (!isAbortError(reason)) setError(errorMessage(reason, t)) })
      }
      function openSettings() {
        const shell = getService(ctx, 'shell')
        if (shell && typeof shell.openSettings === 'function') { shell.openSettings('cross-workspace'); return }
        setNotice(t('设置入口在 Harness 设置页的「跨工作区信使」分节。', 'Settings live in Harness Settings under “Cross-workspace courier”.'))
      }
      function openCompose(replyTo) { navigate('compose', { replyTo: replyTo || null }) }
      function openGroup(group) { setShowAll(true); setScopeGroupId(group.id); setScopeWorkspacePath(null); setViewerSessionId(null); navigate('messages', { filter: 'all' }, { keepScope: true, keepAll: true }) }
      function openWorkspace(workspace) { setShowAll(true); setScopeWorkspacePath(workspace.path); setScopeGroupId(null); setViewerSessionId(null); navigate('messages', { filter: 'all' }, { keepScope: true, keepAll: true }) }
      function openSession(workspace, session) {
        setShowAll(false); setScopeWorkspacePath(null); setScopeGroupId(null); setViewerSessionId(session.sessionId); navigate('messages', { filter: 'all' }, { keepScope: true, keepAll: true })
      }
      const stats = data && data.stats ? data.stats : null
      const groups = data && Array.isArray(data.groups) ? data.groups : []
      const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : []
      const messages = data && Array.isArray(data.messages) ? data.messages : []
      const now = data && typeof data.now === 'number' ? data.now : Date.now()
      const selected = params.messageId ? messages.find(function (mail) { return mail.id === params.messageId }) || null : null
      const currentGroup = params.groupId ? groups.find(function (group) { return group.id === params.groupId }) || null : null
      let content = null
      if (view === 'dashboard') content = h(DashboardView, {
        t: t, stats: stats, messages: messages, groups: groups, workspaces: workspaces, range: range, rows: rows,
        now: now, search: search,
        onUnread: function () { setShowAll(false); setScopeGroupId(null); setScopeWorkspacePath(null); navigate('messages', { filter: 'unread' }) },
        onGroups: function () { navigate('groups') },
        onWorkspaces: function () { navigate('workspaces') },
        onGroup: openGroup, onWorkspacesView: function () { navigate('workspaces') },
        onAllMessages: function () { setShowAll(true); clearScope(); setViewerSessionId(null); navigate('messages', { filter: 'all' }, { keepAll: true }) },
        onMoreRows: function () { setRows(rows >= 12 ? 20 : 12) },
        onOpen: openMessage, onRetry: retryMessage, onNew: function () { openCompose(null) },
      })
      else if (view === 'messages') content = h(MessagesView, {
        t: t, messages: messages, search: search, filter: params.filter || 'all', now: now,
        onOpen: openMessage, onBack: back,
      })
      else if (view === 'detail') content = h(DetailView, {
        t: t, mail: selected, onBack: function () { navigate('messages', { filter: params.filter || 'all' }, { keepScope: true, keepAll: true }) },
        onReply: openCompose, onMark: markMessage, onRetry: retryMessage,
      })
      else if (view === 'groups') content = h(GroupsView, {
        t: t, groups: groups, onBack: back,
        onOpen: openGroup,
        onEdit: function (group) { navigate('groupEditor', { group: group }) },
        onCreate: function () { navigate('groupEditor', { group: null }) },
      })
      else if (view === 'groupEditor') content = h(GroupEditorView, {
        t: t, group: params.group || null, workspaces: workspaces,
        onCancel: function () { navigate('groups') },
        onSave: call,
        onSaved: function () { setNotice(t('群组已保存。', 'Group saved.')); void load(true); navigate('groups') },
      })
      else if (view === 'workspaces') content = h(WorkspacesView, {
        t: t, workspaces: workspaces, onBack: back,
        onWorkspace: openWorkspace, onSession: openSession,
      })
      else if (view === 'graph') content = h(GraphView, { t: t, messages: messages, onBack: back, onOpen: openMessage })
      else if (view === 'settings') content = h(SettingsView, { t: t, onBack: back, onOpen: openSettings })
      else if (view === 'compose') content = h(ComposeView, {
        t: t, groups: groups, workspaces: workspaces, replyTo: params.replyTo || null, mySessionId: viewerSessionId || mySessionId,
        onSend: function (payload) { return call('send', payload) },
        onCancel: function () { navigate(params.replyTo ? 'detail' : 'dashboard', params.replyTo ? { messageId: params.replyTo.id } : {}) },
        onSent: function () { setNotice(t('消息已保存。', 'Message saved.')); void load(true); navigate('dashboard') },
      })
      const showTop = view !== 'compose'
      return h('div', { className: 'dshcw-v1', 'data-theme': theme },
        h(Styles),
        error ? h('div', { className: 'cw-error', onClick: function () { setError('') } }, error) : null,
        notice ? h('div', { className: 'cw-notice', onClick: function () { setNotice('') } }, notice) : null,
        showTop ? h('header', { className: 'cw-top' },
          h('div', { className: 'cw-title' },
            h('h1', null, t('跨工作区信使', 'Cross-workspace courier')),
            h('span', { className: 'cw-stamp' }, BUILD_STAMP),
            h('span', { className: 'cw-scope' }, t('按本地保留范围', 'Local retention scope'))),
          h('div', { className: 'cw-actions' },
            h('div', { className: 'cw-seg', role: 'group', 'aria-label': t('时间范围', 'Time range') },
              [[1, t('今天', 'Today')], [7, t('近7天', '7 days')], [30, t('近30天', '30 days')]].map(function (pair) {
                return h('button', { key: pair[0], type: 'button', className: range === pair[0] ? 'on' : '', onClick: function () { setRange(pair[0]); setRows(6) } }, pair[1])
              })),
            h('input', { className: 'cw-input', style: { width: 160 }, value: search, placeholder: t('搜索消息…', 'Search messages…'), 'aria-label': t('搜索消息', 'Search messages'), onChange: function (event) { setSearch(event.target.value) } }),
            h(Button, { onClick: function () { void load(true); setNotice(t('已刷新。', 'Refreshed.')) } }, t('刷新', 'Refresh')),
            h(Button, { variant: 'primary', buttonRef: newButtonRef, onClick: function () { openCompose(null) } }, t('新消息', 'New message')),
            h('button', { type: 'button', className: 'cw-icon', 'aria-label': t('切换主题', 'Toggle theme'), title: t('切换主题', 'Toggle theme'), onClick: function () { setTheme(theme === 'dark' ? 'light' : 'dark') } }, theme === 'dark' ? '☀' : '☾'),
            h('div', { style: { position: 'relative', flex: 'none' } },
              h('button', { type: 'button', className: 'cw-icon', 'aria-label': t('更多', 'More'), 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, onClick: function () { setMenuOpen(!menuOpen) } }, '⋯'),
              menuOpen ? h('div', { className: 'cw-menu', role: 'menu' },
                h('button', { type: 'button', onClick: function () { navigate('groups') } }, t('群组', 'Groups')),
                h('button', { type: 'button', onClick: function () { navigate('workspaces') } }, t('工作区', 'Workspaces')),
                h('button', { type: 'button', onClick: function () { navigate('graph') } }, t('交流图', 'Graph')),
                h('button', { type: 'button', onClick: function () { navigate('settings') } }, t('设置', 'Settings'))) : null)))
        : null,
        h('main', { className: 'cw-body' },
          loading && !data ? h(Empty, null, t('正在加载…', 'Loading…')) : content),
        h('div', { className: 'cw-log' }, 'view=' + view + ' · ' + BUILD_STAMP)
      )
    }

    // Settings section uses the same single source; it is intentionally simple
    // in the skeleton and keeps the Host settings page as the source of truth.
    function SettingsSection(props) {
      const t = useText(props.ctx)
      const runtime = props.runtime
      const call = useApi(runtime)
      const [settings, setSettings] = React.useState(null)
      const [error, setError] = React.useState('')
      React.useEffect(function () {
        call('state', { filter: 'all', limit: 1 }).then(function (value) {
          setSettings(value && value.settings ? value.settings : null)
        }).catch(function (reason) { if (!isAbortError(reason)) setError(errorMessage(reason, t)) })
      }, [call, t])
      return h('div', { className: 'dshcw-v1', style: { padding: 0, background: 'transparent', color: 'var(--dsw-alias-label-primary)' } },
        h('h2', { style: { margin: 0, fontSize: 16 } }, t('跨工作区信使', 'Cross-workspace courier')),
        h('p', { style: { margin: '6px 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('设置由 Host 管理；完整面板请从侧栏打开。', 'Settings are Host-managed; open the full panel from the sidebar.')),
        error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, error) : null,
        settings ? h('pre', { style: { fontSize: 11, overflow: 'auto' } }, JSON.stringify(settings, null, 2)) : null)
    }

    function apply(ctx) {
      const runtime = { disposed: false, controllers: new Set() }
      ctx.effect(function () {
        return function () {
          runtime.disposed = true
          runtime.controllers.forEach(function (controller) { try { controller.abort() } catch (error) {} })
          runtime.controllers.clear()
        }
      }, 'cross-workspace: v1 client lifecycle')
      function label() { return isZhLocale(ctx) ? '跨工作区信使' : 'Cross-workspace courier' }
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({ name: 'sidebar.panellist', id: 'cross-workspace', order: 23, label: label }, function Icon() { return h('span', { 'aria-hidden': 'true' }, '✉') })
      })
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: 'cross-workspace' }, function Main(props) {
          return h(App, Object.assign({}, props, { ctx: ctx, runtime: runtime }))
        })
      })
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({ name: 'settings.section', id: 'cross-workspace', order: 62, label: label }, function Settings(props) {
          return h(SettingsSection, Object.assign({}, props, { ctx: ctx, runtime: runtime }))
        })
      })
    }

    return { inject: ['slots', 'locale'], apply: apply, __test: { App: App, DashboardView: DashboardView, MessagesView: MessagesView, DetailView: DetailView, GroupsView: GroupsView, WorkspacesView: WorkspacesView, GraphView: GraphView, ComposeView: ComposeView, GroupEditorView: GroupEditorView, SettingsView: SettingsView, SettingsSection: SettingsSection, buildStatePayload: buildStatePayload, stateSignature: stateSignature, BUILD_STAMP: BUILD_STAMP } }
  },
})
