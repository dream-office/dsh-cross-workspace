window.__ModuleLoader__.load({
  id: 'dsh-cross-workspace',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // dsh-cross-workspace — browser half, hand-written module-loader client.
    //
    // Registers three shell surfaces:
    //   sidebar.panellist  id  cross-workspace  — envelope glyph that opens the page
    //   main               key cross-workspace  — management page (workspaces, inbox, compose)
    //   settings.section   id  cross-workspace  — delivery limits, cleanup, store location
    //
    // All traffic goes to the plugin's own same-origin route. No bundler, no JSX,
    // no client package imports; colors come only from --dsw-alias-* theme tokens.

    const API_PATH = '/plugins/dsh-cross-workspace/api'
    const API_HEADERS = { 'content-type': 'application/json', 'x-dsh-cross-workspace': '1' }
    const POLL_INTERVAL_MS = 4000
    const POLL_BACKGROUND_MS = 12000
    const POLL_HIDDEN_MS = 15000
    const LIMIT = 300
    const GRAPH_MESSAGE_LIMIT = 120
    const NARROW_WIDTH = 760

    // ---------------------------------------------------------------------------
    // HTTP
    // ---------------------------------------------------------------------------

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
      try {
        body = await response.json()
      } catch (error) {
        const failure = new Error('HTTP ' + response.status)
        failure.status = response.status
        throw failure
      }
      if (!response.ok || !body || body.ok !== true) {
        const info = body && body.error ? body.error : null
        const failure = new Error(info && info.message ? String(info.message) : (info && info.code ? String(info.code) : 'HTTP ' + response.status))
        failure.code = info && info.code ? info.code : ''
        failure.status = response.status
        throw failure
      }
      return body.value
    }

    // ---------------------------------------------------------------------------
    // Generic helpers
    // ---------------------------------------------------------------------------

    function getService(ctx, name) {
      if (!ctx || typeof ctx.get !== 'function') return undefined
      try {
        return ctx.get(name)
      } catch (error) {
        return undefined
      }
    }

    function isZhLocale(ctx) {
      try {
        const snapshot = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
        const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
        return active.toLowerCase().indexOf('zh') === 0
      } catch (error) {
        return false
      }
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
        } catch (error) {
          return ''
        }
      }, [ctx])
      const active = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return typeof active === 'string' ? active : ''
    }

    function useText(ctx) {
      const active = useLocaleActive(ctx)
      return React.useMemo(function () {
        const zh = String(active || '').toLowerCase().indexOf('zh') === 0
        return function (zhText, enText) {
          return zh ? zhText : enText
        }
      }, [active])
    }

    function shortId(id) {
      if (typeof id !== 'string' || !id) return ''
      return id.length > 12 ? id.slice(0, 8) + '…' : id
    }

    function basename(path) {
      if (typeof path !== 'string' || !path) return ''
      const parts = path.split(/[\\/]+/).filter(function (part) { return part.length > 0 })
      return parts.length ? parts[parts.length - 1] : path
    }

    function isAbortError(error) {
      return !!error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
    }

    function errorMessage(error, t) {
      if (!error) return t ? t('未知错误', 'Unknown error') : 'Unknown error'
      if (typeof error.message === 'string' && error.message) return error.message
      return String(error)
    }

    function safeConfirm(message) {
      // Fail closed: if a host-suppressed confirm is unavailable, do NOT let a
      // destructive action proceed without an explicit confirmation.
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false
      try {
        return window.confirm(message)
      } catch (error) {
        return false
      }
    }

    async function copyText(text) {
      const value = text == null ? '' : String(text)
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value)
        return true
      }
      return false
    }

    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && isFinite(bytes) && bytes >= 0 ? bytes : 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
      return (value / 1024 / 1024 / 1024).toFixed(1) + ' GB'
    }

    function formatDate(timestamp) {
      if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return ''
      try {
        return new Date(timestamp).toLocaleString()
      } catch (error) {
        return ''
      }
    }

    function formatClock(timestamp) {
      if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return ''
      try {
        return new Date(timestamp).toLocaleTimeString()
      } catch (error) {
        return ''
      }
    }

    function relativeTime(timestamp, now, t) {
      if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return ''
      const diff = Math.max(0, (typeof now === 'number' ? now : Date.now()) - timestamp)
      const minute = 60000
      const hour = 60 * minute
      const day = 24 * hour
      if (diff < minute) return t('刚刚', 'just now')
      if (diff < hour) return t(Math.floor(diff / minute) + ' 分钟前', Math.floor(diff / minute) + ' min ago')
      if (diff < day) return t(Math.floor(diff / hour) + ' 小时前', Math.floor(diff / hour) + ' h ago')
      if (diff < 7 * day) return t(Math.floor(diff / day) + ' 天前', Math.floor(diff / day) + ' d ago')
      return formatDate(timestamp)
    }

    function snippet(body) {
      if (typeof body !== 'string') return ''
      const flat = body.replace(/\s+/g, ' ').trim()
      if (flat.length <= 160) return flat
      return flat.slice(0, 160) + '…'
    }

    function subjectText(mail, t) {
      if (mail && typeof mail.subject === 'string' && mail.subject.trim()) return mail.subject.trim()
      return t('（无主题）', '(no subject)')
    }

    function compactParty(party, t) {
      if (!party || typeof party !== 'object') return t('未知', 'Unknown')
      if (typeof party.groupId === 'string' || typeof party.groupName === 'string') {
        return groupLabelOf(party, t)
      }
      if (typeof party.workspaceTitle === 'string' && party.workspaceTitle) return party.workspaceTitle
      if (typeof party.sessionTitle === 'string' && party.sessionTitle) return party.sessionTitle
      if (typeof party.sessionId === 'string' && party.sessionId) return shortId(party.sessionId)
      if (typeof party.workspacePath === 'string' && party.workspacePath) return basename(party.workspacePath) || party.workspacePath
      return t('未知', 'Unknown')
    }

    function fullParty(party, t) {
      if (!party || typeof party !== 'object') return t('未知', 'Unknown')
      if (typeof party.groupId === 'string' || typeof party.groupName === 'string') {
        return groupLabelOf(party, t)
      }
      const workspaceTitle = typeof party.workspaceTitle === 'string' ? party.workspaceTitle : ''
      const sessionTitle = typeof party.sessionTitle === 'string' ? party.sessionTitle : ''
      const sessionId = typeof party.sessionId === 'string' ? party.sessionId : ''
      const workspacePath = typeof party.workspacePath === 'string' ? party.workspacePath : ''
      const sessionLabel = sessionTitle || sessionId
      if (sessionLabel && workspaceTitle) return sessionLabel + ' · ' + workspaceTitle
      if (sessionLabel) return sessionLabel
      if (workspaceTitle) return workspaceTitle
      if (workspacePath) return workspacePath
      return t('未指定', 'Unspecified')
    }

    function partyIdLine(party) {
      if (!party || typeof party !== 'object') return ''
      const pieces = []
      if (typeof party.groupId === 'string' && party.groupId) pieces.push('g:' + party.groupId)
      if (typeof party.sessionId === 'string' && party.sessionId) pieces.push(party.sessionId)
      if (typeof party.workspacePath === 'string' && party.workspacePath) pieces.push(party.workspacePath)
      return pieces.join('  ')
    }

    function groupLabelOf(party, t) {
      const name = party && typeof party.groupName === 'string' ? party.groupName : ''
      const id = party && typeof party.groupId === 'string' ? party.groupId : ''
      if (name) return t('群组「', 'Group “') + name + t('」', '”')
      if (id) return t('群组 ', 'Group ') + shortId(id)
      return t('群组', 'Group')
    }

    function groupMemberIds(party) {
      if (!party || !Array.isArray(party.memberSessionIds)) return []
      return party.memberSessionIds.filter(function (id) { return typeof id === 'string' && id.length > 0 })
    }

    function isGroupMail(mail) {
      return !!(mail && mail.to && (typeof mail.to.groupId === 'string' || typeof mail.to.groupName === 'string'))
    }

    function clipText(text, limit) {
      if (typeof text !== 'string') return ''
      if (text.length <= limit) return text
      return text.slice(0, limit) + '…'
    }

    /**
     * Cheap semantic signature of a `state` response. Polling can return an
     * equivalent object every few seconds; comparing this signature avoids
     * re-rendering the whole panel (and rebuilding the graph) for no change.
     */
    function stateSignature(value) {
      if (!value || typeof value !== 'object') return ''
      const parts = [
        String(value.unreadTotal ?? ''),
        String(value.total ?? ''),
        String(value.returned ?? ''),
        value.viewer && value.viewer.key ? String(value.viewer.key) : '',
        value.viewer && value.viewer.sessionTitle ? String(value.viewer.sessionTitle) : '',
        value.settings ? String(JSON.stringify(value.settings)) : '',
      ]
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        const delivery = message && message.delivery ? message.delivery : {}
        parts.push('m', String(message.id), message.read === true ? '1' : '0', String(delivery.mode ?? ''), String(delivery.at ?? ''), delivery.delivered === true ? '1' : '0', String(delivery.note ?? ''), String(message.editedAt ?? ''))
      }
      for (const workspace of Array.isArray(value.workspaces) ? value.workspaces : []) {
        parts.push('w', String(workspace.path), String(workspace.title), String(workspace.unread), workspace.exists === false ? '0' : '1')
        for (const session of Array.isArray(workspace.sessions) ? workspace.sessions : []) {
          parts.push('s', String(session.sessionId), String(session.title), session.running === true ? '1' : '0', String(session.unread), String(session.updatedAt ?? ''), String(session.cwd ?? ''))
        }
      }
      for (const group of Array.isArray(value.groups) ? value.groups : []) {
        parts.push('g', String(group.id), String(group.name), String(group.unread), String(group.updatedAt ?? ''))
        for (const member of Array.isArray(group.members) ? group.members : []) {
          parts.push('gm', String(member.sessionId), String(member.title), member.running === true ? '1' : '0', member.blank === true ? '1' : '0', String(member.workspacePath ?? ''), String(member.workspaceTitle ?? ''))
        }
      }
      for (const orphan of Array.isArray(value.orphans) ? value.orphans : []) {
        parts.push('o', String(orphan.sessionId), String(orphan.title), orphan.running === true ? '1' : '0', String(orphan.updatedAt ?? ''), String(orphan.cwd ?? ''))
      }
      return parts.join('|')
    }

    function buildSessionDirectory(data) {
      const directory = new Map()
      function ensure(sessionId) {
        if (typeof sessionId !== 'string' || !sessionId) return null
        let record = directory.get(sessionId)
        if (!record) {
          record = { sessionId: sessionId, title: '', workspacePath: '', workspaceTitle: '', running: false, blank: false }
          directory.set(sessionId, record)
        }
        return record
      }
      function fill(record, patch) {
        if (!record) return
        Object.keys(patch).forEach(function (key) {
          const value = patch[key]
          if (value === undefined || value === '' || value === false) return
          record[key] = value
        })
      }
      const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : []
      workspaces.forEach(function (workspace) {
        const sessions = workspace && Array.isArray(workspace.sessions) ? workspace.sessions : []
        sessions.forEach(function (session) {
          fill(ensure(session && session.sessionId), {
            title: session && typeof session.title === 'string' ? session.title : '',
            workspacePath: workspace && typeof workspace.path === 'string' ? workspace.path : '',
            workspaceTitle: workspace && typeof workspace.title === 'string' ? workspace.title : '',
            running: session && session.running === true,
            blank: session && session.blank === true,
          })
        })
      })
      const orphans = data && Array.isArray(data.orphans) ? data.orphans : []
      orphans.forEach(function (session) {
        fill(ensure(session && session.sessionId), {
          title: session && typeof session.title === 'string' ? session.title : '',
          workspacePath: session && typeof session.cwd === 'string' ? session.cwd : '',
          running: session && session.running === true,
          blank: session && session.blank === true,
        })
      })
      const groups = data && Array.isArray(data.groups) ? data.groups : []
      groups.forEach(function (group) {
        const members = group && Array.isArray(group.members) ? group.members : []
        members.forEach(function (member) {
          fill(ensure(member && member.sessionId), {
            title: member && typeof member.title === 'string' ? member.title : '',
            workspacePath: member && typeof member.workspacePath === 'string' ? member.workspacePath : '',
            workspaceTitle: member && typeof member.workspaceTitle === 'string' ? member.workspaceTitle : '',
            running: member && member.running === true,
            blank: member && member.blank === true,
          })
        })
      })
      return directory
    }

    function sessionLabelOf(directory, sessionId, t) {
      const record = directory && typeof directory.get === 'function' ? directory.get(sessionId) : undefined
      if (!record) return shortId(sessionId) || t('未知会话', 'Unknown session')
      if (record.title) return record.title
      return shortId(sessionId)
    }

    function sessionFullLabelOf(directory, sessionId, t) {
      const record = directory && typeof directory.get === 'function' ? directory.get(sessionId) : undefined
      if (!record) return shortId(sessionId) || t('未知会话', 'Unknown session')
      const label = record.title || shortId(sessionId)
      if (record.workspaceTitle) return label + ' · ' + record.workspaceTitle
      if (record.workspacePath) return label + ' · ' + (basename(record.workspacePath) || record.workspacePath)
      return label
    }

    function deliveryBadgeLabel(delivery, t) {
      if (delivery && delivery.mode === 'wake') return t('已唤醒', 'Woke')
      if (delivery && delivery.mode === 'queued') return t('排队', 'Queued')
      return t('信箱', 'Mailbox')
    }

    function deliveryLines(delivery, t, sessionLabel) {
      const lines = []
      if (!delivery || typeof delivery !== 'object') {
        lines.push({ text: t('没有投递记录', 'No delivery record'), tone: 'plain' })
        return lines
      }
      const requested = delivery.requested === 'wake' ? t('唤醒', 'wake') : delivery.requested === 'mailbox' ? t('信箱', 'mailbox') : String(delivery.requested || '')
      const actual = delivery.mode === 'wake' ? t('唤醒', 'wake')
        : delivery.mode === 'mailbox' ? t('信箱', 'mailbox')
          : delivery.mode === 'queued' ? t('排队（目标运行中）', 'queued (target busy)')
            : delivery.mode === 'none' ? t('无（没有可投递的目标）', 'none (no deliverable target)')
              : String(delivery.mode || '')
      lines.push({ text: t('请求方式：', 'Requested: ') + (requested || t('未知', 'unknown')), tone: 'plain' })
      lines.push({ text: t('实际方式：', 'Actual: ') + (actual || t('未知', 'unknown')), tone: 'plain' })
      lines.push({ text: t('已投递：', 'Delivered: ') + (delivery.delivered === true ? t('是', 'yes') : t('否', 'no')), tone: 'plain' })
      if (typeof delivery.at === 'number' && delivery.at > 0) lines.push({ text: t('投递时间：', 'At: ') + formatDate(delivery.at), tone: 'plain' })
      if (typeof delivery.targetSessionId === 'string' && delivery.targetSessionId) lines.push({ text: t('目标会话：', 'Target session: ') + delivery.targetSessionId, tone: 'plain' })
      if (typeof delivery.note === 'string' && delivery.note) lines.push({ text: t('说明：', 'Note: ') + delivery.note, tone: 'plain' })
      if (typeof delivery.error === 'string' && delivery.error) lines.push({ text: t('错误：', 'Error: ') + delivery.error, tone: 'error' })
      if (Array.isArray(delivery.members) && delivery.members.length > 0) {
        delivery.members.forEach(function (member) {
          if (!member || typeof member !== 'object') return
          const label = sessionLabel ? sessionLabel(member.sessionId) : shortId(member.sessionId)
          const mode = member.mode === 'wake' ? t('已唤醒', 'woke') : member.mode === 'mailbox' ? t('信箱', 'mailbox') : member.mode === 'queued' ? t('排队', 'queued') : member.mode === 'none' ? t('未投递', 'none') : String(member.mode || '')
          const detail = member.error ? t('错误：', 'Error: ') + member.error : (member.note ? t('说明：', 'Note: ') + member.note : '')
          lines.push({
            text: t('成员：', 'Member: ') + label + ' — ' + (mode || t('未知', 'unknown')) + (detail ? '（' + detail + '）' : ''),
            tone: member.error ? 'error' : 'plain',
          })
        })
      }
      return lines
    }

    function hasJsonData(mail) {
      return !!mail && Object.prototype.hasOwnProperty.call(mail, 'data') && mail.data !== undefined
    }

    function prettyJson(value) {
      try {
        const text = JSON.stringify(value, null, 2)
        return typeof text === 'string' ? text : String(value)
      } catch (error) {
        try {
          return String(value)
        } catch (inner) {
          return ''
        }
      }
    }

    function parseJsonText(text) {
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (!trimmed) return { ok: true, present: false, value: undefined }
      try {
        return { ok: true, present: true, value: JSON.parse(trimmed) }
      } catch (error) {
        return { ok: false, present: false, value: undefined, message: errorMessage(error) }
      }
    }

    function isAbsolutePath(value) {
      if (typeof value !== 'string' || !value) return false
      if (value.charAt(0) === '/') return true
      if (value.charAt(0) === '\\' && value.charAt(1) === '\\') return true
      return /^[A-Za-z]:[\\/]/.test(value)
    }

    function splitFilePaths(text) {
      if (typeof text !== 'string') return []
      return text.split(/\r?\n/).map(function (line) { return line.trim() }).filter(function (line) { return line.length > 0 })
    }

    function replyTargetOf(mail) {
      if (!mail || !mail.from || typeof mail.from !== 'object') return ''
      return typeof mail.from.sessionId === 'string' ? mail.from.sessionId : ''
    }

    function replySubjectOf(subject, t) {
      const base = typeof subject === 'string' ? subject.trim() : ''
      if (!base) return t('回复', 'Reply')
      return /^re:/i.test(base) ? base : 'Re: ' + base
    }

    function sendSummary(value, t) {
      const parts = []
      if (value && value.delivery) {
        const mode = typeof value.delivery.mode === 'string' ? value.delivery.mode : ''
        parts.push(t('投递方式：', 'Delivery: ') + deliveryBadgeLabel(value.delivery, t) + (mode ? ' (' + mode + ')' : ''))
      }
      if (value && value.delivery && value.delivery.mode === 'wake' && value.delivery.delivered !== true) parts.push(t('唤醒未完成，目标可在下次运行时读到', 'Wake incomplete; the target can read it on its next run'))
      if (value && Array.isArray(value.warnings) && value.warnings.length) parts.push(t('提示：', 'Warnings: ') + value.warnings.join('；'))
      if (!parts.length) parts.push(t('已发送', 'Sent'))
      return parts.join(t('；', '; '))
    }

    function viewerPayload(mySessionId, data) {
      const viewer = data && data.viewer && typeof data.viewer === 'object' ? data.viewer : null
      const payload = {}
      const sessionId = mySessionId || (viewer && typeof viewer.sessionId === 'string' ? viewer.sessionId : '')
      if (sessionId) payload.sessionId = sessionId
      if (viewer && typeof viewer.workspacePath === 'string' && viewer.workspacePath) payload.workspacePath = viewer.workspacePath
      return payload
    }

    function sessionIdFromSessions(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return null
      const current = snapshot.current
      if (typeof current === 'string' && current) return current
      if (current && typeof current === 'object') {
        if (typeof current.sessionId === 'string' && current.sessionId) return current.sessionId
        if (typeof current.id === 'string' && current.id) return current.id
        if (typeof current.key === 'string' && current.key) return current.key
      }
      if (typeof snapshot.selectedSessionId === 'string' && snapshot.selectedSessionId) return snapshot.selectedSessionId
      if (typeof snapshot.currentSessionId === 'string' && snapshot.currentSessionId) return snapshot.currentSessionId
      const byId = snapshot.byId
      if (byId && typeof byId === 'object') {
        const keys = Object.keys(byId)
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index]
          const row = byId[key]
          if (row && row.retainedBy && typeof row.retainedBy === 'object' && row.retainedBy.mainView > 0) {
            if (typeof row.id === 'string' && row.id) return row.id
            return key
          }
        }
      }
      return null
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
        } catch (error) {
          return ''
        }
      }, [ctx])
      const value = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return typeof value === 'string' && value ? value : null
    }

    function useNarrowViewport() {
      const [narrow, setNarrow] = React.useState(function () {
        return typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth < NARROW_WIDTH
      })
      React.useEffect(function () {
        if (typeof window === 'undefined') return undefined
        function update() {
          setNarrow(typeof window.innerWidth === 'number' && window.innerWidth < NARROW_WIDTH)
        }
        update()
        window.addEventListener('resize', update)
        return function () {
          window.removeEventListener('resize', update)
        }
      }, [])
      return narrow
    }

    function useApi(runtime) {
      const controllers = React.useRef(new Set())
      React.useEffect(function () {
        return function () {
          controllers.current.forEach(function (controller) {
            try {
              controller.abort()
            } catch (error) {
              // already settled
            }
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
        const promise = controller ? apiCall(action, payload, controller.signal) : apiCall(action, payload, undefined)
        return promise.finally(function () {
          if (!controller) return
          controllers.current.delete(controller)
          if (runtime && runtime.controllers) runtime.controllers.delete(controller)
        })
      }, [runtime])
    }

    // ---------------------------------------------------------------------------
    // Icon glyphs (currentColor only; no theme tokens needed inside the svg)
    // ---------------------------------------------------------------------------

    function EnvelopeGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', pointerEvents: 'none' },
      },
        h('rect', { key: 'body', x: 2.5, y: 6, width: 17, height: 11.5, rx: 2.5 }),
        h('path', { key: 'flap', d: 'M3.5 8.2l7.5 5 7.5-5' }),
        h('circle', { key: 'dot-a', cx: 20.6, cy: 5.2, r: 1.2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'dot-b', cx: 22.2, cy: 9.4, r: 1.1, fill: 'currentColor', stroke: 'none' })
      )
    }

    function ChevronGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      const expanded = !!(props && props.expanded)
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', pointerEvents: 'none' },
      }, h('path', { d: expanded ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6' }))
    }

    function CloseGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', pointerEvents: 'none' },
      }, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
    }

    function CopyGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', pointerEvents: 'none' },
      },
        h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 2 }),
        h('path', { key: 'b', d: 'M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15' })
      )
    }

    function PencilGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', pointerEvents: 'none' },
      },
        h('path', { key: 'body', d: 'M4 20l4.2-1 10.3-10.3a2.1 2.1 0 0 0-3-3L5.2 16 4 20z' }),
        h('path', { key: 'tip', d: 'M13.6 7.4l3 3' })
      )
    }

    // ---------------------------------------------------------------------------
    // Scoped stylesheet, rendered as a style element inside each root component
    // ---------------------------------------------------------------------------

    const CSS = `
.dshcw-root{height:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px}
.dshcw-scroll{overflow:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dshcw-scroll::-webkit-scrollbar{width:10px;height:10px}
.dshcw-scroll::-webkit-scrollbar-track{background:transparent}
.dshcw-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px}
.dshcw-row{transition:background-color .12s ease;content-visibility:auto;contain-intrinsic-size:56px}
.dshcw-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcw-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshcw-tab:hover{color:var(--dsw-alias-label-primary)}
.dshcw-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshcw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshcw-btn-outline:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcw-btn-ghost:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcw-btn-danger:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcw-btn-primary:not(:disabled):hover{background:var(--dsw-alias-button-primary-hover)}
.dshcw-iconbtn:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcw-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshcw-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
.dshcw-checkbox{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dshcw-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary);position:relative}
.dshcw-switch input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.dshcw-switch-track{display:block;width:34px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2);position:relative;flex:none;transition:background-color .15s ease}
.dshcw-switch-track:before{content:"";position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);display:block;transition:transform .15s ease}
.dshcw-switch input:checked + .dshcw-switch-track{background:var(--dsw-alias-brand-primary)}
.dshcw-switch input:checked + .dshcw-switch-track:before{transform:translateX(14px)}
.dshcw-switch input:focus-visible + .dshcw-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshcw-switch input:disabled + .dshcw-switch-track{opacity:.5}
.dshcw-spinner{display:inline-block;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dshcw-spin .9s linear infinite;flex:none}
.dshcw-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;user-select:text;overflow-wrap:anywhere}
.dshcw-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dshcw-net-layout{display:flex;gap:12px;flex:1;min-height:0;padding:0 14px 12px}
.dshcw-net-side{width:310px;flex:0 0 310px;min-height:0;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dshcw-net-event{background:var(--dsw-alias-bg-layer-2);transition:background-color .12s ease;content-visibility:auto;contain-intrinsic-size:64px}
.dshcw-net-event:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcw-net-event:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media (max-width:900px){.dshcw-net-layout{flex-direction:column;overflow:auto}.dshcw-net-layout > .dshcw-scroll{min-height:280px}.dshcw-net-side{width:auto;flex:none;max-height:320px}}
@keyframes dshcw-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dshcw-spinner{animation:none}.dshcw-row{transition:none}.dshcw-switch-track,.dshcw-switch-track:before{transition:none}}
`

    function Styles() {
      return h('style', null, CSS)
    }

    // ---------------------------------------------------------------------------
    // Reusable primitives
    // ---------------------------------------------------------------------------

    function Button(props) {
      const variant = props.variant || 'outline'
      const style = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 30,
        padding: '0 12px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flex: 'none',
      }
      if (variant === 'primary') {
        style.background = 'var(--dsw-alias-button-primary-fill)'
        style.border = '1px solid var(--dsw-alias-button-primary-fill)'
        style.color = 'var(--dsw-alias-bg-base)'
      } else if (variant === 'ghost') {
        style.background = 'transparent'
        style.border = '1px solid transparent'
      } else if (variant === 'danger') {
        style.color = 'var(--dsw-alias-state-error-primary)'
      }
      if (props.disabled) {
        style.cursor = 'not-allowed'
        style.opacity = 0.6
        if (variant === 'primary') {
          style.background = 'var(--dsw-alias-button-primary-dimmed)'
          style.border = '1px solid var(--dsw-alias-button-primary-dimmed)'
        }
      }
      return h('button', {
        type: 'button',
        className: 'dshcw-btn dshcw-btn-' + variant,
        disabled: !!props.disabled,
        title: props.title,
        'aria-label': props['aria-label'],
        'aria-pressed': props.pressed === undefined ? undefined : (props.pressed ? 'true' : 'false'),
        onClick: props.onClick,
        style: Object.assign(style, props.style || {}),
      }, props.children)
    }

    function IconButton(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 28
      return h('button', {
        type: 'button',
        className: 'dshcw-iconbtn',
        disabled: !!props.disabled,
        title: props.title || props.label,
        'aria-label': props.label,
        onClick: props.onClick,
        style: Object.assign({
          width: size,
          height: size,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          flex: 'none',
          border: '1px solid transparent',
          borderRadius: '8px',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: props.disabled ? 'not-allowed' : 'pointer',
          opacity: props.disabled ? 0.5 : 1,
        }, props.style || {}),
      }, props.children)
    }

    function Badge(props) {
      const tone = props.tone || 'plain'
      const style = {
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
        height: 20,
        padding: '0 7px',
        boxSizing: 'border-box',
        borderRadius: 999,
        border: '.5px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      }
      if (tone === 'brand') {
        style.background = 'var(--dsw-alias-brand-primary)'
        style.border = '.5px solid var(--dsw-alias-brand-primary)'
        style.color = 'var(--dsw-alias-bg-base)'
        style.fontWeight = 600
      } else if (tone === 'success') {
        style.background = 'transparent'
        style.border = '.5px solid var(--dsw-alias-state-success-primary)'
        style.color = 'var(--dsw-alias-state-success-primary)'
      } else if (tone === 'error') {
        style.background = 'transparent'
        style.border = '.5px solid var(--dsw-alias-state-error-primary)'
        style.color = 'var(--dsw-alias-state-error-primary)'
      } else if (tone === 'idle') {
        style.color = 'var(--dsw-alias-state-idle-primary)'
      }
      return h('span', { title: props.title, style: Object.assign(style, props.style || {}) }, props.children)
    }

    function Field(props) {
      return h('label', {
        style: {
          display: 'grid',
          gap: 6,
          minWidth: 0,
          fontSize: 13,
          color: 'var(--dsw-alias-label-secondary)',
        },
      },
        h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, props.label),
        props.children,
        props.hint ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.5 } }, props.hint) : null
      )
    }

    const controlBase = {
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
    }

    function Input(props) {
      const rest = Object.assign({}, props)
      delete rest.style
      delete rest.className
      delete rest.children
      return h('input', Object.assign({ type: 'text', className: 'dshcw-input' }, rest, {
        className: 'dshcw-input' + (props.className ? ' ' + props.className : ''),
        style: Object.assign({}, controlBase, { height: 32, padding: '0 10px' }, props.style || {}),
      }))
    }

    function Textarea(props) {
      const rest = Object.assign({}, props)
      delete rest.style
      delete rest.className
      delete rest.children
      return h('textarea', Object.assign({ className: 'dshcw-input' }, rest, {
        className: 'dshcw-input' + (props.className ? ' ' + props.className : ''),
        style: Object.assign({}, controlBase, { minHeight: 84, padding: '8px 10px', lineHeight: 1.5, resize: 'vertical' }, props.style || {}),
      }))
    }

    function Select(props) {
      const rest = Object.assign({}, props)
      delete rest.style
      delete rest.className
      delete rest.children
      return h('select', Object.assign({ className: 'dshcw-input' }, rest, {
        className: 'dshcw-input' + (props.className ? ' ' + props.className : ''),
        style: Object.assign({}, controlBase, { height: 32, padding: '0 8px' }, props.style || {}),
      }), props.children)
    }

    function Checkbox(props) {
      return h('label', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--dsw-alias-label-primary)',
          cursor: props.disabled ? 'not-allowed' : 'pointer',
          opacity: props.disabled ? 0.6 : 1,
        },
      },
        h('input', {
          type: 'checkbox',
          className: 'dshcw-checkbox',
          checked: !!props.checked,
          disabled: !!props.disabled,
          onChange: props.onChange,
        }),
        h('span', null, props.label)
      )
    }

    function Switch(props) {
      return h('label', { className: 'dshcw-switch' },
        h('input', {
          type: 'checkbox',
          checked: !!props.checked,
          disabled: !!props.disabled,
          onChange: props.onChange,
          'aria-label': props.label,
        }),
        h('span', { className: 'dshcw-switch-track', 'aria-hidden': 'true' }),
        h('span', null, props.label)
      )
    }

    function Spinner(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
      return h('span', {
        role: 'status',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 12,
        },
      },
        h('span', { className: 'dshcw-spinner', 'aria-hidden': 'true', style: { width: size, height: size } }),
        props.label ? h('span', null, props.label) : null
      )
    }

    function EmptyState(props) {
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          textAlign: 'center',
          padding: '28px 20px',
          minHeight: 140,
          color: 'var(--dsw-alias-label-secondary)',
        },
      },
        h('div', { style: { fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } }, props.title),
        props.description ? h('div', { style: { fontSize: 12, lineHeight: 1.6, maxWidth: 380 } }, props.description) : null,
        props.action || null
      )
    }

    function AlertBanner(props) {
      const tone = props.tone || 'error'
      const color = tone === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : tone === 'success'
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-label-primary)'
      return h('div', {
        role: props.role || 'alert',
        style: Object.assign({
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '8px 10px',
          boxSizing: 'border-box',
          borderRadius: '8px',
          border: '.5px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: color,
          fontSize: 12,
          lineHeight: 1.6,
          marginBottom: 10,
        }, props.style || {}),
      },
        h('div', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, props.children),
        props.onDismiss
          ? h(IconButton, { label: props.dismissLabel || 'Dismiss', size: 22, onClick: props.onDismiss }, h(CloseGlyph, { size: 13 }))
          : null
      )
    }

    function CopyTextButton(props) {
      const [state, setState] = React.useState('idle')
      const timer = React.useRef(null)
      React.useEffect(function () {
        return function () {
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])
      function onCopy() {
        if (timer.current) clearTimeout(timer.current)
        copyText(props.text).then(function (ok) {
          setState(ok ? 'copied' : 'failed')
          timer.current = setTimeout(function () { setState('idle') }, 1600)
        }).catch(function () {
          setState('failed')
          timer.current = setTimeout(function () { setState('idle') }, 1600)
        })
      }
      const label = state === 'copied' ? props.t('已复制', 'Copied')
        : state === 'failed' ? props.t('无法复制', 'Copy failed')
          : props.label || props.t('复制', 'Copy')
      return h(Button, {
        variant: 'ghost',
        onClick: onCopy,
        title: label,
        'aria-label': label,
        style: { minHeight: 24, padding: '0 8px', fontSize: 12 },
      }, label)
    }

    function SettingRow(props) {
      return h('div', {
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 16px',
          alignItems: 'flex-start',
          padding: '14px 0',
          borderBottom: props.last ? 'none' : '.5px solid var(--dsw-alias-border-l2)',
        },
      },
        h('div', { style: { flex: '1 1 220px', minWidth: 160 } },
          h('div', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' } }, props.label),
          props.hint ? h('div', { style: { fontSize: 11, lineHeight: '16px', marginTop: 2, color: 'var(--dsw-alias-label-tertiary)' } }, props.hint) : null
        ),
        h('div', { style: { flex: '0 1 280px', minWidth: 150, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 } }, props.children)
      )
    }

    function SettingsCard(props) {
      return h('section', {
        style: {
          border: '.5px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          borderRadius: '12px',
          padding: '0 14px',
        },
      },
        h('div', { style: { padding: '14px 0 2px' } },
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, props.title),
          props.description ? h('p', { style: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } }, props.description) : null
        ),
        props.children,
        props.footer ? h('div', {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            justifyContent: 'flex-end',
            padding: '12px 0',
            borderTop: '.5px solid var(--dsw-alias-border-l2)',
          },
        }, props.footer) : null
      )
    }

    // ---------------------------------------------------------------------------
    // Management page
    // ---------------------------------------------------------------------------

    function ManagementPage(props) {
      const ctx = props.ctx
      const runtime = props.runtime
      const t = useText(ctx)
      const call = useApi(runtime)
      const narrow = useNarrowViewport()
      const sessionsSnapshot = useSessionsSnapshot(props)
      const browserSessionId = useUiWorkspaceSessionId(ctx)
      const mySessionId = sessionIdFromSessions(sessionsSnapshot) || browserSessionId

      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [refreshing, setRefreshing] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [filter, setFilter] = React.useState('inbox')
      const [workspacePathFilter, setWorkspacePathFilter] = React.useState(null)
      const [groupIdFilter, setGroupIdFilter] = React.useState(null)
      const [selectedSessionId, setSelectedSessionId] = React.useState(null)
      const [expanded, setExpanded] = React.useState({})
      const [detail, setDetail] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [compose, setCompose] = React.useState(null)
      const [groupEditor, setGroupEditor] = React.useState(null)
      const [detailBusy, setDetailBusy] = React.useState('')
      const [lastRefreshAt, setLastRefreshAt] = React.useState(0)
      const [markingAll, setMarkingAll] = React.useState(false)

      const busyRef = React.useRef(false)
      const seqRef = React.useRef(0)
      const loadedRef = React.useRef(false)
      const expandedInitRef = React.useRef(false)
      const loadRef = React.useRef(null)
      const viewerRef = React.useRef(mySessionId)
      const stateSigRef = React.useRef('')
      const lastStateAtRef = React.useRef(0)
      const uiBusyRef = React.useRef(false)
      const mountedRef = React.useRef(true)

      React.useEffect(function () {
        mountedRef.current = true
        return function () { mountedRef.current = false }
      }, [])

      React.useEffect(function () {
        uiBusyRef.current = !!(compose || groupEditor || detail)
      }, [compose, groupEditor, detail])

      React.useEffect(function () {
        if (viewerRef.current === mySessionId) return
        viewerRef.current = mySessionId
        setDetail(null)
        setCompose(null)
      }, [mySessionId])

      const requestFilter = filter === 'inbox' ? 'inbox' : 'all'

      const load = React.useCallback(async function (options) {
        const opts = options || {}
        if (opts.poll && (busyRef.current || uiBusyRef.current)) return
        const seq = ++seqRef.current
        busyRef.current = true
        if (opts.initial && !loadedRef.current) setLoading(true)
        if (!opts.quiet) setRefreshing(true)
        if (opts.force) setError('')
        try {
          const payload = { filter: requestFilter, limit: LIMIT }
          if (mySessionId) payload.sessionId = mySessionId
          if (workspacePathFilter) payload.workspacePathFilter = workspacePathFilter
          if (groupIdFilter) payload.groupIdFilter = groupIdFilter
          const value = await call('state', payload)
          if (seq !== seqRef.current || mountedRef.current === false) return
          const signature = stateSignature(value)
          const changed = loadedRef.current === false || opts.force === true || signature !== stateSigRef.current
          stateSigRef.current = signature
          const at = Date.now()
          if (!changed) {
            // The data is identical; avoid re-rendering the whole panel just
            // because the server timestamp moved. Refresh relative times at most
            // once per minute by replacing only `now`.
            setError('')
            if (at - lastStateAtRef.current > 60000) {
              lastStateAtRef.current = at
              setLastRefreshAt(at)
              setData(function (current) {
                return current ? Object.assign({}, current, { now: at }) : current
              })
            }
            return
          }
          lastStateAtRef.current = at
          setData(value || null)
          setLastRefreshAt(at)
          setError('')
          loadedRef.current = true
        } catch (reason) {
          if (!mountedRef.current) return
          if (isAbortError(reason)) return
          if (seq !== seqRef.current) return
          setError(errorMessage(reason, t))
        } finally {
          if (mountedRef.current && seq === seqRef.current) {
            busyRef.current = false
            setLoading(false)
            setRefreshing(false)
          }
        }
      }, [call, requestFilter, mySessionId, workspacePathFilter, groupIdFilter, t])

      loadRef.current = load

      React.useEffect(function () {
        void load({ initial: !loadedRef.current })
      }, [load])

      React.useEffect(function () {
        let timer
        let stopped = false
        function delay() {
          if (typeof document !== 'undefined' && document.hidden === true) return POLL_HIDDEN_MS
          if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus() === false) {
            return POLL_BACKGROUND_MS
          }
          return POLL_INTERVAL_MS
        }
        function schedule() {
          if (stopped) return
          clearTimeout(timer)
          timer = setTimeout(function () {
            if (typeof document !== 'undefined' && document.hidden === true) {
              schedule()
              return
            }
            void Promise.resolve(loadRef.current({ quiet: true, poll: true })).then(schedule, schedule)
          }, delay())
        }
        function refreshNow() {
          if (typeof document !== 'undefined' && document.hidden === true) {
            schedule()
            return
          }
          clearTimeout(timer)
          void Promise.resolve(loadRef.current({ quiet: true, poll: true })).then(schedule, schedule)
        }
        schedule()
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', refreshNow)
        }
        function onBlur() {
          schedule()
        }
        if (typeof window !== 'undefined') {
          window.addEventListener('focus', refreshNow)
          window.addEventListener('blur', onBlur)
        }
        return function () {
          stopped = true
          clearTimeout(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refreshNow)
          if (typeof window !== 'undefined') {
            window.removeEventListener('focus', refreshNow)
            window.removeEventListener('blur', onBlur)
          }
        }
      }, [])

      const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : []
      const groups = data && Array.isArray(data.groups) ? data.groups : []
      const rawMessages = data && Array.isArray(data.messages) ? data.messages : []
      const now = data && typeof data.now === 'number' ? data.now : Date.now()
      const unreadTotal = data && typeof data.unreadTotal === 'number' ? data.unreadTotal : 0
      const settings = data && data.settings && typeof data.settings === 'object' ? data.settings : {}
      const allowWake = settings.allowWake !== false
      const maxGroupMembers = typeof settings.maxGroupMembers === 'number' && settings.maxGroupMembers > 0 ? settings.maxGroupMembers : 32
      const sessionDirectory = React.useMemo(function () { return buildSessionDirectory(data) }, [data])
      const activeGroup = groupIdFilter ? groups.find(function (group) { return group && group.id === groupIdFilter }) || null : null

      const messages = React.useMemo(function () {
        if (filter !== 'sent') return rawMessages
        const sender = mySessionId || (data && data.viewer && typeof data.viewer.sessionId === 'string' ? data.viewer.sessionId : '')
        if (!sender) return []
        return rawMessages.filter(function (mail) {
          return !!mail && !!mail.from && mail.from.sessionId === sender
        })
      }, [filter, rawMessages, mySessionId, data])

      React.useEffect(function () {
        if (!data || expandedInitRef.current) return
        expandedInitRef.current = true
        const initial = {}
        let target = null
        if (mySessionId && Array.isArray(data.workspaces)) {
          target = data.workspaces.find(function (workspace) {
            return workspace && Array.isArray(workspace.sessions) && workspace.sessions.some(function (session) {
              return session && session.sessionId === mySessionId
            })
          }) || null
        }
        if (target && target.path) initial[target.path] = true
        else if (workspacePathFilter) initial[workspacePathFilter] = true
        if (Object.keys(initial).length) setExpanded(initial)
      }, [data, mySessionId, workspacePathFilter])

      function refreshNow() {
        void load({ force: true })
      }

      function markAllRead() {
        if (markingAll) return
        setMarkingAll(true)
        setError('')
        call('markAll', {}).then(function (value) {
          const count = value && typeof value.marked === 'number' ? value.marked : 0
          setNotice(t('已全部标记已读：', 'Marked all read: ') + count + t(' 条消息。', ' messages.'))
          void load({ force: true })
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setMarkingAll(false)
        })
      }

      function toggleWorkspace(path) {
        setExpanded(function (previous) {
          const next = Object.assign({}, previous)
          if (next[path]) delete next[path]
          else next[path] = true
          return next
        })
      }

      function selectAllWorkspaces() {
        setWorkspacePathFilter(null)
        setGroupIdFilter(null)
        setSelectedSessionId(null)
        setDetail(null)
        setCompose(null)
      }

      function selectWorkspace(workspace) {
        if (!workspace || typeof workspace.path !== 'string' || !workspace.path) return
        setWorkspacePathFilter(workspace.path)
        setGroupIdFilter(null)
        setSelectedSessionId(null)
        setDetail(null)
        setExpanded(function (previous) {
          if (previous[workspace.path]) return previous
          const next = Object.assign({}, previous)
          next[workspace.path] = true
          return next
        })
      }

      function selectSession(workspace, session) {
        if (!workspace || typeof workspace.path !== 'string' || !workspace.path || !session) return
        setWorkspacePathFilter(workspace.path)
        setGroupIdFilter(null)
        setSelectedSessionId(typeof session.sessionId === 'string' ? session.sessionId : null)
        setDetail(null)
      }

      function selectGroup(group) {
        if (!group || typeof group.id !== 'string' || !group.id) return
        setGroupIdFilter(group.id)
        setWorkspacePathFilter(null)
        setSelectedSessionId(null)
        setDetail(null)
      }

      function startCreateGroup() {
        setGroupEditor({ mode: 'create', group: null })
        setCompose(null)
        setDetail(null)
        setNotice('')
      }

      function startEditGroup(group) {
        setGroupEditor({ mode: 'edit', group: group || null })
        setCompose(null)
        setDetail(null)
        setNotice('')
      }

      function cancelGroupEditor() {
        setGroupEditor(null)
      }

      function handleGroupSaved(value, mode) {
        const group = value && value.group ? value.group : null
        setGroupEditor(null)
        if (group) {
          setNotice(mode === 'create'
            ? t('群组已创建：', 'Group created: ') + group.name
            : t('群组已更新：', 'Group updated: ') + group.name)
          if (mode === 'create' && typeof group.id === 'string') {
            setGroupIdFilter(group.id)
            setWorkspacePathFilter(null)
            setSelectedSessionId(null)
          }
        }
        void load({ quiet: true, force: true })
      }

      function handleGroupDeleted(id) {
        setGroupEditor(null)
        setNotice(t('群组已删除；已发出的群组消息仍留在信箱里。', 'Group deleted; messages already sent to it remain in mailboxes.'))
        if (groupIdFilter === id) setGroupIdFilter(null)
        setCompose(function (current) {
          if (current && current.initialTargetGroupId === id) return null
          return current
        })
        setDetail(function (current) {
          if (current && current.to && current.to.groupId === id) return null
          return current
        })
        void load({ quiet: true, force: true })
      }

      function startCompose() {
        if (!data) return
        const selected = workspacePathFilter ? workspaces.find(function (workspace) { return workspace.path === workspacePathFilter }) : null
        const initialWorkspace = (selected || workspaces[0] || {}).path || ''
        setCompose({
          kind: 'new',
          replyTo: null,
          returnToDetail: null,
          initialTargetWorkspace: initialWorkspace,
          initialTargetGroupId: groupIdFilter || '',
        })
        setDetail(null)
        setNotice('')
      }

      function startReply() {
        if (!detail) return
        if (mySessionId && detail.from && detail.from.sessionId === mySessionId) {
          setNotice(t('不能回复自己发出的消息。', 'You cannot reply to a message you sent.'))
          return
        }
        if (detail.to && typeof detail.to.groupId === 'string' && detail.to.groupId) {
          const existing = groups.find(function (group) { return group && group.id === detail.to.groupId })
          if (!existing) {
            setNotice(t('该群组已被删除，无法回复群组消息。', 'That group was deleted, so the group message cannot be replied to.'))
            return
          }
        }
        setCompose({ kind: 'reply', replyTo: detail, returnToDetail: detail })
        setNotice('')
      }

      function cancelCompose() {
        const current = compose
        setCompose(null)
        if (current && current.returnToDetail) setDetail(current.returnToDetail)
      }

      function handleSent(value) {
        setCompose(null)
        setNotice(sendSummary(value, t))
        const mail = value && value.message ? value.message : null
        if (mail) {
          setDetail(mail)
          const targetPath = mail.to && typeof mail.to.workspacePath === 'string' ? mail.to.workspacePath : ''
          if (targetPath) {
            setExpanded(function (previous) {
              if (previous[targetPath]) return previous
              const next = Object.assign({}, previous)
              next[targetPath] = true
              return next
            })
          }
        }
        void load({ quiet: true, force: true })
      }

      function startEdit(mail) {
        if (!mail) return
        setNotice('')
        setDetail(null)
        setCompose(null)
        setEditing(mail)
      }

      function handleEdited(message) {
        setEditing(null)
        if (message) setDetail(message)
        setNotice(t('消息已编辑。', 'Message updated.'))
        void load({ quiet: true, force: true })
      }

      function openMessage(mail) {
        if (!mail) return
        setEditing(null)
        setCompose(null)
        setNotice('')
        setDetail(mail)
        if (mail.read === true) return
        const viewer = viewerPayload(mySessionId, data)
        if (!viewer.sessionId && !viewer.workspacePath) return
        setDetailBusy('read')
        call('read', Object.assign({ id: mail.id }, viewer)).then(function (value) {
          if (value && value.message) {
            setDetail(function (current) {
              return current && current.id === value.message.id ? value.message : current
            })
          }
          void load({ quiet: true })
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setDetailBusy('')
        })
      }

      function markUnread() {
        if (!detail) return
        const viewer = viewerPayload(mySessionId, data)
        setDetailBusy('mark')
        call('mark', Object.assign({ id: detail.id, read: false }, viewer)).then(function (value) {
          if (value && value.message) setDetail(value.message)
          void load({ quiet: true })
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setDetailBusy('')
        })
      }

      function wakeDeliver() {
        if (!detail) return
        setDetailBusy('deliver')
        call('deliver', { id: detail.id }).then(function (value) {
          if (value && value.message) {
            setDetail(function (current) {
              if (!current) return value.message
              // The deliver action returns the message without a viewer key, so keep
              // the local read state instead of letting it flip back to unread.
              return Object.assign({}, value.message, { read: current.read === true || value.message.read === true })
            })
          }
          setNotice(t('补投递完成：', 'Delivery attempted: ') + deliveryBadgeLabel(value && value.delivery ? value.delivery : null, t))
          void load({ quiet: true })
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setDetailBusy('')
        })
      }

      function deleteMessage() {
        if (!detail) return
        if (!safeConfirm(t('确定删除这条消息？删除后无法恢复。', 'Delete this message? This cannot be undone.'))) return
        setDetailBusy('delete')
        call('delete', { id: detail.id }).then(function () {
          setDetail(null)
          setNotice(t('消息已删除', 'Message deleted'))
          void load({ force: true })
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setDetailBusy('')
        })
      }

      const hasViewer = !!(mySessionId || (data && data.viewer && (data.viewer.sessionId || data.viewer.workspacePath)))
      // In a session view the host reports the viewer's unread total; in the
      // management view it reports 0, so aggregate the per-workspace management
      // counts for the header pill and the "all workspaces" row.
      const workspaceUnreadTotal = workspaces.reduce(function (sum, workspace) {
        return sum + (workspace && typeof workspace.unread === 'number' ? workspace.unread : 0)
      }, 0)
      const displayUnread = hasViewer ? unreadTotal : workspaceUnreadTotal
      const viewerLabel = mySessionId
        ? t('查看者会话：', 'Viewer session: ') + mySessionId
        : t('管理视角：未选中会话，未读数只包含工作区广播', 'Management view: no session selected; unread counts cover workspace broadcasts only')

      const gridStyle = narrow
        ? {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            gridTemplateRows: 'minmax(150px, 38%) minmax(0, 1fr)',
            gap: 10,
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
          }
        : {
            display: 'grid',
            gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)',
            gap: 12,
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
          }

      const rightColumnStyle = {
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
      }

      let rightContent = null
      if (groupEditor) {
        rightContent = h(GroupEditorView, {
          key: 'group-editor',
          t: t,
          call: call,
          data: data,
          groups: groups,
          sessionDirectory: sessionDirectory,
          group: groupEditor.group,
          mode: groupEditor.mode,
          maxGroupMembers: maxGroupMembers,
          onCancel: cancelGroupEditor,
          onSaved: handleGroupSaved,
          onDeleted: handleGroupDeleted,
        })
      } else if (compose) {
        rightContent = h(ComposeView, {
          key: 'compose',
          t: t,
          call: call,
          data: data,
          groups: groups,
          sessionDirectory: sessionDirectory,
          mySessionId: mySessionId,
          kind: compose.kind,
          replyTo: compose.replyTo,
          initialTargetWorkspace: compose.initialTargetWorkspace || '',
          initialTargetGroupId: compose.initialTargetGroupId || '',
          allowWake: allowWake,
          onCancel: cancelCompose,
          onSent: handleSent,
        })
      } else if (editing) {
        rightContent = h(MessageEditView, {
          key: 'edit',
          t: t,
          call: call,
          mail: editing,
          viewer: viewerPayload(mySessionId, data),
          onCancel: function () { setDetail(editing); setEditing(null) },
          onSaved: handleEdited,
        })
      } else if (detail) {
        rightContent = h(MessageDetail, {
          key: 'detail',
          t: t,
          mail: detail,
          busy: detailBusy,
          mySessionId: mySessionId,
          groups: groups,
          sessionDirectory: sessionDirectory,
          allowWorkspaceBroadcast: settings.allowWorkspaceBroadcast === true,
          onBack: function () { setDetail(null) },
          onMarkUnread: markUnread,
          onWake: wakeDeliver,
          onReply: startReply,
          onEdit: function () { startEdit(detail) },
          onDelete: deleteMessage,
        })
      } else {
        rightContent = h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
          h(FilterTabs, {
            t: t,
            value: filter,
            count: messages.length,
            onChange: function (next) {
              if (next === filter) return
              setFilter(next)
              setDetail(null)
            },
          }),
          (workspacePathFilter || groupIdFilter)
            ? h('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 10px',
                  flex: 'none',
                  borderBottom: '.5px solid var(--dsw-alias-border-l1)',
                  fontSize: 11,
                  color: 'var(--dsw-alias-label-secondary)',
                },
              },
                h('span', { className: 'dshcw-truncate', style: { flex: 1 } },
                  t('筛选：', 'Filter: ') + (activeGroup
                    ? t('群组「', 'Group “') + activeGroup.name + t('」', '”')
                    : (workspacePathFilter
                        ? (workspaces.find(function (workspace) { return workspace.path === workspacePathFilter }) || {}).title || workspacePathFilter
                        : (groupIdFilter ? t('群组 ', 'Group ') + shortId(groupIdFilter) : '')))),
                h(Button, {
                  variant: 'ghost',
                  onClick: selectAllWorkspaces,
                  style: { minHeight: 22, padding: '0 6px', fontSize: 11 },
                }, t('清除', 'Clear'))
              )
            : null,
          filter === 'graph'
            ? h(InteractionGraph, {
                key: 'graph',
                t: t,
                messages: messages,
                workspaces: workspaces,
                groups: groups,
                sessionDirectory: sessionDirectory,
                mySessionId: mySessionId,
                now: now,
                onOpen: openMessage,
              })
            : h('div', { className: 'dshcw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto' } },
            (!data && loading)
              ? h('div', { key: 'loading', style: { padding: 24, display: 'flex', justifyContent: 'center' } }, h(Spinner, { label: t('正在加载消息…', 'Loading messages…') }))
              : (!data && error)
                ? h('div', { key: 'error', style: { padding: 16 } },
                    h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8, overflowWrap: 'anywhere' } }, error),
                    h(Button, { variant: 'outline', onClick: refreshNow }, t('重试', 'Retry')))
                : messages.length === 0
                  ? h(EmptyState, {
                      key: 'empty',
                      title: filter === 'inbox'
                        ? t('收件箱是空的', 'Your inbox is empty')
                        : filter === 'sent'
                          ? t('还没有已发送的消息', 'Nothing sent yet')
                          : t('还没有任何消息', 'No messages yet'),
                      description: filter === 'sent'
                        ? (mySessionId
                            ? t('在这个会话里发出的消息会出现在这里。', 'Messages sent from the current session appear here.')
                            : t('未选中会话时无法判断“已发送”，请先打开一个会话。', 'Without a selected session the sent view has no sender; open a session first.'))
                        : filter === 'inbox' && !hasViewer
                          ? t('未选中会话时收件箱为空；切换到「全部」可以按管理视角浏览所有消息。', 'With no session selected the inbox is empty; switch to “All” to browse every message from a management view.')
                          : t('让 Agent 使用 mail_send 工具，或点击“新消息”发起一条跨工作区消息。', 'Ask an agent to use the mail_send tool, or click “New message” to start one.'),
                    })
                  : messages.map(function (mail) {
                      return h(MessageRow, {
                        key: mail.id,
                        t: t,
                        mail: mail,
                        now: now,
                        active: false,
                        onOpen: openMessage,
                      })
                    })
          )
        )
      }

      return h('div', {
        className: 'dshcw-root',
        style: {
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          boxSizing: 'border-box',
          paddingTop: 'calc(14px + var(--dsh-frame-top-clearance, 0px))',
          paddingLeft: 'max(14px, var(--dsh-frame-leading-clearance, 0px))',
          paddingRight: 14,
          paddingBottom: 14,
          color: 'var(--dsw-alias-label-primary)',
        },
      },
        h(Styles, { key: 'styles' }),
        h('header', {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
            flex: 'none',
            paddingBottom: 10,
          },
        },
          h('div', { style: { minWidth: 0, flex: '1 1 260px' } },
            h('h1', {
              style: {
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 18,
                lineHeight: '24px',
                fontWeight: 600,
                color: 'var(--dsw-alias-label-primary)',
              },
            },
              h('span', null, t('跨工作区信使', 'Cross-workspace courier')),
              h(Badge, { tone: 'brand', title: t('未读总数', 'Total unread') }, String(displayUnread))
            ),
            h('div', {
              style: {
                marginTop: 2,
                fontSize: 11,
                lineHeight: '16px',
                color: 'var(--dsw-alias-label-tertiary)',
                overflowWrap: 'anywhere',
              },
            }, viewerLabel)
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
            lastRefreshAt
              ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, t('最后刷新 ', 'Updated ') + formatClock(lastRefreshAt))
              : null,
            refreshing ? h(Spinner, { size: 14 }) : null,
            h(Button, { variant: 'outline', onClick: refreshNow, disabled: loading || refreshing }, t('刷新', 'Refresh')),
            h(Button, { variant: 'outline', onClick: markAllRead, disabled: markingAll || !data }, markingAll ? t('处理中…', 'Marking…') : t('全部已读', 'Mark all read')),
            h(Button, { variant: 'outline', onClick: startCreateGroup, disabled: !data }, t('新建群组', 'New group')),
            h(Button, { variant: 'primary', onClick: startCompose, disabled: !data || (workspaces.length === 0 && groups.length === 0) }, t('新消息', 'New message'))
          )
        ),
        error ? h(AlertBanner, { onDismiss: function () { setError('') }, dismissLabel: t('关闭', 'Dismiss') }, error) : null,
        notice
          ? h(AlertBanner, { tone: 'success', role: 'status', onDismiss: function () { setNotice('') }, dismissLabel: t('关闭', 'Dismiss') }, notice)
          : null,
        h('div', { style: gridStyle },
          h(WorkspaceColumn, {
            key: 'workspaces',
            t: t,
            workspaces: workspaces,
            groups: groups,
            unreadTotal: displayUnread,
            expanded: expanded,
            workspacePathFilter: workspacePathFilter,
            groupIdFilter: groupIdFilter,
            selectedSessionId: selectedSessionId,
            now: now,
            hasData: data !== null,
            loading: loading,
            error: error,
            onToggle: toggleWorkspace,
            onSelectAll: selectAllWorkspaces,
            onSelectWorkspace: selectWorkspace,
            onSelectSession: selectSession,
            onSelectGroup: selectGroup,
            onEditGroup: startEditGroup,
            onCreateGroup: startCreateGroup,
            onRetry: refreshNow,
          }),
          h('section', { key: 'content', style: rightColumnStyle }, rightContent)
        )
      )
    }

    function WorkspaceColumn(props) {
      const t = props.t
      const workspaces = Array.isArray(props.workspaces) ? props.workspaces : []
      const groups = Array.isArray(props.groups) ? props.groups : []
      const noFilter = props.workspacePathFilter === null && props.groupIdFilter === null
      let body = null
      if (!props.hasData && props.loading) {
        body = h('div', { style: { padding: '20px 8px', display: 'flex', justifyContent: 'center' } },
          h(Spinner, { label: t('正在加载工作区…', 'Loading workspaces…') }))
      } else if (!props.hasData && props.error) {
        body = h('div', { style: { padding: '12px 8px' } },
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8, overflowWrap: 'anywhere' } }, props.error),
          h(Button, { variant: 'outline', onClick: props.onRetry }, t('重试', 'Retry')))
      } else if (workspaces.length === 0 && groups.length === 0) {
        body = h(EmptyState, {
          title: t('还没有可用工作区', 'No workspaces yet'),
          description: t('打开一个工作区之后，这里会列出它的会话与未读消息。', 'Open a workspace and its sessions and unread messages appear here.'),
        })
      } else {
        const rows = []
        rows.push(h('button', {
          key: 'all',
          type: 'button',
          className: 'dshcw-row',
          'aria-pressed': noFilter,
          onClick: props.onSelectAll,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            textAlign: 'left',
            boxSizing: 'border-box',
            marginBottom: 6,
            padding: '8px 10px',
            border: '1px solid ' + (noFilter ? 'var(--dsw-alias-border-l2)' : 'transparent'),
            borderRadius: '8px',
            background: noFilter ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            font: 'inherit',
            cursor: 'pointer',
          },
        },
          h('span', { style: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 } }, t('全部工作区', 'All workspaces')),
          props.unreadTotal > 0 ? h(Badge, { tone: 'brand' }, String(props.unreadTotal)) : null
        ))
        workspaces.forEach(function (workspace) {
          const path = typeof workspace.path === 'string' ? workspace.path : ''
          const title = workspace.title || basename(path) || path
          const active = props.workspacePathFilter === path
          const open = props.expanded[path] === true
          const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : []
          const group = []
          group.push(h('div', {
            key: 'head',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              marginBottom: 2,
              borderRadius: '8px',
              background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            },
          },
            h(IconButton, {
              label: open ? t('收起会话', 'Collapse sessions') : t('展开会话', 'Expand sessions'),
              size: 24,
              onClick: function () { props.onToggle(path) },
            }, h(ChevronGlyph, { expanded: open })),
            h('button', {
              type: 'button',
              className: 'dshcw-row',
              'aria-pressed': active,
              onClick: function () { props.onSelectWorkspace(workspace) },
              style: {
                flex: 1,
                minWidth: 0,
                display: 'grid',
                gap: 1,
                textAlign: 'left',
                border: '0',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                padding: '5px 4px',
                borderRadius: '8px',
                cursor: 'pointer',
              },
            },
              h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                h('span', {
                  className: 'dshcw-truncate',
                  style: {
                    flex: 1,
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                    color: 'var(--dsw-alias-label-primary)',
                  },
                }, title),
                workspace.unread > 0 ? h(Badge, { tone: 'brand' }, String(workspace.unread)) : null
              ),
              h('span', {
                className: 'dshcw-truncate',
                title: path,
                style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
              }, path)
            )
          ))
          if (open) {
            if (sessions.length === 0) {
              group.push(h('div', {
                key: 'none',
                style: { padding: '2px 8px 6px 24px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
              }, t('这个工作区还没有会话', 'No sessions in this workspace')))
            } else {
              group.push(h('div', {
                key: 'sessions',
                style: { display: 'grid', gap: 1, padding: '2px 0 6px 22px' },
              }, sessions.map(function (session) {
                const sessionId = typeof session.sessionId === 'string' ? session.sessionId : ''
                const selected = active && props.selectedSessionId === sessionId
                const sessionTitle = typeof session.title === 'string' && session.title ? session.title : shortId(sessionId)
                return h('button', {
                  key: 's:' + sessionId,
                  type: 'button',
                  className: 'dshcw-row',
                  'aria-pressed': selected,
                  onClick: function () { props.onSelectSession(workspace, session) },
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    width: '100%',
                    boxSizing: 'border-box',
                    textAlign: 'left',
                    border: '0',
                    padding: '5px 6px',
                    borderRadius: '8px',
                    background: selected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                    color: 'var(--dsw-alias-label-primary)',
                    font: 'inherit',
                    cursor: 'pointer',
                  },
                },
                  h('span', {
                    'aria-hidden': 'true',
                    title: session.running ? t('运行中', 'Running') : '',
                    style: {
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      flex: 'none',
                      background: session.running ? 'var(--dsw-alias-state-success-primary)' : 'transparent',
                      border: session.running ? 'none' : '.5px solid var(--dsw-alias-border-l1)',
                    },
                  }),
                  h('span', { className: 'dshcw-truncate', style: { flex: 1, fontSize: 12 } }, sessionTitle || t('会话', 'Session')),
                  h('span', { style: { flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } }, relativeTime(session.updatedAt, props.now, t)),
                  session.unread > 0 ? h(Badge, { tone: 'brand' }, String(session.unread)) : null
                )
              })))
            }
          }
          rows.push(h('div', { key: 'w:' + path }, group))
        })
        rows.push(h('div', {
          key: 'groups',
          style: {
            marginTop: 10,
            paddingTop: 8,
            borderTop: '.5px solid var(--dsw-alias-border-l1)',
          },
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px 6px' },
          },
            h('span', { style: { flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, t('群组', 'Groups')),
            groups.length ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, String(groups.length)) : null,
            h(Button, {
              variant: 'ghost',
              onClick: props.onCreateGroup,
              style: { minHeight: 22, padding: '0 6px', fontSize: 11 },
            }, t('新建', 'New'))
          ),
          groups.length === 0
            ? h('div', {
                style: { padding: '2px 8px 6px', fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
              }, t('把几个会话拉进一个群组，就能跨工作区群聊；新成员看不到加入前的旧消息。', 'Pull sessions into a group for cross-workspace group chat; new members cannot see older messages.'))
            : groups.map(function (group) {
                const active = props.groupIdFilter === group.id
                const memberCount = typeof group.memberCount === 'number'
                  ? group.memberCount
                  : (Array.isArray(group.members) ? group.members.length : 0)
                return h('div', {
                  key: 'g:' + group.id,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    marginBottom: 2,
                    borderRadius: '8px',
                    background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  },
                },
                  h('button', {
                    type: 'button',
                    className: 'dshcw-row',
                    'aria-pressed': active,
                    onClick: function () { props.onSelectGroup(group) },
                    style: {
                      flex: 1,
                      minWidth: 0,
                      display: 'grid',
                      gap: 1,
                      textAlign: 'left',
                      border: '0',
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      padding: '6px 8px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                    },
                  },
                    h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                      h('span', {
                        className: 'dshcw-truncate',
                        title: group.name || group.id,
                        style: { flex: 1, fontSize: 13, fontWeight: active ? 600 : 500, color: 'var(--dsw-alias-label-primary)' },
                      }, clipText(group.name || group.id, 24)),
                      typeof group.unread === 'number' && group.unread > 0 ? h(Badge, { tone: 'brand' }, String(group.unread)) : null
                    ),
                    h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
                      memberCount + t(' 位成员', ' members'))
                  ),
                  h(IconButton, {
                    label: t('编辑群组 ', 'Edit group ') + (group.name || group.id),
                    size: 24,
                    onClick: function () { props.onEditGroup(group) },
                  }, h(PencilGlyph, { size: 13 }))
                )
              })
        ))
        body = h('div', null, rows)
      }

      return h('aside', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '12px',
          background: 'var(--dsw-alias-bg-layer-1)',
          overflow: 'hidden',
        },
      },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 12px',
            borderBottom: '.5px solid var(--dsw-alias-border-l1)',
            flex: 'none',
          },
        },
          h('span', { style: { flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, t('工作区与会话', 'Workspaces & sessions')),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, workspaces.length + t(' 个工作区', ' workspaces'))
        ),
        h('div', { className: 'dshcw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 6 } }, body)
      )
    }

    function FilterTabs(props) {
      const t = props.t
      const items = [
        { id: 'inbox', label: t('收件箱', 'Inbox') },
        { id: 'all', label: t('全部', 'All') },
        { id: 'sent', label: t('已发送', 'Sent') },
        { id: 'graph', label: t('交流图', 'Graph') },
      ]
      return h('div', {
        role: 'tablist',
        'aria-label': t('消息筛选', 'Message filter'),
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '8px 10px',
          flex: 'none',
          borderBottom: '.5px solid var(--dsw-alias-border-l1)',
        },
      },
        items.map(function (item) {
          const active = item.id === props.value
          return h('button', {
            key: item.id,
            type: 'button',
            role: 'tab',
            'aria-selected': active,
            className: 'dshcw-tab',
            onClick: function () { props.onChange(item.id) },
            style: {
              minHeight: 28,
              padding: '0 10px',
              border: '1px solid ' + (active ? 'var(--dsw-alias-border-l2)' : 'transparent'),
              borderRadius: '8px',
              background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            },
          }, item.label)
        }),
        h('span', {
          style: { marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
        }, props.count + t(' 条', ' items'))
      )
    }

    function buildInteractionGraph(messages, workspaces, groups, sessionDirectory, t) {
      const nodes = new Map()
      const edges = []
      workspaces = Array.isArray(workspaces) ? workspaces : []
      groups = Array.isArray(groups) ? groups : []
      const directory = sessionDirectory && typeof sessionDirectory.get === 'function' ? sessionDirectory : null
      const ordered = (Array.isArray(messages) ? messages.slice() : []).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0) })

      function ensureSession(sessionId) {
        const key = 's:' + sessionId
        if (nodes.has(key)) return nodes.get(key)
        const record = directory ? directory.get(sessionId) : undefined
        const workspace = workspaces.find(function (item) {
          return (record && item.path === record.workspacePath) || (Array.isArray(item.sessions) && item.sessions.some(function (s) { return s.sessionId === sessionId }))
        }) || null
        const workspacePath = (record && record.workspacePath) || (workspace && workspace.path) || ''
        const node = {
          key: key,
          type: 'session',
          sessionId: sessionId,
          label: (record && record.title) || shortId(sessionId),
          workspacePath: workspacePath,
          workspaceTitle: (record && record.workspaceTitle) || (workspace && workspace.title) || (workspacePath ? basename(workspacePath) : t('未归入工作区', 'No workspace')),
          running: !!(record && record.running),
        }
        nodes.set(key, node)
        return node
      }

      function ensureGroup(groupId, groupName) {
        const key = 'g:' + groupId
        if (nodes.has(key)) return nodes.get(key)
        const group = groups.find(function (item) { return item && item.id === groupId })
        const node = {
          key: key,
          type: 'group',
          groupId: groupId,
          label: groupName || (group && group.name) || shortId(groupId),
          memberCount: group && typeof group.memberCount === 'number' ? group.memberCount : 0,
        }
        nodes.set(key, node)
        return node
      }

      function ensureWorkspace(workspacePath, workspaceTitle) {
        const key = 'w:' + workspacePath
        if (nodes.has(key)) return nodes.get(key)
        const workspace = workspaces.find(function (item) { return item.path === workspacePath })
        const node = {
          key: key,
          type: 'workspace',
          workspacePath: workspacePath,
          label: workspaceTitle || (workspace && workspace.title) || basename(workspacePath) || workspacePath,
        }
        nodes.set(key, node)
        return node
      }

      function addEdge(message, fromNode, toNode, kind) {
        if (!fromNode || !toNode) return
        edges.push({
          id: message.id + ':' + kind + ':' + edges.length,
          message: message,
          from: fromNode.key,
          to: toNode.key,
          fromLabel: fromNode.label,
          toLabel: toNode.label,
          kind: kind,
          index: edges.length,
        })
      }

      ordered.forEach(function (message) {
        if (!message || !message.from || typeof message.from.sessionId !== 'string') return
        const fromNode = ensureSession(message.from.sessionId)
        const to = message.to || {}
        if (typeof to.groupId === 'string' && to.groupId.length > 0) {
          const groupNode = ensureGroup(to.groupId, to.groupName)
          addEdge(message, fromNode, groupNode, 'group')
          const group = groups.find(function (item) { return item && item.id === to.groupId })
          const memberIds = Array.isArray(to.memberSessionIds) && to.memberSessionIds.length > 0
            ? to.memberSessionIds
            : (group && Array.isArray(group.sessionIds) ? group.sessionIds : [])
          const unique = [...new Set(memberIds)].filter(function (id) { return typeof id === 'string' && id !== message.from.sessionId })
          if (unique.length > 12) {
            groupNode.fanOmitted = groupNode.fanOmitted || new Set()
            unique.slice(12).forEach(function (id) { groupNode.fanOmitted.add(id) })
          }
          unique.slice(0, 12).forEach(function (memberId) {
            addEdge(message, groupNode, ensureSession(memberId), 'fan')
          })
          return
        }
        if (typeof to.sessionId === 'string' && to.sessionId.length > 0) {
          addEdge(message, fromNode, ensureSession(to.sessionId), 'direct')
          return
        }
        if (typeof to.workspacePath === 'string' && to.workspacePath.length > 0) {
          addEdge(message, fromNode, ensureWorkspace(to.workspacePath, to.workspaceTitle), 'broadcast')
        }
      })

      const sessionNodes = [...nodes.values()].filter(function (node) { return node.type === 'session' })
      const workspaceNodes = [...nodes.values()].filter(function (node) { return node.type === 'workspace' })
      const groupNodes = [...nodes.values()].filter(function (node) { return node.type === 'group' })
      const byWorkspace = new Map()
      sessionNodes.forEach(function (node) {
        const key = node.workspacePath || ''
        if (!byWorkspace.has(key)) byWorkspace.set(key, [])
        byWorkspace.get(key).push(node)
      })
      workspaceNodes.forEach(function (node) {
        if (!byWorkspace.has(node.workspacePath)) byWorkspace.set(node.workspacePath, [])
      })
      const workspaceOrder = [...byWorkspace.keys()].sort(function (a, b) {
        if (!a) return 1
        if (!b) return -1
        return a.localeCompare(b)
      })
      const columns = workspaceOrder.map(function (workspacePath) {
        const sessions = byWorkspace.get(workspacePath).sort(function (a, b) {
          if (a.running !== b.running) return a.running ? -1 : 1
          return String(a.label).localeCompare(String(b.label))
        })
        const hub = workspacePath ? workspaceNodes.find(function (node) { return node.workspacePath === workspacePath }) : undefined
        return {
          key: workspacePath || 'other',
          title: workspacePath ? basename(workspacePath) : t('其他会话', 'Other sessions'),
          hub: hub || null,
          sessions: sessions,
        }
      })
      if (groupNodes.length > 0) {
        columns.push({ key: '__groups__', title: t('群组', 'Groups'), hub: null, sessions: [], groups: groupNodes })
      }

      const columnWidth = 260
      const cardWidth = 212
      const cardHeight = 108
      const rowHeight = 130
      let maxRows = 1
      columns.forEach(function (column, columnIndex) {
        const x = 130 + columnIndex * columnWidth
        if (column.hub) {
          column.hub.x = x
          column.hub.y = 100
        }
        column.sessions.forEach(function (node, index) {
          node.x = x
          node.y = 225 + index * rowHeight
        })
        if (column.groups) {
          column.groups.forEach(function (node, index) {
            node.x = x
            node.y = 225 + index * rowHeight
          })
          maxRows = Math.max(maxRows, column.groups.length)
        }
        maxRows = Math.max(maxRows, column.sessions.length)
      })
      const width = Math.max(700, 130 + columns.length * columnWidth)
      const height = Math.max(440, 250 + maxRows * rowHeight)

      const palette = [
        'var(--dsw-static-green-400)',
        'var(--dsw-static-blue-400)',
        'var(--dsw-static-amber-400)',
        'var(--dsw-static-red-400)',
        'var(--dsw-static-deepseek-400)',
        'var(--dsw-alias-brand-primary)',
      ]
      let nodeIndex = 0
      nodes.forEach(function (node) {
        node.color = palette[nodeIndex % palette.length]
        nodeIndex += 1
        const incident = edges.filter(function (edge) { return edge.from === node.key || edge.to === node.key })
        node.sentCount = edges.filter(function (edge) { return edge.from === node.key }).length
        node.receivedCount = edges.filter(function (edge) { return edge.to === node.key }).length
        node.messageCount = new Set(incident.map(function (edge) { return edge.message.id })).size
        node.lastAt = incident.reduce(function (latest, edge) {
          const at = edge.message && edge.message.createdAt
          return typeof at === 'number' && at > latest ? at : latest
        }, 0)
        node.initials = node.type === 'group' ? '群' : node.type === 'workspace' ? '区' : String(node.label).replace(/\s+/g, '').slice(0, 2).toUpperCase()
      })

      function nodeById(key) {
        return nodes.get(key)
      }

      const connected = new Map()
      edges.forEach(function (edge) {
        if (!connected.has(edge.from)) connected.set(edge.from, new Set())
        if (!connected.has(edge.to)) connected.set(edge.to, new Set())
        connected.get(edge.from).add(edge.to)
        connected.get(edge.to).add(edge.from)
      })

      return { nodes: [...nodes.values()], edges: edges, columns: columns, width: width, height: height, cardWidth: cardWidth, cardHeight: cardHeight, connected: connected, nodeById: nodeById, sessionNodes: sessionNodes, groupNodes: groupNodes }
    }

    function InteractionGraph(props) {
      const t = props.t
      const messages = Array.isArray(props.messages) ? props.messages : []
      const [visible, setVisible] = React.useState(0)
      const [playing, setPlaying] = React.useState(false)
      const [hoverNode, setHoverNode] = React.useState('')
      const [hoverEdge, setHoverEdge] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [timelineQuery, setTimelineQuery] = React.useState('')
      const graphSource = React.useMemo(function () {
        return messages.slice(0, GRAPH_MESSAGE_LIMIT)
      }, [messages])
      const graphSignature = React.useMemo(function () {
        return graphSource.map(function (message) {
          const delivery = message && message.delivery ? message.delivery : {}
          return String(message && message.id) + ':' + (message && message.read === true ? '1' : '0') + ':' + String(delivery.mode || '') + ':' + String(delivery.at || '') + ':' + String(message && message.editedAt || '')
        }).join('|')
      }, [graphSource])
      const contextSignature = React.useMemo(function () {
        const parts = []
        for (const workspace of Array.isArray(props.workspaces) ? props.workspaces : []) {
          parts.push('w', workspace.path, workspace.title, workspace.exists === false ? '0' : '1')
          for (const session of Array.isArray(workspace.sessions) ? workspace.sessions : []) {
            parts.push('s', session.sessionId, session.title, session.running === true ? '1' : '0', session.updatedAt || '')
          }
        }
        for (const group of Array.isArray(props.groups) ? props.groups : []) {
          parts.push('g', group.id, group.name, group.updatedAt || '')
        }
        const directory = props.sessionDirectory
        if (directory && typeof directory.forEach === 'function') {
          directory.forEach(function (record, sessionId) {
            if (!record) return
            parts.push('d', sessionId, record.title || '', record.workspacePath || '', record.workspaceTitle || '', record.running === true ? '1' : '0', record.blank === true ? '1' : '0')
          })
        }
        return parts.join('|')
      }, [props.workspaces, props.groups, props.sessionDirectory])
      const model = React.useMemo(function () {
        return buildInteractionGraph(graphSource, props.workspaces, props.groups, props.sessionDirectory, t)
      }, [graphSignature, contextSignature, t])
      const selectedEdge = selected && selected.type === 'edge' ? model.edges.find(function (edge) { return edge.id === selected.id }) || null : null
      const selectedNode = selected && selected.type === 'node' ? model.nodes.find(function (node) { return node.key === selected.key }) || null : null

      React.useEffect(function () {
        setPlaying(false)
        setSelected(null)
        setVisible(model.edges.length)
      }, [graphSignature])

      React.useEffect(function () {
        if (!playing) return undefined
        if (visible >= model.edges.length) {
          setPlaying(false)
          return undefined
        }
        const timer = setTimeout(function () {
          setVisible(function (current) { return Math.min(model.edges.length, current + 1) })
        }, 360)
        return function () { clearTimeout(timer) }
      }, [playing, visible, model.edges.length])

      const edgeColor = function (edge) {
        const from = model.nodeById(edge.from)
        return from && from.color ? from.color : 'var(--dsw-alias-label-tertiary)'
      }
      const edgeDash = function (edge) {
        if (edge.kind === 'fan') return '4 4'
        if (edge.kind === 'broadcast') return '2 5'
        return undefined
      }
      const isDimEdge = function (edge) {
        if (selectedEdge && selectedEdge.id !== edge.id) return true
        if (selectedNode) return edge.from !== selectedNode.key && edge.to !== selectedNode.key
        if (hoverEdge && hoverEdge !== edge.id) return true
        if (hoverNode) return edge.from !== hoverNode && edge.to !== hoverNode
        return false
      }
      const isDimNode = function (node) {
        if (hoverNode) return node.key !== hoverNode && !(model.connected.get(hoverNode) || new Set()).has(node.key)
        if (selectedNode) return node.key !== selectedNode.key && !(model.connected.get(selectedNode.key) || new Set()).has(node.key)
        if (selectedEdge) return node.key !== selectedEdge.from && node.key !== selectedEdge.to
        return false
      }

      // Keep every hook above the empty-state return: messages can transition
      // between empty and non-empty while this tab stays mounted.
      const timelineMessages = React.useMemo(function () {
        const query = timelineQuery.trim().toLowerCase()
        return messages
          .slice()
          .sort(function (left, right) { return (right.createdAt || 0) - (left.createdAt || 0) })
          .filter(function (mail) {
            if (!query) return true
            return [
              mail.subject,
              mail.body,
              mail.from && mail.from.sessionTitle,
              mail.from && mail.from.workspaceTitle,
              mail.from && mail.from.title,
              mail.from && mail.from.sessionId,
              targetLabelOf(mail),
            ].some(function (value) { return typeof value === 'string' && value.toLowerCase().indexOf(query) >= 0 })
          })
          .slice(0, 40)
      }, [messages, timelineQuery, model, t])

      if (messages.length === 0) {
        return h('div', { style: { padding: 28, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 } },
          t('还没有可画的交流：先发一条跨工作区消息。', 'No conversations to draw yet; send a cross-workspace message first.'))
      }

      const stats = [
        { value: model.sessionNodes.length, label: t('个 Agent', 'agents') },
        { value: model.sessionNodes.filter(function (node) { return node.running }).length, label: t('运行中', 'running') },
        { value: graphSource.length, label: t('条消息', 'messages') },
        { value: model.groupNodes.length, label: t('个群组', 'groups') },
      ]
      const maxMessageCount = model.nodes.reduce(function (maximum, node) { return Math.max(maximum, node.messageCount) }, 1)

      function targetLabelOf(mail) {
        const to = mail.to || {}
        if (typeof to.groupId === 'string') {
          const group = model.nodeById('g:' + to.groupId)
          return group ? group.label : t('群组 ', 'Group ') + shortId(to.groupId)
        }
        if (typeof to.sessionId === 'string') {
          const session = model.nodeById('s:' + to.sessionId)
          return session ? session.label : shortId(to.sessionId)
        }
        if (typeof to.workspacePath === 'string') {
          const workspace = model.nodeById('w:' + to.workspacePath)
          return workspace ? workspace.label : t('工作区广播', 'Workspace broadcast')
        }
        return t('未知收件方', 'unknown target')
      }

      function deliveryText(mail) {
        const mode = mail.delivery && mail.delivery.mode ? mail.delivery.mode : 'mailbox'
        if (mode === 'wake') return t('已唤醒', 'wake')
        if (mode === 'queued') return t('排队', 'queued')
        if (mode === 'none') return t('失败', 'none')
        return t('信箱', 'mailbox')
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '10px 14px',
            borderBottom: '.5px solid var(--dsw-alias-border-l1)',
            flex: 'none',
          },
        },
          h('div', { style: { display: 'grid', gap: 2, minWidth: 180, flex: 1 } },
            h('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, t('Agent 网络', 'Agent network')),
            h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } }, t('跨工作区协作 · 点击卡片或连线看详情', 'Cross-workspace collaboration · click a card or link'))),
          stats.map(function (stat) {
            return h('div', {
              key: stat.label,
              style: {
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 4,
                padding: '3px 8px',
                border: '.5px solid var(--dsw-alias-border-l1)',
                borderRadius: 999,
                background: 'var(--dsw-alias-bg-layer-1)',
              },
            },
              h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, stat.value),
              h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } }, stat.label))
          }),
          h(Button, {
            variant: 'outline',
            onClick: function () {
              if (playing) {
                setPlaying(false)
                return
              }
              setVisible(0)
              setPlaying(true)
            },
            style: { minHeight: 26, padding: '0 8px', fontSize: 12 },
          }, playing ? t('暂停', 'Pause') : t('播放', 'Play')),
          h(Button, {
            variant: 'ghost',
            onClick: function () { setPlaying(false); setVisible(model.edges.length); setSelected(null) },
            style: { minHeight: 26, padding: '0 8px', fontSize: 12 },
          }, t('显示全部', 'Show all'))
        ),
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '0 14px 8px',
            fontSize: 10,
            color: 'var(--dsw-alias-label-tertiary)',
            flex: 'none',
          },
        },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)' } }),
            t('运行中', 'running')),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { style: { display: 'inline-flex', gap: 2 } },
              ['var(--dsw-static-green-400)', 'var(--dsw-static-blue-400)', 'var(--dsw-static-amber-400)', 'var(--dsw-static-red-400)', 'var(--dsw-static-deepseek-400)', 'var(--dsw-alias-brand-primary)'].map(function (color, index) {
                return h('span', { key: index, style: { width: 6, height: 6, borderRadius: '50%', background: color } })
              })),
            t('颜色 = Agent / 群组 / 工作区', 'color = agent / group / workspace')),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { style: { width: 16, borderTop: '2px dashed var(--dsw-alias-label-tertiary)' } }),
            t('虚线 = 群组分发 / 广播', 'dashed = group fan / broadcast')),
          h('span', { style: { marginLeft: 'auto' } },
            t('显示 ', 'Showing ') + Math.min(visible, model.edges.length) + ' / ' + model.edges.length + t(' 条连线', ' links'))
        ),
        h('div', { className: 'dshcw-net-layout' },
          h('div', { className: 'dshcw-scroll', style: { flex: 1, minWidth: 0, overflow: 'auto', padding: '8px 12px' } },
            h('div', { style: { fontSize: 10, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 6 } },
              t('图基于最近 120 条消息（最多加载 300 条）；右侧时间线显示最近 40 条。每张卡片是一个 Agent/群组/工作区，颜色用于区分。', 'Graph uses the latest 120 messages (up to 300 loaded); the timeline shows the latest 40. Each card is an agent, group or workspace, colored for distinction.')),
          h('svg', {
            viewBox: '0 0 ' + model.width + ' ' + model.height,
            role: 'img',
            'aria-label': t('智能体交流图', 'Agent communication graph'),
            style: { display: 'block', width: model.width, height: model.height, minWidth: model.width, flex: 'none' },
            onMouseLeave: function () { setHoverNode(''); setHoverEdge('') },
          },
            h('defs', null,
              h('marker', { id: 'dshcw-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
                h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-label-tertiary)' }))),
            model.columns.map(function (column, index) {
              const x = 130 + index * 260
              return h('text', {
                key: column.key,
                x: x,
                y: 18,
                textAnchor: 'middle',
                fill: 'var(--dsw-alias-label-tertiary)',
                style: { fontSize: 10, fontWeight: 600 },
              }, column.title)
            }),
            model.edges.map(function (edge) {
              const from = model.nodeById(edge.from)
              const to = model.nodeById(edge.to)
              if (!from || !to || typeof from.x !== 'number' || typeof to.x !== 'number') return null
              if (edge.index >= visible) return null
              const dim = isDimEdge(edge)
              const fromR = from.type === 'workspace' ? 22 : 20
              const toR = to.type === 'workspace' ? 22 : 20
              const fromHalfW = (model.cardWidth || 212) / 2
              const fromHalfH = (model.cardHeight || 108) / 2
              let path
              if (Math.abs(to.x - from.x) >= 2) {
                const dir = to.x > from.x ? 1 : -1
                const startX = from.x + dir * fromHalfW
                const endX = to.x - dir * fromHalfW
                const dx = Math.max(30, Math.abs(endX - startX) * 0.45)
                path = 'M ' + startX + ' ' + from.y + ' C ' + (startX + dir * dx) + ' ' + from.y + ', ' + (endX - dir * dx) + ' ' + to.y + ', ' + endX + ' ' + to.y
              } else {
                const dir = to.y >= from.y ? 1 : -1
                const startY = from.y + dir * fromHalfH
                const endY = to.y - dir * fromHalfH
                const dy = Math.max(30, Math.abs(endY - startY) * 0.5)
                path = 'M ' + from.x + ' ' + startY + ' C ' + from.x + ' ' + (startY + dir * dy) + ', ' + to.x + ' ' + (endY - dir * dy) + ', ' + to.x + ' ' + endY
              }
              return h('g', { key: edge.id, opacity: dim ? 0.16 : 1 },
                h('path', {
                  d: path,
                  fill: 'none',
                  stroke: edgeColor(edge),
                  strokeWidth: hoverEdge === edge.id ? 3 : 1.8,
                  strokeDasharray: edgeDash(edge),
                  markerEnd: 'url(#dshcw-arrow)',
                  style: { pointerEvents: 'none' },
                }),
                h('path', {
                  d: path,
                  fill: 'none',
                  stroke: 'transparent',
                  strokeWidth: 12,
                  style: { cursor: 'pointer', pointerEvents: 'stroke' },
                  onMouseEnter: function () { setHoverEdge(edge.id) },
                  onMouseLeave: function () { setHoverEdge('') },
                  onClick: function () { setSelected({ type: 'edge', id: edge.id }) },
                }))
            }),
            model.nodes.map(function (node) {
              const dim = isDimNode(node)
              const isSelectedNode = selectedNode && selectedNode.key === node.key
              const hover = hoverNode === node.key
              const cw = model.cardWidth || 212
              const ch = model.cardHeight || 108
              const left = node.x - cw / 2
              const top = node.y - ch / 2
              const subtitle = node.type === 'group'
                ? t('群组 · ', 'Group · ') + (node.memberCount || 0) + t(' 位成员', ' members')
                : node.type === 'workspace'
                  ? t('工作区广播', 'Workspace broadcast')
                  : (node.workspaceTitle || t('会话', 'Session'))
              const label = String(node.label)
              const truncatedLabel = label.length > 15 ? label.slice(0, 14) + '…' : label
              const truncatedSubtitle = String(subtitle).length > 22 ? String(subtitle).slice(0, 21) + '…' : String(subtitle)
              const progress = Math.max(0, Math.min(1, node.messageCount / maxMessageCount))
              const footer = (node.lastAt ? relativeTime(node.lastAt, props.now || Date.now(), t) : t('无消息', 'no messages'))
                + (node.fanOmitted && node.fanOmitted.size > 0 ? ' · +' + node.fanOmitted.size : '')
              return h('g', {
                key: node.key,
                opacity: dim ? 0.2 : 1,
                style: { cursor: 'pointer' },
                onMouseEnter: function () { setHoverNode(node.key) },
                onMouseLeave: function () { setHoverNode('') },
                onClick: function () { setSelected({ type: 'node', key: node.key }) },
              },
                h('rect', {
                  x: left,
                  y: top,
                  width: cw,
                  height: ch,
                  rx: 11,
                  fill: 'var(--dsw-alias-bg-layer-2)',
                  stroke: hover || isSelectedNode ? node.color : 'var(--dsw-alias-border-l1)',
                  strokeWidth: hover || isSelectedNode ? 1.8 : 1,
                }),
                h('rect', { x: left + 1, y: top + 1, width: 3, height: ch - 2, rx: 1.5, fill: node.color }),
                h('circle', { cx: left + 25, cy: top + 26, r: 12, fill: node.color }),
                h('text', { x: left + 25, y: top + 30, textAnchor: 'middle', fill: 'var(--dsw-alias-label-primary-inverted)', style: { fontSize: 9, fontWeight: 700, pointerEvents: 'none' } }, node.initials),
                node.running
                  ? h('circle', { cx: left + cw - 14, cy: top + 14, r: 3.5, fill: 'var(--dsw-alias-state-success-primary)' })
                  : null,
                h('text', { x: left + 44, y: top + 22, fill: 'var(--dsw-alias-label-primary)', style: { fontSize: 11, fontWeight: 600, pointerEvents: 'none' } }, truncatedLabel),
                h('text', { x: left + 44, y: top + 37, fill: 'var(--dsw-alias-label-tertiary)', style: { fontSize: 9, pointerEvents: 'none' } }, truncatedSubtitle),
                h('text', { x: left + 12, y: top + 63, fill: 'var(--dsw-alias-label-secondary)', style: { fontSize: 9, pointerEvents: 'none' } },
                  t('发 ', 'out ') + node.sentCount + ' · ' + t('收 ', 'in ') + node.receivedCount + ' · ' + t('消息 ', 'msgs ') + node.messageCount),
                h('text', { x: left + 12, y: top + 79, fill: 'var(--dsw-alias-label-tertiary)', style: { fontSize: 9, pointerEvents: 'none' } }, footer),
                h('rect', { x: left + 12, y: top + 92, width: cw - 24, height: 3, rx: 1.5, fill: 'var(--dsw-alias-border-l1)' }),
                h('rect', { x: left + 12, y: top + 92, width: Math.max(3, (cw - 24) * progress), height: 3, rx: 1.5, fill: node.color }),
                h('title', null, node.label)
              )
            })
          ),
          selected && (selectedEdge || selectedNode)
            ? h('div', {
                style: {
                  marginTop: 10,
                  padding: '10px 12px',
                  border: '.5px solid var(--dsw-alias-border-l1)',
                  borderRadius: '8px',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  display: 'grid',
                  gap: 5,
                  fontSize: 12,
                },
              },
                selectedEdge
                  ? h('div', { style: { display: 'grid', gap: 5 } },
                      h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                        selectedEdge.message.subject || t('（无主题）', '(no subject)')),
                      h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                        selectedEdge.fromLabel + ' → ' + selectedEdge.toLabel + (selectedEdge.kind === 'fan' ? t('（群组成员）', ' (group member)') : selectedEdge.kind === 'group' ? t('（群组）', ' (group)') : '')),
                      h('div', { style: { color: 'var(--dsw-alias-label-tertiary)' } },
                        formatDate(selectedEdge.message.createdAt) + ' · ' + (selectedEdge.message.delivery && selectedEdge.message.delivery.mode ? selectedEdge.message.delivery.mode : t('未知', 'unknown'))),
                      props.onOpen ? h(Button, {
                        variant: 'outline',
                        onClick: function () { props.onOpen(selectedEdge.message) },
                        style: { justifySelf: 'start', minHeight: 26, padding: '0 8px', fontSize: 12 },
                      }, t('打开消息', 'Open message')) : null)
                  : selectedNode
                    ? h('div', { style: { display: 'grid', gap: 5 } },
                        h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, selectedNode.label),
                        h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                          selectedNode.type === 'session' ? t('会话', 'Session') : selectedNode.type === 'group' ? t('群组', 'Group') : t('工作区广播', 'Workspace broadcast')),
                        selectedNode.workspaceTitle ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, selectedNode.workspaceTitle) : null,
                        h('div', { style: { color: 'var(--dsw-alias-label-tertiary)' } },
                          t('收发消息：', 'Messages: ') + model.edges.filter(function (edge) { return edge.from === selectedNode.key || edge.to === selectedNode.key }).length))
                    : null
                )
          : null
        ),
        h('aside', { className: 'dshcw-net-side' },
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '9px 10px',
              borderBottom: '.5px solid var(--dsw-alias-border-l1)',
              flex: 'none',
            },
          },
            h('span', { style: { fontSize: 12, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, t('跨 Agent 协作', 'Cross-agent activity')),
            h('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } }, messages.length + t(' 条记录', ' records'))),
          h('div', { style: { padding: '6px 10px 4px', flex: 'none' } },
            h('input', {
              type: 'search',
              value: timelineQuery,
              placeholder: t('搜索 Agent / 主题', 'Search agent / subject'),
              onChange: function (event) { setTimelineQuery(event.target.value) },
              style: {
                width: '100%',
                boxSizing: 'border-box',
                padding: '5px 8px',
                border: '.5px solid var(--dsw-alias-border-l2)',
                borderRadius: 7,
                background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-label-primary)',
                font: 'inherit',
                fontSize: 11,
                outline: 'none',
              },
            })),
          h('div', { className: 'dshcw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 10px', display: 'grid', gap: 6, alignContent: 'start' } },
            timelineMessages.length === 0
              ? h('div', { style: { padding: '14px 2px', fontSize: 11, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary)' } },
                  t('没有匹配的协作记录。', 'No matching activity.'))
              : timelineMessages.map(function (mail) {
                  const fromNode = model.nodeById('s:' + (mail.from && mail.from.sessionId))
                  const color = fromNode && fromNode.color ? fromNode.color : 'var(--dsw-alias-label-tertiary)'
                  const fromLabel = fromNode && fromNode.label ? fromNode.label : shortId(mail.from && mail.from.sessionId)
                  const mode = mail.delivery && mail.delivery.mode ? mail.delivery.mode : 'mailbox'
                  return h('button', {
                    key: mail.id,
                    type: 'button',
                    className: 'dshcw-net-event',
                    onClick: function () { if (props.onOpen) props.onOpen(mail) },
                    style: {
                      display: 'grid',
                      gap: 4,
                      width: '100%',
                      boxSizing: 'border-box',
                      textAlign: 'left',
                      padding: '7px 8px',
                      border: '.5px solid var(--dsw-alias-border-l1)',
                      borderLeft: '3px solid ' + color,
                      borderRadius: 7,
                      color: 'inherit',
                      font: 'inherit',
                      cursor: 'pointer',
                    },
                  },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
                      h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: color, flex: 'none' } }),
                      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                        mail.subject || t('（无主题）', '(no subject)')),
                      h('span', { style: { flex: 'none', fontSize: 9, color: 'var(--dsw-alias-label-tertiary)' } },
                        relativeTime(mail.createdAt, props.now || Date.now(), t))),
                    h('div', { style: { fontSize: 9, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      fromLabel + ' → ' + targetLabelOf(mail)),
                    h('div', { style: { fontSize: 9, color: mode === 'none' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' } },
                      deliveryText(mail) + (mail.read === false ? t(' · 未读', ' · unread') : '')))
                }))))
      )
    }

    function MessageRow(props) {
      const t = props.t
      const mail = props.mail
      const unread = mail.read !== true
      const delivery = mail.delivery && typeof mail.delivery === 'object' ? mail.delivery : null
      const files = Array.isArray(mail.files) ? mail.files : []
      const hasData = hasJsonData(mail)
      const text = snippet(mail.body)
      return h('button', {
        type: 'button',
        className: 'dshcw-row',
        onClick: function () { props.onOpen(mail) },
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          width: '100%',
          boxSizing: 'border-box',
          textAlign: 'left',
          border: '0',
          borderBottom: '.5px solid var(--dsw-alias-border-l1)',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          padding: '10px 12px',
          cursor: 'pointer',
        },
      },
        h('span', {
          'aria-hidden': 'true',
          style: {
            width: 8,
            height: 8,
            marginTop: 5,
            borderRadius: '50%',
            flex: 'none',
            background: unread ? 'var(--dsw-alias-brand-primary)' : 'transparent',
            border: unread ? 'none' : '.5px solid var(--dsw-alias-border-l1)',
          },
        }),
        h('span', { style: { flex: 1, minWidth: 0, display: 'grid', gap: 3 } },
          h('span', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
            h('span', {
              className: 'dshcw-truncate',
              style: {
                flex: 1,
                fontSize: 13,
                lineHeight: '18px',
                fontWeight: unread ? 600 : 500,
                color: 'var(--dsw-alias-label-primary)',
              },
            }, subjectText(mail, t)),
            h('span', { style: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, relativeTime(mail.createdAt, props.now, t))
          ),
          h('span', {
            className: 'dshcw-truncate',
            style: { display: 'block', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
          }, compactParty(mail.from, t) + ' → ' + compactParty(mail.to, t)),
          text ? h('span', {
            style: {
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              fontSize: 12,
              lineHeight: '17px',
              color: 'var(--dsw-alias-label-secondary)',
              overflowWrap: 'anywhere',
            },
          }, text) : null,
          h('span', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginTop: 1 } },
            isGroupMail(mail)
              ? h(Badge, { tone: 'idle', title: groupLabelOf(mail.to, t) }, t('群组', 'Group') + (mail.to && mail.to.groupName ? ' · ' + clipText(mail.to.groupName, 16) : ''))
              : null,
            h(Badge, { tone: delivery && delivery.mode === 'wake' ? 'success' : 'plain' }, deliveryBadgeLabel(delivery, t)),
            files.length ? h(Badge, null, t('附件 ', 'Files ') + files.length) : null,
            hasData ? h(Badge, null, 'JSON') : null,
            mail.hop > 0 ? h(Badge, { tone: 'idle' }, '#' + mail.hop) : null,
            delivery && delivery.error ? h(Badge, { tone: 'error' }, t('投递出错', 'Delivery error')) : null
          )
        )
      )
    }

    function MessageEditView(props) {
      const t = props.t
      const call = props.call
      const mail = props.mail
      const [subject, setSubject] = React.useState(typeof mail.subject === 'string' ? mail.subject : '')
      const [body, setBody] = React.useState(typeof mail.body === 'string' ? mail.body : '')
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState(false)

      function save() {
        if (saving) return
        if (!subject.trim() && !body.trim()) {
          setError(t('主题和正文至少要有一项。', 'Subject and body cannot both be empty.'))
          return
        }
        setSaving(true)
        setError('')
        call('edit', Object.assign({ id: mail.id, subject: subject, body: body }, props.viewer || {})).then(function (value) {
          if (value && value.message) props.onSaved(value.message)
          else props.onSaved(null)
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setSaving(false)
        })
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 12px',
            flex: 'none',
            borderBottom: '.5px solid var(--dsw-alias-border-l1)',
          },
        },
          h('span', { style: { flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('编辑消息', 'Edit message')),
          h(Button, { variant: 'outline', onClick: props.onCancel, disabled: saving }, t('取消', 'Cancel'))
        ),
        h('div', { className: 'dshcw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px', display: 'grid', gap: 12, alignContent: 'start' } },
          error ? h(AlertBanner, { onDismiss: function () { setError('') }, dismissLabel: t('关闭', 'Dismiss') }, error) : null,
          h(Field, { label: t('主题', 'Subject') },
            h(Input, {
              value: subject,
              'aria-label': t('主题', 'Subject'),
              onChange: function (event) { setSubject(event.target.value) },
            })),
          h(Field, {
            label: t('正文', 'Body'),
            hint: t('编辑只改主题和正文，不改收件人、附件和已读状态。', 'Only subject and body change; recipients, files and read state stay the same.'),
          },
            h(Textarea, {
              value: body,
              'aria-label': t('正文', 'Body'),
              onChange: function (event) { setBody(event.target.value) },
              style: { minHeight: 220 },
            })),
          hasJsonData(mail)
            ? h('div', { style: { fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } },
                t('这条消息带 JSON 数据；本次编辑不会修改 data 和附件。', 'This message has JSON data; editing leaves data and attachments unchanged.'))
            : null
        ),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '9px 12px', borderTop: '.5px solid var(--dsw-alias-border-l1)', flex: 'none' } },
          h(Button, { variant: 'primary', onClick: save, disabled: saving }, saving ? t('保存中…', 'Saving…') : t('保存修改', 'Save changes')))
      )
    }

    function MessageDetail(props) {
      const t = props.t
      const mail = props.mail
      const delivery = mail.delivery && typeof mail.delivery === 'object' ? mail.delivery : null
      const files = Array.isArray(mail.files) ? mail.files : []
      const hasData = hasJsonData(mail)
      const busy = props.busy || ''
      const isWorkspaceBroadcast = !!(mail.to && typeof mail.to.workspacePath === 'string'
        && typeof mail.to.sessionId !== 'string' && typeof mail.to.groupId !== 'string')
      const canWake = (!delivery || delivery.delivered !== true || delivery.mode !== 'wake')
        && (props.allowWorkspaceBroadcast !== false || !isWorkspaceBroadcast)
      const ownMessage = !!(props.mySessionId && mail.from && typeof mail.from.sessionId === 'string' && mail.from.sessionId === props.mySessionId)
      const directory = props.sessionDirectory
      const groups = Array.isArray(props.groups) ? props.groups : []
      const isGroup = isGroupMail(mail)
      const groupRecord = isGroup && mail.to && typeof mail.to.groupId === 'string'
        ? groups.find(function (group) { return group && group.id === mail.to.groupId }) || null
        : null
      const groupMissing = isGroup && !!mail.to && typeof mail.to.groupId === 'string' && !groupRecord
      const memberIds = groupMemberIds(mail.to)
      const groupMembers = memberIds.length > 0
        ? memberIds
        : (groupRecord && Array.isArray(groupRecord.members) ? groupRecord.members.map(function (member) { return member && member.sessionId }).filter(Boolean) : [])
      const memberDelivery = new Map()
      if (delivery && Array.isArray(delivery.members)) {
        delivery.members.forEach(function (member) {
          if (member && typeof member.sessionId === 'string') memberDelivery.set(member.sessionId, member)
        })
      }
      const groupDisplayName = (mail.to && typeof mail.to.groupName === 'string' && mail.to.groupName)
        || (groupRecord && typeof groupRecord.name === 'string' && groupRecord.name)
        || ''
      const groupDisplayLabel = groupDisplayName
        ? t('群组「', 'Group “') + groupDisplayName + t('」', '”')
        : groupLabelOf(mail.to, t)
      const lines = deliveryLines(delivery, t, function (sessionId) { return sessionLabelOf(directory, sessionId, t) })
      const replyTitle = ownMessage
        ? t('不能回复自己发出的消息', 'You cannot reply to a message you sent')
        : groupMissing
          ? t('该群组已被删除，无法回复群组消息', 'That group was deleted, so its messages cannot be replied to')
          : undefined

      function metaRow(label, value, extra) {
        return h('div', {
          key: label,
          style: { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 12, lineHeight: '18px' },
        },
          h('span', { style: { flex: '0 0 62px', color: 'var(--dsw-alias-label-tertiary)' } }, label),
          h('span', { style: { flex: '1 1 auto', minWidth: 0, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' } }, value),
          extra ? h('span', {
            className: 'dshcw-code',
            style: { flexBasis: '100%', marginLeft: 62, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
          }, extra) : null
        )
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 6,
            padding: '8px 10px',
            flex: 'none',
            borderBottom: '.5px solid var(--dsw-alias-border-l1)',
          },
        },
          h(Button, { variant: 'ghost', onClick: props.onBack }, '← ' + t('返回', 'Back')),
          h('span', { style: { marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' } },
            mail.read === true
              ? h(Button, { variant: 'outline', onClick: props.onMarkUnread, disabled: !!busy }, busy === 'mark' ? t('处理中…', 'Working…') : t('标记未读', 'Mark unread'))
              : null,
            canWake
              ? h(Button, { variant: 'outline', onClick: props.onWake, disabled: !!busy }, busy === 'deliver' ? t('投递中…', 'Delivering…') : t('唤醒投递', 'Wake delivery'))
              : null,
            h(Button, {
              variant: 'outline',
              onClick: props.onReply,
              disabled: !!busy || ownMessage || groupMissing,
              title: replyTitle,
            }, t('回复', 'Reply')),
            h(Button, { variant: 'outline', onClick: props.onEdit, disabled: !!busy }, t('编辑', 'Edit')),
            h(Button, { variant: 'danger', onClick: props.onDelete, disabled: !!busy }, busy === 'delete' ? t('删除中…', 'Deleting…') : t('删除', 'Delete'))
          )
        ),
        h('div', { className: 'dshcw-scroll', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px' } },
          h('h2', {
            style: {
              margin: '0 0 8px',
              fontSize: 16,
              lineHeight: '22px',
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary)',
              overflowWrap: 'anywhere',
            },
          }, subjectText(mail, t)),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginBottom: 10 } },
            isGroup ? h(Badge, { tone: 'idle', title: groupLabelOf(mail.to, t) }, t('群组消息', 'Group message')) : null,
            h(Badge, { tone: delivery && delivery.mode === 'wake' ? 'success' : 'plain' }, deliveryBadgeLabel(delivery, t)),
            mail.hop > 0 ? h(Badge, { tone: 'idle' }, t('跳数 ', 'Hop ') + mail.hop) : null,
            files.length ? h(Badge, null, t('附件 ', 'Files ') + files.length) : null,
            hasData ? h(Badge, null, 'JSON') : null
          ),
          h('div', {
            style: {
              display: 'grid',
              gap: 4,
              padding: '10px 12px',
              marginBottom: 12,
              border: '.5px solid var(--dsw-alias-border-l2)',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
            metaRow(t('发件', 'From'), fullParty(mail.from, t), partyIdLine(mail.from)),
            isGroup
              ? metaRow(
                  t('收件', 'To'),
                  groupDisplayLabel + (groupMembers.length > 0 ? t(' · ', ' · ') + groupMembers.length + t(' 位成员', ' members') : ''),
                  partyIdLine(mail.to)
                )
              : metaRow(t('收件', 'To'), fullParty(mail.to, t), partyIdLine(mail.to)),
            metaRow(t('时间', 'Time'), formatDate(mail.createdAt), ''),
            mail.editedAt ? metaRow(t('已编辑', 'Edited'), formatDate(mail.editedAt), '') : null,
            metaRow(t('消息 ID', 'Message ID'), mail.id || '', '')
          ),
          h('div', { style: { marginBottom: 12 } },
            h('div', {
              style: {
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--dsw-alias-label-secondary)',
                marginBottom: 6,
              },
            }, t('投递状态', 'Delivery status')),
            h('div', {
              style: {
                display: 'grid',
                gap: 3,
                padding: '10px 12px',
                border: '.5px solid var(--dsw-alias-border-l2)',
                borderRadius: '8px',
              },
            }, lines.map(function (line, index) {
              return h('div', {
                key: index,
                style: {
                  fontSize: 12,
                  lineHeight: '18px',
                  color: line.tone === 'error'
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-label-secondary)',
                  overflowWrap: 'anywhere',
                },
              }, line.text)
            }))
          ),
          isGroup && groupMembers.length > 0
            ? h('div', { style: { marginBottom: 12 } },
                h('div', {
                  style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 },
                }, t('群组成员', 'Group members') + t('（', ' (') + groupMembers.length + t(' 位）', ' members)')),
                h('div', {
                  style: {
                    display: 'grid',
                    gap: 2,
                    padding: '8px 12px',
                    border: '.5px solid var(--dsw-alias-border-l2)',
                    borderRadius: '8px',
                    background: 'var(--dsw-alias-bg-layer-1)',
                  },
                }, groupMembers.map(function (sessionId) {
                  const member = memberDelivery.get(sessionId)
                  const mode = member
                    ? (member.mode === 'wake' ? t('已唤醒', 'woke') : member.mode === 'mailbox' ? t('信箱', 'mailbox') : member.mode === 'none' ? t('未投递', 'none') : String(member.mode || ''))
                    : ''
                  return h('div', {
                    key: sessionId,
                    style: {
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '2px 8px',
                      fontSize: 12,
                      lineHeight: '18px',
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  },
                    h('span', {
                      className: 'dshcw-truncate',
                      style: { flex: '1 1 150px', minWidth: 0, color: 'var(--dsw-alias-label-primary)' },
                    }, sessionFullLabelOf(directory, sessionId, t)),
                    member
                      ? h('span', {
                          style: {
                            flex: 'none',
                            color: member.error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
                          },
                        }, mode + (member.note ? ' · ' + member.note : '') + (member.error ? ' · ' + member.error : ''))
                      : null
                  )
                }))
              )
            : null,
          h('div', { style: { marginBottom: 12 } },
            h('div', {
              style: {
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--dsw-alias-label-secondary)',
                marginBottom: 6,
              },
            }, t('正文', 'Body')),
            h('div', {
              style: {
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontSize: 13,
                lineHeight: 1.7,
                padding: '10px 12px',
                minHeight: 40,
                borderRadius: '8px',
                background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-label-primary)',
              },
            }, typeof mail.body === 'string' && mail.body ? mail.body : t('（无正文）', '(no body)'))
          ),
          hasData
            ? h('div', { style: { marginBottom: 12 } },
                h('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 6,
                  },
                },
                  h('span', { style: { flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, 'JSON ' + t('数据', 'data')),
                  h(CopyTextButton, { t: t, text: prettyJson(mail.data), label: t('复制数据', 'Copy data') })
                ),
                h('pre', {
                  className: 'dshcw-code',
                  style: {
                    margin: 0,
                    padding: '10px 12px',
                    maxHeight: 320,
                    overflow: 'auto',
                    fontSize: 12,
                    lineHeight: 1.6,
                    borderRadius: '8px',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    color: 'var(--dsw-alias-label-primary)',
                    whiteSpace: 'pre-wrap',
                  },
                }, prettyJson(mail.data))
              )
            : null,
          files.length
            ? h('div', { style: { marginBottom: 12 } },
                h('div', {
                  style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 },
                }, t('附件', 'Attachments')),
                h('div', null, files.map(function (file, index) {
                  const name = file && typeof file.name === 'string' && file.name ? file.name : t('附件', 'Attachment')
                  const path = file && typeof file.path === 'string' ? file.path : ''
                  return h('div', {
                    key: index,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '4px 8px',
                      padding: '6px 0',
                      borderBottom: index === files.length - 1 ? 'none' : '.5px solid var(--dsw-alias-border-l1)',
                    },
                  },
                    h('span', {
                      style: { flex: '0 1 auto', maxWidth: '42%', fontSize: 12, fontWeight: 500, overflowWrap: 'anywhere' },
                    }, name),
                    h('span', { style: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, formatBytes(file && file.bytes)),
                    h('span', {
                      className: 'dshcw-code',
                      title: path,
                      style: { flex: '1 1 200px', minWidth: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
                    }, path || t('（无路径）', '(no path)')),
                    path ? h(CopyTextButton, { key: 'copy', t: t, text: path, label: t('复制路径', 'Copy path') }) : null
                  )
                }))
              )
            : null
        )
      )
    }

    function ComposeView(props) {
      const t = props.t
      const call = props.call
      const data = props.data
      const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : []
      const groups = Array.isArray(props.groups)
        ? props.groups
        : (data && Array.isArray(data.groups) ? data.groups : [])
      const settings = data && data.settings && typeof data.settings === 'object' ? data.settings : {}
      const allowWake = props.allowWake !== false
      const allowWorkspaceBroadcast = settings.allowWorkspaceBroadcast === true
      const defaultWake = settings.defaultDelivery === 'wake' || settings.defaultDelivery === undefined
      const isReply = props.kind === 'reply'
      const replyTo = isReply ? props.replyTo : null
      const isGroupReply = isReply && isGroupMail(replyTo)
      const replyGroupId = isGroupReply && replyTo && replyTo.to && typeof replyTo.to.groupId === 'string' ? replyTo.to.groupId : ''
      const replyGroupName = isGroupReply && replyTo && replyTo.to && typeof replyTo.to.groupName === 'string' ? replyTo.to.groupName : ''
      const replyGroupRecord = replyGroupId
        ? groups.find(function (group) { return group && group.id === replyGroupId }) || null
        : (replyGroupName ? groups.find(function (group) { return group && group.name === replyGroupName }) || null : null)
      const replyGroupLabel = replyGroupName || (replyGroupRecord && replyGroupRecord.name) || replyGroupId
      const replyGroupMemberCount = isGroupReply && replyTo && replyTo.to
        ? groupMemberIds(replyTo.to).length || (replyGroupRecord && replyGroupRecord.memberCount) || 0
        : 0
      const replyTarget = isReply && !isGroupReply ? replyTargetOf(replyTo) : ''

      const initialWorkspace = (function () {
        if (isReply && replyTo && replyTo.from && typeof replyTo.from.workspacePath === 'string' && replyTo.from.workspacePath) return replyTo.from.workspacePath
        if (props.initialTargetWorkspace && workspaces.some(function (workspace) { return workspace.path === props.initialTargetWorkspace })) return props.initialTargetWorkspace
        return workspaces.length ? (workspaces[0].path || '') : ''
      })()
      const initialGroupId = props.initialTargetGroupId || ''
      const initialGroup = initialGroupId ? groups.find(function (group) { return group && group.id === initialGroupId }) || null : null
      const initialTargetType = isReply
        ? (isGroupReply ? 'group' : 'session')
        : (initialGroup ? 'group' : (allowWorkspaceBroadcast ? 'workspace' : 'session'))

      const [targetType, setTargetType] = React.useState(initialTargetType)
      const [targetWorkspace, setTargetWorkspace] = React.useState(initialWorkspace)
      const [targetSession, setTargetSession] = React.useState('')
      const [targetGroup, setTargetGroup] = React.useState(initialGroup ? initialGroup.id : '')
      const [groupAudience, setGroupAudience] = React.useState('all')
      const [groupRecipients, setGroupRecipients] = React.useState([])
      const [subject, setSubject] = React.useState(isReply ? replySubjectOf(replyTo && replyTo.subject, t) : '')
      const [body, setBody] = React.useState('')
      const [dataText, setDataText] = React.useState('')
      const [filesText, setFilesText] = React.useState('')
      const [wake, setWake] = React.useState(defaultWake && allowWake)
      const [error, setError] = React.useState('')
      const [sending, setSending] = React.useState(false)

      const workspace = workspaces.find(function (item) { return item && item.path === targetWorkspace }) || null
      const sessions = workspace && Array.isArray(workspace.sessions) ? workspace.sessions : []
      const selectedGroup = groups.find(function (group) { return group && group.id === targetGroup }) || null
      const groupRecord = isGroupReply ? replyGroupRecord : selectedGroup
      const groupRecipientMembers = groupRecord && Array.isArray(groupRecord.members)
        ? groupRecord.members.filter(function (member) {
            return member && typeof member.sessionId === 'string' && member.sessionId !== props.mySessionId
          })
        : []
      const selectedGroupMemberIds = selectedGroup && Array.isArray(selectedGroup.members)
        ? selectedGroup.members.map(function (member) { return member && member.sessionId }).filter(function (id) { return typeof id === 'string' && id.length > 0 })
        : []
      const selectedGroupOnlySelf = !!(selectedGroup && props.mySessionId && selectedGroupMemberIds.length > 0
        && selectedGroupMemberIds.every(function (id) { return id === props.mySessionId }))
      const targetIsGroup = isReply ? isGroupReply : targetType === 'group'
      const subjectLimit = typeof settings.maxSubjectChars === 'number' && settings.maxSubjectChars > 0 ? settings.maxSubjectChars : undefined

      React.useEffect(function () {
        // Group sends are mailbox-only unless the user explicitly turns waking on;
        // workspace/session sends keep following the configured default delivery.
        setWake(targetIsGroup ? false : (defaultWake && allowWake))
      }, [targetIsGroup, defaultWake, allowWake])

      function changeTargetType(next) {
        setTargetType(next)
        setError('')
      }

      function submit() {
        if (sending) return
        setError('')
        const subjectValue = subject.trim()
        const bodyValue = body
        const parsed = parseJsonText(dataText)
        if (!parsed.ok) {
          setError(t('JSON 数据格式错误：', 'Invalid JSON data: ') + parsed.message)
          return
        }
        const files = splitFilePaths(filesText)
        const invalidFiles = files.filter(function (file) { return !isAbsolutePath(file) })
        if (invalidFiles.length) {
          setError(t('附件路径必须是绝对路径：', 'Attachment paths must be absolute: ') + invalidFiles.join('；'))
          return
        }
        if (!bodyValue.trim() && !parsed.present && files.length === 0) {
          setError(t('正文、JSON 数据或附件至少要有一项。', 'Enter a body, JSON data or an attachment.'))
          return
        }
        if (!props.mySessionId) {
          setError(t('发送消息需要当前会话：请先打开一个会话，再回来发送。', 'Sending needs a current session: open a session first, then send from here.'))
          return
        }
        let toValue = ''
        let toSessionValue = ''
        let groupValue = ''
        let memberIdsValue = []
        if (isReply) {
          if (isGroupReply) {
            if (!replyGroupId && !replyGroupLabel) {
              setError(t('原消息缺少群组信息，无法回复。', 'The original message has no group information, so it cannot be replied to.'))
              return
            }
            if (replyGroupId && !replyGroupRecord) {
              setError(t('该群组已被删除，无法回复群组消息。', 'That group was deleted, so the group message cannot be replied to.'))
              return
            }
            toValue = 'group:' + replyGroupLabel
            groupValue = replyGroupId
            if (groupAudience === 'subset') {
              if (groupRecipients.length === 0) {
                setError(t('请至少勾选一个收件成员。', 'Check at least one recipient.'))
                return
              }
              memberIdsValue = groupRecipients
            }
          } else {
            toValue = replyTarget
            toSessionValue = replyTo && replyTo.from && typeof replyTo.from.sessionId === 'string' ? replyTo.from.sessionId : ''
            if (!toValue) {
              setError(t('原消息缺少发件会话和工作区路径，无法回复。', 'The original message has no sender session or workspace path, so it cannot be replied to.'))
              return
            }
          }
        } else if (targetType === 'group') {
          if (!selectedGroup) {
            setError(t('请选择目标群组。', 'Choose a target group.'))
            return
          }
          if (selectedGroupOnlySelf) {
            setError(t('群组「', 'Group “') + (selectedGroup.name || selectedGroup.id) + t('」里除你以外没有成员，请先添加其他会话。', '” has no members besides you; add another session first.'))
            return
          }
          toValue = 'group:' + (selectedGroup.name || selectedGroup.id)
          groupValue = selectedGroup.id
          if (groupAudience === 'subset') {
            if (groupRecipients.length === 0) {
              setError(t('请至少勾选一个收件成员。', 'Check at least one recipient.'))
              return
            }
            memberIdsValue = groupRecipients
          }
        } else if (targetType === 'session') {
          if (!targetSession) {
            setError(t('请选择目标会话。', 'Choose a target session.'))
            return
          }
          toValue = targetSession
          toSessionValue = targetSession
        } else {
          toValue = targetWorkspace
          if (!toValue) {
            setError(t('请选择目标工作区。', 'Choose a target workspace.'))
            return
          }
        }
        const payload = {
          to: toValue,
          subject: subjectValue,
          body: bodyValue,
          files: files,
          wake: allowWake ? !!wake : false,
        }
        if (toSessionValue) payload.toSessionId = toSessionValue
        if (groupValue) payload.groupId = groupValue
        if (memberIdsValue.length > 0) payload.memberSessionIds = memberIdsValue
        if (props.mySessionId) payload.fromSessionId = props.mySessionId
        if (parsed.present) payload.data = parsed.value
        if (isReply && replyTo && replyTo.id) payload.replyTo = replyTo.id
        setSending(true)
        call('send', payload).then(function (value) {
          props.onSent(value)
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setSending(false)
        })
      }

      function renderGroupAudience(group) {
        if (!group || groupRecipientMembers.length === 0) return null
        return h(Field, {
          label: t('收件成员', 'Recipients'),
          hint: t('默认全部成员可见；选「指定成员」后只有勾选的人能看到这封。', 'By default all members see it; choose “Selected members” to send only to the checked members.'),
        },
          h('div', { style: { display: 'grid', gap: 6 } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
              h('input', {
                type: 'radio',
                name: 'group-audience',
                checked: groupAudience === 'all',
                onChange: function () { setGroupAudience('all'); setGroupRecipients([]) },
              }),
              t('全部成员', 'All members')),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
              h('input', {
                type: 'radio',
                name: 'group-audience',
                checked: groupAudience === 'subset',
                onChange: function () { setGroupAudience('subset') },
              }),
              t('指定成员', 'Selected members')),
            groupAudience === 'subset'
              ? h('div', { style: { display: 'grid', gap: 4, paddingLeft: 24 } },
                  groupRecipientMembers.map(function (member) {
                    const id = member.sessionId
                    const checked = groupRecipients.indexOf(id) >= 0
                    return h('label', { key: id, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                      h('input', {
                        type: 'checkbox',
                        checked: checked,
                        onChange: function () {
                          setGroupRecipients(function (current) {
                            if (current.indexOf(id) >= 0) return current.filter(function (item) { return item !== id })
                            return current.concat([id])
                          })
                        },
                      }),
                      (member.title ? String(member.title) : shortId(id)) + (member.running ? t('（运行中）', ' (running)') : ''))
                  }),
                  groupRecipients.length === 0
                    ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, t('请至少勾选一个成员。', 'Check at least one member.'))
                    : null)
              : null
          )
        )
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 12px',
            flex: 'none',
            borderBottom: '.5px solid var(--dsw-alias-border-l1)',
          },
        },
          h('span', { style: { flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
            isReply ? t('回复消息', 'Reply') : t('新消息', 'New message')),
          h(Button, { variant: 'outline', onClick: props.onCancel, disabled: sending }, t('取消', 'Cancel'))
        ),
        h('div', {
          className: 'dshcw-scroll',
          style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px', display: 'grid', gap: 12, alignContent: 'start' },
        },
          error ? h(AlertBanner, { onDismiss: function () { setError('') }, dismissLabel: t('关闭', 'Dismiss') }, error) : null,
          isReply
            ? h('div', {
                style: {
                  display: 'grid',
                  gap: 3,
                  padding: '10px 12px',
                  border: '.5px solid var(--dsw-alias-border-l2)',
                  borderRadius: '8px',
                  background: 'var(--dsw-alias-bg-layer-2)',
                },
              },
                h('span', {
                  style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
                }, isGroupReply
                  ? t('回复到群组（已锁定）', 'Replying to group (locked)')
                  : t('回复给（已锁定）', 'Replying to (locked)')),
                isGroupReply
                  ? h('span', { style: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' } },
                      groupLabelOf(replyTo && replyTo.to, t) + (replyGroupMemberCount > 0 ? t(' · ', ' · ') + replyGroupMemberCount + t(' 位成员', ' members') : ''))
                  : h('span', { style: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' } }, fullParty(replyTo && replyTo.from, t)),
                isGroupReply
                  ? (replyGroupId || replyGroupLabel
                      ? h('span', { className: 'dshcw-code', style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' } }, replyGroupId || replyGroupLabel)
                      : h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, t('原消息缺少可用的群组地址', 'The original message has no usable group address')))
                  : (replyTarget
                      ? h('span', { className: 'dshcw-code', style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' } }, replyTarget)
                      : h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, t('原消息缺少可用的发件地址', 'The original message has no usable sender address'))),
                isGroupReply ? renderGroupAudience(replyGroupRecord) : null
              )
            : h('div', { style: { display: 'grid', gap: 12 } },
                h(Field, { label: t('目标类型', 'Target type') },
                  h(Select, {
                    value: targetType,
                    'aria-label': t('目标类型', 'Target type'),
                    onChange: function (event) { changeTargetType(event.target.value) },
                  },
                    h('option', { value: 'session' }, t('指定会话', 'Specific session')),
                    h('option', { value: 'group' }, t('群组', 'Group')),
                    allowWorkspaceBroadcast ? h('option', { value: 'workspace' }, t('工作区广播', 'Workspace broadcast')) : null
                  )
                ),
                targetType === 'group'
                  ? h(Field, {
                      label: t('目标群组', 'Target group'),
                      hint: t('群组可跨工作区；只有发送时的成员会收到这封消息。', 'Groups can span workspaces; only the members at send time receive this message.'),
                    },
                      groups.length === 0
                        ? h('div', { style: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } },
                            t('还没有群组，先在左侧「群组」区新建一个。', 'No groups yet; create one in the Groups section on the left.'))
                        : h('div', { style: { display: 'grid', gap: 6 } },
                            h(Select, {
                              value: targetGroup,
                              'aria-label': t('目标群组', 'Target group'),
                              onChange: function (event) {
                                setTargetGroup(event.target.value)
                                setGroupAudience('all')
                                setGroupRecipients([])
                                setError('')
                              },
                            },
                              h('option', { value: '' }, t('请选择群组', 'Choose a group')),
                              groups.map(function (group) {
                                const memberCount = typeof group.memberCount === 'number'
                                  ? group.memberCount
                                  : (Array.isArray(group.members) ? group.members.length : 0)
                                return h('option', { key: group.id, value: group.id },
                                  (group.name || group.id) + t('（', ' (') + memberCount + t(' 位成员）', ' members)'))
                              })
                            ),
                            selectedGroupOnlySelf
                              ? h('div', { style: { fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-state-error-primary)' } },
                                  t('这个群组里除你以外没有成员，请先在群组编辑器里添加其他会话。', 'This group has no members besides you; add another session in the group editor first.'))
                              : null,
                            renderGroupAudience(selectedGroup)
                          )
                    )
                  : h('div', { style: { display: 'grid', gap: 12 } },
                      h(Field, {
                        label: targetType === 'session' ? t('所在工作区', 'Workspace') : t('目标工作区', 'Target workspace'),
                        hint: targetType === 'session'
                          ? undefined
                          : t('广播给该工作区里当时和以后的所有会话。', 'Broadcast to the sessions present now and later in that workspace.'),
                      },
                        h(Select, {
                          value: targetWorkspace,
                          'aria-label': t('目标工作区', 'Target workspace'),
                          onChange: function (event) {
                            setTargetWorkspace(event.target.value)
                            setTargetSession('')
                            setError('')
                          },
                        },
                          workspaces.length === 0 ? h('option', { value: '' }, t('（没有可用工作区）', '(no workspace available)')) : null,
                          workspaces.map(function (item) {
                            const label = (item.title || basename(item.path) || item.path) + ' — ' + item.path
                            return h('option', { key: item.path, value: item.path }, label)
                          })
                        )
                      ),
                      targetType === 'session'
                        ? h(Field, {
                            label: t('目标会话', 'Target session'),
                            hint: sessions.length === 0
                              ? t('该工作区没有会话，请选择其他工作区。', 'This workspace has no sessions; choose another workspace.')
                              : t('目标正在运行时最多等待设置中的秒数；仍未结束则排队到下一轮。', 'If the target is running, the plugin waits up to the configured seconds, then queues the message for its next turn.'),
                          },
                            sessions.length === 0
                              ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('（没有会话）', '(no sessions)'))
                              : h(Select, {
                                  value: targetSession,
                                  'aria-label': t('目标会话', 'Target session'),
                                  onChange: function (event) {
                                    setTargetSession(event.target.value)
                                    setError('')
                                  },
                                },
                                  h('option', { value: '' }, t('请选择会话', 'Choose a session')),
                                  sessions.map(function (session) {
                                    const sessionId = typeof session.sessionId === 'string' ? session.sessionId : ''
                                    return h('option', { key: sessionId, value: sessionId },
                                      (session.title ? String(session.title) : shortId(sessionId)) + (session.running ? t('（运行中）', ' (running)') : ''))
                                  })
                                )
                          )
                        : null
                    )
              ),
          h(Field, { label: t('主题', 'Subject') },
            h(Input, {
              value: subject,
              maxLength: subjectLimit,
              placeholder: t('简要说明这封消息', 'Short summary of this message'),
              'aria-label': t('主题', 'Subject'),
              onChange: function (event) {
                setSubject(event.target.value)
                setError('')
              },
            })
          ),
          h(Field, { label: t('正文', 'Body') },
            h(Textarea, {
              value: body,
              rows: 7,
              placeholder: t('给目标会话的说明、请求或背景', 'Context, request or explanation for the target session'),
              'aria-label': t('正文', 'Body'),
              onChange: function (event) {
                setBody(event.target.value)
                setError('')
              },
            })
          ),
          h(Field, { label: t('JSON 数据（可选）', 'JSON data (optional)'), hint: t('必须是合法 JSON；会原样附在消息里。', 'Must be valid JSON; it is attached to the message as-is.') },
            h(Textarea, {
              value: dataText,
              rows: 5,
              spellCheck: false,
              placeholder: '{ "key": "value" }',
              'aria-label': t('JSON 数据', 'JSON data'),
              style: { fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace' },
              onChange: function (event) {
                setDataText(event.target.value)
                setError('')
              },
            })
          ),
          h(Field, { label: t('附件路径（可选）', 'Attachment paths (optional)'), hint: t('每行一个绝对路径，文件会复制进消息库；默认只允许发送方工作区内的文件。', 'One absolute path per line; files are copied into the message store. By default only files inside the sender workspace are allowed.') },
            h(Textarea, {
              value: filesText,
              rows: 3,
              spellCheck: false,
              placeholder: 'C:\\work\\report.txt',
              'aria-label': t('附件路径', 'Attachment paths'),
              style: { fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace' },
              onChange: function (event) {
                setFilesText(event.target.value)
                setError('')
              },
            })
          ),
          h('div', {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '6px 12px',
              paddingTop: 2,
            },
          },
            h(Switch, {
              label: targetIsGroup ? t('尝试唤醒空闲成员', 'Wake idle members') : t('投递后唤醒目标会话', 'Wake the target session after delivery'),
              checked: wake && allowWake,
              disabled: !allowWake,
              onChange: function (event) { setWake(event.target.checked) },
            }),
            !allowWake
              ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, t('设置中已关闭唤醒，本次只进信箱。', 'Wake is disabled in settings; this message goes to the mailbox only.'))
              : null
          ),
          targetIsGroup
            ? h('div', { style: { fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } },
                wake && allowWake
                  ? t('会尝试唤醒空闲成员；运行中的成员先等待，超时排队到下一轮。', 'Idle members will be woken; running members are waited for, then queued for their next turn if still busy.')
                  : t('群组消息默认只进信箱；打开「尝试唤醒空闲成员」后才会唤醒空闲成员。', 'Group messages are mailbox-only by default; turn on “Wake idle members” to actively wake idle members.'))
            : null,
          !props.mySessionId
            ? h('div', { style: { fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } },
                t('当前没有选中会话；发送消息前请先打开一个会话。', 'No session is selected; open a session before sending a message.'))
            : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 } },
            h(Button, { variant: 'outline', onClick: props.onCancel, disabled: sending }, t('取消', 'Cancel')),
            h(Button, {
              variant: 'primary',
              onClick: submit,
              disabled: sending
                || (isReply && !isGroupReply && !replyTarget)
                || (!isReply && targetType === 'group' && (groups.length === 0 || selectedGroupOnlySelf)),
            }, sending ? t('发送中…', 'Sending…') : t('发送', 'Send'))
          )
        )
      )
    }

    // ---------------------------------------------------------------------------
    // Group editor
    // ---------------------------------------------------------------------------

    function GroupEditorView(props) {
      const t = props.t
      const call = props.call
      const data = props.data
      const groups = Array.isArray(props.groups) ? props.groups : []
      const directory = props.sessionDirectory
      const editing = !!(props.group && typeof props.group.id === 'string' && props.group.id)
      const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : []
      const orphans = data && Array.isArray(data.orphans) ? data.orphans : []
      const maxMembers = typeof props.maxGroupMembers === 'number' && props.maxGroupMembers > 0 ? props.maxGroupMembers : 32
      const nameLimit = 60

      const initialMemberIds = (function () {
        const group = props.group
        if (!group) return []
        if (Array.isArray(group.sessionIds)) return group.sessionIds.filter(function (id) { return typeof id === 'string' && id.length > 0 })
        if (Array.isArray(group.members)) {
          return group.members.map(function (member) { return member && member.sessionId }).filter(function (id) { return typeof id === 'string' && id.length > 0 })
        }
        return []
      })()

      const [name, setName] = React.useState(props.group && typeof props.group.name === 'string' ? props.group.name : '')
      const [selectedIds, setSelectedIds] = React.useState(initialMemberIds)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const selectedSet = React.useMemo(function () { return new Set(selectedIds) }, [selectedIds])

      function toggleSession(sessionId, checked) {
        setSelectedIds(function (previous) {
          const present = previous.indexOf(sessionId) !== -1
          if (checked && !present) return previous.concat([sessionId])
          if (!checked && present) return previous.filter(function (id) { return id !== sessionId })
          return previous
        })
        setError('')
      }

      function toggleWorkspace(sessionIds, checked) {
        setSelectedIds(function (previous) {
          const next = new Set(previous)
          sessionIds.forEach(function (sessionId) {
            if (checked) next.add(sessionId)
            else next.delete(sessionId)
          })
          return Array.from(next)
        })
        setError('')
      }

      const buckets = []
      const knownSessions = new Set()
      workspaces.forEach(function (workspace) {
        const path = typeof workspace.path === 'string' ? workspace.path : ''
        const sessionIds = (Array.isArray(workspace.sessions) ? workspace.sessions : [])
          .map(function (session) { return session && session.sessionId })
          .filter(function (id) { return typeof id === 'string' && id.length > 0 })
        sessionIds.forEach(function (id) { knownSessions.add(id) })
        buckets.push({
          key: 'w:' + path,
          title: workspace.title || basename(path) || path,
          subtitle: path,
          sessionIds: sessionIds,
        })
      })
      if (orphans.length > 0) {
        const sessionIds = orphans.map(function (session) { return session && session.sessionId })
          .filter(function (id) { return typeof id === 'string' && id.length > 0 })
        sessionIds.forEach(function (id) { knownSessions.add(id) })
        buckets.push({
          key: '__orphans__',
          title: t('未归入工作区', 'Not in a workspace'),
          subtitle: t('这些会话不属于任何已注册工作区', 'These sessions are outside every registered workspace'),
          sessionIds: sessionIds,
        })
      }
      const extras = selectedIds.filter(function (id) { return !knownSessions.has(id) })
      if (extras.length > 0) {
        buckets.push({
          key: '__extras__',
          title: t('其他会话', 'Other sessions'),
          subtitle: t('来自已删除或当前未加载的会话', 'From deleted or currently unloaded sessions'),
          sessionIds: extras,
        })
      }

      function save() {
        if (busy) return
        setError('')
        const groupName = name.trim()
        if (!groupName) {
          setError(t('请填写群组名称。', 'Enter a group name.'))
          return
        }
        if (Array.from(groupName).length > nameLimit) {
          setError(t('群组名称不能超过 60 个字符。', 'Group names cannot exceed 60 characters.'))
          return
        }
        if (selectedIds.length === 0) {
          setError(t('请至少选择一个会话。', 'Select at least one session.'))
          return
        }
        if (selectedIds.length > maxMembers) {
          setError(t('一个群组最多 ', 'A group can have at most ') + maxMembers + t(' 位成员。', ' members.'))
          return
        }
        setBusy('save')
        const request = editing
          ? call('groupUpdate', { id: props.group.id, name: groupName, sessionIds: selectedIds })
          : call('groupCreate', { name: groupName, sessionIds: selectedIds })
        request.then(function (value) {
          props.onSaved(value || null, editing ? 'edit' : 'create')
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setBusy('')
        })
      }

      function remove() {
        if (!editing || busy) return
        const groupName = props.group && props.group.name ? props.group.name : ''
        if (!safeConfirm(t('删除群组「', 'Delete group “') + groupName + t('」？已发出的群组消息会保留在信箱里。', '”? Messages already sent to it stay in mailboxes.'))) return
        setBusy('delete')
        setError('')
        call('groupDelete', { id: props.group.id }).then(function () {
          props.onDeleted(props.group.id)
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setBusy('')
        })
      }

      const selectedChips = selectedIds.map(function (sessionId) {
        return h('span', {
          key: sessionId,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            maxWidth: '100%',
            padding: '1px 6px',
            borderRadius: 999,
            border: '.5px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 11,
            lineHeight: '18px',
          },
        },
          h('span', { className: 'dshcw-truncate', title: sessionFullLabelOf(directory, sessionId, t) }, sessionLabelOf(directory, sessionId, t)),
          h('button', {
            type: 'button',
            'aria-label': t('移除成员 ', 'Remove member ') + sessionLabelOf(directory, sessionId, t),
            onClick: function () { toggleSession(sessionId, false) },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              padding: 0,
              border: '0',
              borderRadius: '8px',
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary)',
              cursor: 'pointer',
              flex: 'none',
            },
          }, h(CloseGlyph, { size: 10 }))
        )
      })

      const bucketBlocks = buckets.map(function (bucket) {
        const selectedCount = bucket.sessionIds.filter(function (id) { return selectedSet.has(id) }).length
        const allSelected = bucket.sessionIds.length > 0 && selectedCount === bucket.sessionIds.length
        return h('div', {
          key: bucket.key,
          style: {
            border: '.5px solid var(--dsw-alias-border-l2)',
            borderRadius: '8px',
            overflow: 'hidden',
            minWidth: 0,
          },
        },
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
              padding: '6px 10px',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
            h(Checkbox, {
              label: bucket.title,
              checked: allSelected,
              onChange: function (event) { toggleWorkspace(bucket.sessionIds, event.target.checked) },
            }),
            h('span', { className: 'dshcw-truncate', title: bucket.subtitle, style: { flex: 1, minWidth: 60, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, bucket.subtitle),
            h('span', { style: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, selectedCount + '/' + bucket.sessionIds.length)
          ),
          bucket.sessionIds.length === 0
            ? h('div', { style: { padding: '8px 10px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, t('没有会话', 'No sessions'))
            : h('div', { style: { display: 'grid', gap: 0 } }, bucket.sessionIds.map(function (sessionId) {
                const record = directory && typeof directory.get === 'function' ? directory.get(sessionId) : undefined
                const running = !!(record && record.running)
                return h('div', {
                  key: sessionId,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 10px',
                    borderTop: '.5px solid var(--dsw-alias-border-l1)',
                    minWidth: 0,
                  },
                },
                  h(Checkbox, {
                    label: sessionLabelOf(directory, sessionId, t),
                    checked: selectedSet.has(sessionId),
                    onChange: function (event) { toggleSession(sessionId, event.target.checked) },
                  }),
                  h('span', { className: 'dshcw-truncate', title: sessionId, style: { flex: 1, minWidth: 40, fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } }, sessionId),
                  running ? h(Badge, { tone: 'idle' }, t('运行中', 'Running')) : null
                )
              }))
        )
      })

      return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 12px',
            flex: 'none',
            borderBottom: '.5px solid var(--dsw-alias-border-l1)',
          },
        },
          h('span', { style: { flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
            editing ? t('编辑群组', 'Edit group') : t('新建群组', 'New group')),
          h(Button, { variant: 'outline', onClick: props.onCancel, disabled: !!busy }, t('取消', 'Cancel'))
        ),
        h('div', {
          className: 'dshcw-scroll',
          style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px', display: 'grid', gap: 12, alignContent: 'start' },
        },
          error ? h(AlertBanner, { onDismiss: function () { setError('') }, dismissLabel: t('关闭', 'Dismiss') }, error) : null,
          h('div', {
            style: {
              padding: '9px 12px',
              border: '.5px solid var(--dsw-alias-border-l2)',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-2)',
              fontSize: 11,
              lineHeight: 1.7,
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, t(
            '群组可以把不同工作区的会话拉在一起群聊；群组消息只发给发送时的成员，后来加入的成员看不到之前的消息。群组消息不进入工作区未读统计。',
            'A group can pull sessions from different workspaces into one conversation. Group messages go only to the members at send time; members added later cannot see older messages. Group messages do not count toward workspace unread totals.'
          )),
          h(Field, { label: t('群组名称', 'Group name'), hint: t('1 到 60 个字符，大小写不敏感地唯一。', '1 to 60 characters, unique case-insensitively.') },
            h(Input, {
              value: name,
              maxLength: nameLimit,
              placeholder: t('例如：发布协调群', 'For example: Release coordination'),
              'aria-label': t('群组名称', 'Group name'),
              onChange: function (event) {
                setName(event.target.value)
                setError('')
              },
            })
          ),
          h('div', { style: { display: 'grid', gap: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, t('已选成员', 'Selected members')),
              h('span', { style: { fontSize: 11, color: selectedIds.length > maxMembers ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' } },
                selectedIds.length + '/' + maxMembers)
            ),
            selectedChips.length > 0
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, selectedChips)
              : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, t('还没有选择成员。', 'No members selected yet.'))
          ),
          h('div', { style: { display: 'grid', gap: 4 } },
            h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, t('从工作区选择会话', 'Pick sessions from workspaces')),
            buckets.length === 0
              ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, t('没有可用的会话。', 'No sessions available.'))
              : bucketBlocks
          ),
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 4 } },
            editing
              ? h(Button, { variant: 'danger', onClick: remove, disabled: !!busy },
                  busy === 'delete' ? t('删除中…', 'Deleting…') : t('删除群组', 'Delete group'))
              : h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, groups.length + t(' 个群组', ' groups')),
            h('div', { style: { display: 'flex', gap: 8 } },
              h(Button, { variant: 'outline', onClick: props.onCancel, disabled: !!busy }, t('取消', 'Cancel')),
              h(Button, { variant: 'primary', onClick: save, disabled: !!busy },
                busy === 'save'
                  ? t('保存中…', 'Saving…')
                  : (editing ? t('保存更改', 'Save changes') : t('创建群组', 'Create group')))
            )
          )
        )
      )
    }

    // ---------------------------------------------------------------------------
    // Settings section
    // ---------------------------------------------------------------------------

    function formFromSettings(settings) {
      const source = settings && typeof settings === 'object' ? settings : {}
      return {
        defaultDelivery: source.defaultDelivery === 'mailbox' ? 'mailbox' : 'wake',
        allowWake: source.allowWake !== false,
        promptContext: source.promptContext !== false,
        allowExternalAttachments: source.allowExternalAttachments === true,
        allowWorkspaceBroadcast: source.allowWorkspaceBroadcast === true,
        promptLocale: source.promptLocale === 'en' ? 'en' : 'zh',
        retentionDays: String(typeof source.retentionDays === 'number' ? source.retentionDays : 30),
        maxHops: String(typeof source.maxHops === 'number' ? source.maxHops : 6),
        wakesPerMinute: String(typeof source.wakesPerMinute === 'number' ? source.wakesPerMinute : 20),
        waitForIdleSeconds: String(typeof source.waitForIdleSeconds === 'number' ? source.waitForIdleSeconds : 120),
      }
    }

    function SettingsPage(props) {
      const ctx = props.ctx
      const runtime = props.runtime
      const t = useText(ctx)
      const call = useApi(runtime)

      const [form, setForm] = React.useState(null)
      const [loadedSettings, setLoadedSettings] = React.useState(null)
      const [storeDir, setStoreDir] = React.useState('')
      const [counts, setCounts] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [formError, setFormError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [busyAction, setBusyAction] = React.useState('')

      function applyOverview(value) {
        if (!value || typeof value !== 'object') return
        const messages = Array.isArray(value.messages) ? value.messages : []
        let attachments = 0
        messages.forEach(function (mail) {
          if (mail && Array.isArray(mail.files)) attachments += mail.files.length
        })
        setCounts({
          messages: messages.length,
          attachments: attachments,
          unread: typeof value.unreadTotal === 'number' ? value.unreadTotal : 0,
        })
        if (typeof value.storeDir === 'string' && value.storeDir) setStoreDir(value.storeDir)
      }

      const load = React.useCallback(async function () {
        setLoading(true)
        setError('')
        try {
          // `state` carries the settings, store location and management counts;
          // this page does not need a separate settings round-trip.
          const stateValue = await call('state', { filter: 'all', limit: LIMIT })
          if (stateValue) applyOverview(stateValue)
          const effective = stateValue && stateValue.settings ? stateValue.settings : null
          if (effective) {
            setLoadedSettings(effective)
            setForm(formFromSettings(effective))
            setFormError('')
          } else {
            setError(t('无法读取设置。', 'Could not read settings.'))
          }
        } catch (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        } finally {
          setLoading(false)
        }
      }, [call, t])

      React.useEffect(function () {
        void load()
      }, [load])

      const refreshOverview = React.useCallback(async function () {
        try {
          const value = await call('state', { filter: 'all', limit: LIMIT })
          applyOverview(value)
        } catch (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }
      }, [call, t])

      function update(field, value) {
        setForm(function (previous) {
          if (!previous) return previous
          const next = Object.assign({}, previous)
          next[field] = value
          return next
        })
        setFormError('')
        setNotice('')
      }

      function resetForm() {
        if (!loadedSettings) return
        setForm(formFromSettings(loadedSettings))
        setFormError('')
        setNotice('')
      }

      function save() {
        if (!form || saving) return
        const retentionRaw = String(form.retentionDays == null ? '' : form.retentionDays).trim()
        const maxHopsRaw = String(form.maxHops == null ? '' : form.maxHops).trim()
        const wakesRaw = String(form.wakesPerMinute == null ? '' : form.wakesPerMinute).trim()
        const waitRaw = String(form.waitForIdleSeconds == null ? '' : form.waitForIdleSeconds).trim()
        const retentionDays = Number(retentionRaw)
        const maxHops = Number(maxHopsRaw)
        const wakesPerMinute = Number(wakesRaw)
        const waitForIdleSeconds = Number(waitRaw)
        const problems = []
        if (!retentionRaw || !Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
          problems.push(t('保留天数必须是 0 到 3650 之间的整数。', 'Retention days must be an integer between 0 and 3650.'))
        }
        if (!maxHopsRaw || !Number.isInteger(maxHops) || maxHops < 0 || maxHops > 64) {
          problems.push(t('最大跳数必须是 0 到 64 之间的整数。', 'Max hops must be an integer between 0 and 64.'))
        }
        if (!wakesRaw || !Number.isInteger(wakesPerMinute) || wakesPerMinute < 0 || wakesPerMinute > 600) {
          problems.push(t('每分钟唤醒上限必须是 0 到 600 之间的整数。', 'Wakes per minute must be an integer between 0 and 600.'))
        }
        if (!waitRaw || !Number.isInteger(waitForIdleSeconds) || waitForIdleSeconds < 0 || waitForIdleSeconds > 600) {
          problems.push(t('运行中等待秒数必须是 0 到 600 之间的整数。', 'Idle wait seconds must be an integer between 0 and 600.'))
        }
        if (problems.length) {
          setFormError(problems.join(' '))
          return
        }
        setSaving(true)
        setFormError('')
        setNotice('')
        call('settings', {
          patch: {
            defaultDelivery: form.defaultDelivery === 'mailbox' ? 'mailbox' : 'wake',
            allowWake: !!form.allowWake,
            promptContext: !!form.promptContext,
            allowExternalAttachments: !!form.allowExternalAttachments,
            allowWorkspaceBroadcast: !!form.allowWorkspaceBroadcast,
            promptLocale: form.promptLocale === 'en' ? 'en' : 'zh',
            retentionDays: retentionDays,
            maxHops: maxHops,
            wakesPerMinute: wakesPerMinute,
            waitForIdleSeconds: waitForIdleSeconds,
          },
        }).then(function (value) {
          const settings = value && value.settings ? value.settings : null
          if (settings) {
            setLoadedSettings(settings)
            setForm(formFromSettings(settings))
          }
          setNotice(t('设置已保存。', 'Settings saved.'))
          void refreshOverview()
        }).catch(function (reason) {
          if (!isAbortError(reason)) setFormError(errorMessage(reason, t))
        }).finally(function () {
          setSaving(false)
        })
      }

      function pruneNow() {
        if (busyAction) return
        if (!safeConfirm(t('清理过期与超量的消息？未读消息同样可能被清理。', 'Prune expired and excess messages? Unread messages may be pruned too.'))) return
        setBusyAction('prune')
        setError('')
        setNotice('')
        call('prune', {}).then(function (value) {
          const removed = value && typeof value.removed === 'number' ? value.removed : 0
          const kept = value && typeof value.kept === 'number' ? value.kept : 0
          setNotice(t('清理完成：删除 ', 'Prune complete: removed ') + removed + t(' 条，保留 ', ' messages, kept ') + kept + t(' 条。', ' messages.'))
          if (value && typeof value.storeDir === 'string' && value.storeDir) setStoreDir(value.storeDir)
          void refreshOverview()
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setBusyAction('')
        })
      }

      function clearNow(scope) {
        if (busyAction) return
        const message = scope === 'all'
          ? t('清空全部消息？包括未读消息，且无法恢复。', 'Clear all messages, including unread ones? This cannot be undone.')
          : t('删除所有至少被一个查看者读过的消息？', 'Delete every message that at least one viewer has read?')
        if (!safeConfirm(message)) return
        setBusyAction(scope === 'all' ? 'clear-all' : 'clear-read')
        setError('')
        setNotice('')
        call('clear', { scope: scope === 'all' ? 'all' : 'read' }).then(function (value) {
          const removed = value && typeof value.removed === 'number' ? value.removed : 0
          setNotice(t('已删除 ', 'Removed ') + removed + t(' 条消息。', ' messages.'))
          void refreshOverview()
        }).catch(function (reason) {
          if (!isAbortError(reason)) setError(errorMessage(reason, t))
        }).finally(function () {
          setBusyAction('')
        })
      }

      const cards = []
      cards.push(h(SettingsCard, { key: 'usage', title: t('怎么用', 'How to use') },
        h('p', {
          style: {
            margin: '8px 0 14px',
            fontSize: 12,
            lineHeight: 1.7,
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, t(
          '会话里的 Agent 可以用 mail_send、mail_inbox、mail_reply、mail_wait、workspace_list 收发跨工作区消息；也可以打开左侧栏的“跨工作区信使”面板查看、回复和发起消息。唤醒投递会让目标会话立刻开始一轮处理，信箱投递只等目标会话下次运行时出现在系统提示里。',
          'Agents exchange cross-workspace messages with the mail_send, mail_inbox, mail_reply, mail_wait and workspace_list tools, or you can use the Cross-workspace courier panel in the sidebar. Wake delivery starts a turn in the target session immediately; mailbox delivery only appears in its system prompt on the next run.'
        ))
      ))

      if (form) {
        cards.push(h(SettingsCard, {
          key: 'delivery',
          title: t('投递与提示', 'Delivery & prompt'),
          description: t('这些选项会立即影响新消息的投递方式。', 'These options affect how new messages are delivered.'),
        },
          h(SettingRow, {
            label: t('默认投递方式', 'Default delivery'),
            hint: t('界面和工具未显式指定时使用。', 'Used when the UI or a tool does not specify one.'),
          },
            h(Select, {
              value: form.defaultDelivery,
              'aria-label': t('默认投递方式', 'Default delivery'),
              onChange: function (event) { update('defaultDelivery', event.target.value) },
              style: { width: 180 },
            },
              h('option', { value: 'wake' }, t('唤醒（wake）', 'Wake')),
              h('option', { value: 'mailbox' }, t('信箱（mailbox）', 'Mailbox'))
            )
          ),
          h(SettingRow, {
            label: t('允许唤醒', 'Allow wake'),
            hint: t('总开关；关闭后所有投递都只进信箱。', 'Master switch; when off, every delivery goes to the mailbox.'),
          },
            h(Switch, {
              label: t('允许唤醒', 'Allow wake'),
              checked: form.allowWake,
              onChange: function (event) { update('allowWake', event.target.checked) },
            })
          ),
          h(SettingRow, {
            label: t('允许工作区广播', 'Allow workspace broadcasts'),
            hint: t('默认关闭：消息只能发给指定会话或群组，避免无关智能体读取。开启后工作区内所有会话都能看到广播。', 'Off by default: messages go only to a specific session or group. When on, every session in the workspace can read broadcasts.'),
          },
            h(Switch, {
              label: t('允许工作区广播', 'Allow workspace broadcasts'),
              checked: form.allowWorkspaceBroadcast,
              onChange: function (event) { update('allowWorkspaceBroadcast', event.target.checked) },
            })
          ),
          h(SettingRow, {
            label: t('系统提示显示未读摘要', 'Show unread summary in system prompt'),
            hint: t('关闭后不占用 Agent 的提示 token。', 'When off, no prompt tokens are spent on unread mail.'),
          },
            h(Checkbox, {
              label: t('启用', 'Enabled'),
              checked: form.promptContext,
              onChange: function (event) { update('promptContext', event.target.checked) },
            })
          ),
          h(SettingRow, {
            label: t('允许发送工作区外附件', 'Allow attachments outside the workspace'),
            hint: t('默认关闭：附件必须来自发送方工作区，防止绕过文件权限。只在明确信任所有 Agent 时打开。', 'Off by default: attachments must come from the sender workspace, preventing filesystem-sandbox bypass. Enable only when you trust every agent.'),
          },
            h(Checkbox, {
              label: t('允许', 'Allow'),
              checked: form.allowExternalAttachments,
              onChange: function (event) { update('allowExternalAttachments', event.target.checked) },
            })
          ),
          h(SettingRow, {
            label: t('提示语言', 'Prompt locale'),
            hint: t('未读摘要与工具返回文本的语言。', 'Language of unread summaries and tool output.'),
            last: true,
          },
            h(Select, {
              value: form.promptLocale,
              'aria-label': t('提示语言', 'Prompt locale'),
              onChange: function (event) { update('promptLocale', event.target.value) },
              style: { width: 180 },
            },
              h('option', { value: 'zh' }, t('中文', 'Chinese')),
              h('option', { value: 'en' }, t('英文', 'English'))
            )
          )
        ))

        cards.push(h(SettingsCard, {
          key: 'limits',
          title: t('限制', 'Limits'),
          description: t('数值会在保存时校验；保留天数填 0 表示不按时间清理。', 'Values are validated on save; retention days 0 disables age-based cleanup.'),
        },
          h(SettingRow, {
            label: t('保留天数', 'Retention days'),
            hint: t('0 = 不按时间清理。', '0 = never prune by age.'),
          },
            h(Input, {
              type: 'number',
              min: 0,
              step: 1,
              value: form.retentionDays,
              'aria-label': t('保留天数', 'Retention days'),
              onChange: function (event) { update('retentionDays', event.target.value) },
              style: { width: 130 },
            })
          ),
          h(SettingRow, {
            label: t('最大跳数', 'Max hops'),
            hint: t('超过后回复只进信箱，默认 6。', 'Replies beyond this hop count go to the mailbox only; default 6.'),
          },
            h(Input, {
              type: 'number',
              min: 0,
              step: 1,
              value: form.maxHops,
              'aria-label': t('最大跳数', 'Max hops'),
              onChange: function (event) { update('maxHops', event.target.value) },
              style: { width: 130 },
            })
          ),
          h(SettingRow, {
            label: t('每分钟唤醒上限', 'Wakes per minute'),
            hint: t('超出后本次降级为信箱；0 = 不限制，默认 20。', 'Excess wake attempts fall back to the mailbox; 0 disables the limit; default 20.'),
          },
            h(Input, {
              type: 'number',
              min: 0,
              max: 600,
              step: 1,
              value: form.wakesPerMinute,
              'aria-label': t('每分钟唤醒上限', 'Wakes per minute'),
              onChange: function (event) { update('wakesPerMinute', event.target.value) },
              style: { width: 130 },
            })
          ),
          h(SettingRow, {
            label: t('运行中等待秒数', 'Wait while target is running'),
            hint: t('唤醒目标正在运行时最多等多久再排队；0 = 不等待直接排队。默认 120。', 'How long to wait for a running wake target before queueing; 0 = queue immediately. Default 120.'),
            last: true,
          },
            h(Input, {
              type: 'number',
              min: 0,
              max: 600,
              step: 1,
              value: form.waitForIdleSeconds,
              'aria-label': t('运行中等待秒数', 'Wait while target is running'),
              onChange: function (event) { update('waitForIdleSeconds', event.target.value) },
              style: { width: 130 },
            })
          )
        ))

        if (formError) cards.push(h(AlertBanner, {
          key: 'form-error',
          onDismiss: function () { setFormError('') },
          dismissLabel: t('关闭', 'Dismiss'),
        }, formError))

        cards.push(h('div', {
          key: 'save',
          style: { display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
        },
          h(Button, { variant: 'outline', onClick: resetForm, disabled: saving }, t('重置', 'Reset')),
          h(Button, { variant: 'primary', onClick: save, disabled: saving }, saving ? t('保存中…', 'Saving…') : t('保存设置', 'Save settings'))
        ))
      }

      cards.push(h(SettingsCard, {
        key: 'storage',
        title: t('存储与清理', 'Storage & cleanup'),
        description: t('消息与附件保存在本机插件目录里。', 'Messages and attachments live in the local plugin directory.'),
        footer: [
          h(Button, { key: 'prune', variant: 'outline', disabled: !!busyAction, onClick: pruneNow },
            busyAction === 'prune' ? t('清理中…', 'Pruning…') : t('清理过期消息', 'Prune messages')),
          h(Button, { key: 'read', variant: 'outline', disabled: !!busyAction, onClick: function () { clearNow('read') } },
            busyAction === 'clear-read' ? t('删除中…', 'Deleting…') : t('删除已读', 'Delete read')),
          h(Button, { key: 'all', variant: 'danger', disabled: !!busyAction, onClick: function () { clearNow('all') } },
            busyAction === 'clear-all' ? t('删除中…', 'Deleting…') : t('清空全部', 'Clear all')),
        ],
      },
        h(SettingRow, { label: t('存储位置', 'Store location') },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap', justifyContent: 'flex-end' } },
            storeDir
              ? h('span', { className: 'dshcw-code', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, storeDir)
              : h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, t('（尚未加载）', '(not loaded)')),
            storeDir ? h(CopyTextButton, { t: t, text: storeDir, label: t('复制路径', 'Copy path') }) : null
          )
        ),
        h(SettingRow, {
          label: t('当前视图统计', 'Current view counts'),
          hint: t('统计来自管理视角的最新加载结果，不等于库中总数。', 'Counts describe the latest management-view load, not the whole store.'),
          last: true,
        },
          counts
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' } },
                h(Badge, null, t('消息 ', 'Messages ') + counts.messages),
                h(Badge, null, t('附件 ', 'Files ') + counts.attachments),
                h(Badge, { tone: counts.unread > 0 ? 'brand' : 'plain' }, t('未读 ', 'Unread ') + counts.unread))
            : h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, t('（尚未加载）', '(not loaded)'))
        )
      ))

      return h('div', {
        className: 'dshcw-root',
        style: {
          display: 'grid',
          gap: 16,
          alignContent: 'start',
          height: 'auto',
          maxWidth: 860,
          paddingBottom: 24,
          boxSizing: 'border-box',
        },
      },
        h(Styles, { key: 'styles' }),
        h('div', { key: 'heading' },
          h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('跨工作区信使', 'Cross-workspace courier')),
          h('p', {
            style: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
          }, t('管理消息投递、唤醒与存储清理。', 'Manage delivery, wake behaviour and storage cleanup.'))
        ),
        loading && !form
          ? h('div', { key: 'loading', style: { padding: '20px 0' } }, h(Spinner, { label: t('正在加载设置…', 'Loading settings…') }))
          : null,
        error
          ? h(AlertBanner, { key: 'error', onDismiss: function () { setError('') }, dismissLabel: t('关闭', 'Dismiss') }, error)
          : null,
        notice
          ? h(AlertBanner, { key: 'notice', tone: 'success', role: 'status', onDismiss: function () { setNotice('') }, dismissLabel: t('关闭', 'Dismiss') }, notice)
          : null,
        !form && !loading
          ? h('div', { key: 'reload' }, h(Button, { variant: 'outline', onClick: function () { void load() } }, t('重新加载', 'Reload')))
          : null,
        h('div', { key: 'cards', style: { display: 'grid', gap: 16 } }, cards)
      )
    }

    // ---------------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------------

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h(EnvelopeGlyph, { size: size })
    }

    function apply(ctx) {
      const runtime = { disposed: false, controllers: new Set() }

      ctx.effect(function () {
        return function () {
          runtime.disposed = true
          runtime.controllers.forEach(function (controller) {
            try {
              controller.abort()
            } catch (error) {
              // already settled
            }
          })
          runtime.controllers.clear()
        }
      }, 'cross-workspace: management client lifecycle')

      function label() {
        return isZhLocale(ctx) ? '跨工作区信使' : 'Cross-workspace courier'
      }

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'cross-workspace',
          order: 23,
          label: label,
        }, PanelIcon)
      })

      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: 'cross-workspace',
        }, function CrossWorkspaceMain(props) {
          return h(ManagementPage, Object.assign({}, props, { ctx: ctx, runtime: runtime }))
        })
      })

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'cross-workspace',
          order: 62,
          label: label,
        }, function CrossWorkspaceSettings(props) {
          return h(SettingsPage, Object.assign({}, props, { ctx: ctx, runtime: runtime }))
        })
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply: apply,
    }
  },
})
