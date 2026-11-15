/**
 * UI contract checks for behaviours that cannot be exercised without a DSH
 * Host/browser. These are intentionally narrow: they guard the two v0.9.0 P0
 * regressions (group filter and destructive clear label) without pretending to
 * be a rendered UI test.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function luminance(hex) {
  const channels = hex.replace('#', '').match(/.{2}/g).map(part => parseInt(part, 16) / 255)
  const linear = channels.map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrastRatio(first, second) {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function functionBody(name) {
  const start = client.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `missing function ${name}`)
  const next = client.indexOf('\n      function ', start + 1)
  return client.slice(start, next === -1 ? undefined : next)
}

describe('client P0 contracts', () => {
  it('selectGroup switches the list away from the session inbox', () => {
    const body = functionBody('selectGroup')
    assert.match(body, /setGroupIdFilter\(group\.id\)/)
    assert.match(body, /setFilter\('group'\)/)
  })

  it('renders the U1 chip set instead of the old four tabs', () => {
    assert.match(client, /function FilterChips\(/)
    assert.match(client, /id: 'unread'/)
    assert.match(client, /id: 'broadcast'/)
    assert.match(client, /id: 'group'/)
  })

  it('wires all five chip counters, including zero values', () => {
    assert.match(client, /count: chipCounts\.all/)
    assert.match(client, /count: chipCounts\.unread/)
    assert.match(client, /count: chipCounts\.me/)
    assert.match(client, /count: chipCounts\.broadcast/)
    assert.match(client, /count: chipCounts\.group/)
    assert.match(client, /String\(item\.count\)/)
  })

  it('counts one group chip target, not every group on the page', () => {
    const start = client.indexOf('// CHIP_COUNTS_START')
    const end = client.indexOf('// CHIP_COUNTS_END')
    assert.ok(start >= 0 && end > start)
    const factory = new Function(client.slice(start, end) + '\nreturn { chipCountsFor, isForMeMailFor }')
    const { chipCountsFor } = factory()
    const messages = [
      { to: { groupId: 'g1', memberSessionIds: ['me'] } },
      { to: { groupId: 'g1', memberSessionIds: ['me'] } },
      { to: { groupId: 'g2', memberSessionIds: ['me'] } },
      { to: { sessionId: 'me' } },
      { to: { workspacePath: 'D:\\ws' } },
      { to: { groupId: 'legacy' } }, // no snapshot: not "to me"
    ]
    const counts = chipCountsFor(messages, {
      viewerSessionId: 'me',
      viewerWorkspacePath: 'd:\\ws',
      broadcastEnabled: true,
      groupId: 'g1',
    })
    assert.deepEqual(counts, { all: 6, unread: 6, me: 5, broadcast: 1, group: 2 })
    assert.equal(chipCountsFor(messages, { groupId: '' }).group, 0)
  })

  it('splits list and detail at >=1100 and keeps a 340 list column', () => {
    assert.match(client, /function useSplitViewport\(/)
    assert.match(client, /gridTemplateColumns: '340px minmax\(0, 1fr\)'/)
    assert.match(client, /function closeDetail\(/)
    assert.match(client, /data-mail-id/)
    assert.match(client, /const showSplitDetail =/)
  })

  it('renders ManagementPage once with fake React (catches ReferenceError)', () => {
    const hooks = []
    let cursor = 0
    const fakeReact = {
      createElement(type, props) { return { type, props: props || {} } },
      useState(init) {
        const index = cursor++
        if (!(index in hooks)) hooks[index] = typeof init === 'function' ? init() : init
        return [hooks[index], function () {}]
      },
      useRef(init) {
        const index = cursor++
        if (!(index in hooks)) hooks[index] = { current: init }
        return hooks[index]
      },
      useMemo(fn) { return fn() },
      useCallback(fn) { return fn },
      useEffect() {},
      useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    }
    let plugin
    const windowObject = {
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: { load: entry => { plugin = entry.factory(() => fakeReact) } },
    }
    const source = client + '\n//# sourceURL=client.js'
    const evaluate = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', source)
    evaluate(windowObject, undefined, console, setTimeout, clearTimeout)
    assert.ok(plugin && plugin.__test && typeof plugin.__test.ManagementPage === 'function')
    const tree = plugin.__test.ManagementPage({
      ctx: { locale: null, get: () => undefined },
      runtime: { controllers: new Set() },
    })
    assert.ok(tree && typeof tree === 'object')
  })

  it('compose drawer searches recipients and folds advanced options', () => {
    assert.match(client, /收件人搜索/)
    assert.match(client, /function clearRecipient\(/)
    assert.match(client, /高级选项/)
    assert.match(client, /position: 'fixed'/)
  })

  it('renders DashboardView and keeps KPI values consistent with stats', () => {
    const hooks = []
    let cursor = 0
    const fakeReact = {
      createElement(type, props, ...children) { return { type, props: Object.assign({}, props || {}, { children }) } },
      useState(init) {
        const index = cursor++
        if (!(index in hooks)) hooks[index] = typeof init === 'function' ? init() : init
        return [hooks[index], function () {}]
      },
      useRef(init) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: init }; return hooks[index] },
      useMemo(fn) { return fn() },
      useCallback(fn) { return fn },
      useEffect() {},
      useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    }
    let plugin
    const windowObject = {
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: { load: entry => { plugin = entry.factory(() => fakeReact) } },
    }
    const evaluate = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', client + '\n//# sourceURL=client.js')
    evaluate(windowObject, undefined, console, setTimeout, clearTimeout)
    const stats = {
      scope: 'viewer',
      total: 35,
      unread: 7,
      sent: 11,
      groups: 17,
      workspaces: 19,
      delivered: 20,
      queued: 1,
      failed: 13,
      mailbox: 1,
      none: 0,
      days: Array.from({ length: 30 }, (_, index) => ({
        date: index === 29 ? '2026-11-15' : '2026-11-' + String(1 + index).padStart(2, '0'),
        sent: index === 29 ? 11 : 0,
        received: index === 29 ? 24 : 0,
        delivered: index === 29 ? 20 : 0,
        queued: index === 29 ? 1 : 0,
        failed: index === 29 ? 13 : 0,
        mailbox: index === 29 ? 1 : 0,
        none: 0,
      })),
    }
    const kpiClicks = []
    const tree = plugin.__test.DashboardView({
      t: (zh, en) => en,
      data: { viewer: { workspaceTitle: 'Test workspace' } },
      stats,
      messages: [],
      groups: [],
      workspaces: [],
      now: Date.now(),
      retryingId: '',
      onRefresh() { kpiClicks.push('refresh') },
      onNew() {},
      onViewAll() {},
      onUnread() { kpiClicks.push('unread') },
      onGroups() { kpiClicks.push('groups') },
      onWorkspaces() { kpiClicks.push('workspaces') },
      onGroup() {},
      onOpen() {},
      onRetry() {},
    })
    assert.ok(tree && typeof tree === 'object')
    const clickable = []
    const collect = node => {
      if (!node) return
      if (Array.isArray(node)) { node.forEach(collect); return }
      if (typeof node !== 'object' || !node.props) return
      if (typeof node.props.onClick === 'function' && String(node.props.className || '').includes('dshcw-dash-kpi-click')) clickable.push(node)
      collect(node.props.children)
    }
    collect(tree)
    assert.equal(clickable.length, 3)
    clickable.forEach(node => node.props.onClick())
    assert.deepEqual(kpiClicks.sort(), ['groups', 'unread', 'workspaces'])
    const values = []
    const walk = node => {
      if (node === null || node === undefined) return
      if (typeof node === 'string' || typeof node === 'number') { values.push(String(node)); return }
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node.props) walk(node.props.children)
    }
    walk(tree)
    for (const expected of ['7', '11', '13', '17', '19', '57%']) {
      assert.ok(values.includes(expected), 'missing KPI value ' + expected + ' in ' + JSON.stringify(values.slice(0, 40)))
    }
  })

  it('wires workspace page group rows and buttons to real callbacks', () => {
    const fakeReact = {
      createElement(type, props, ...children) { return { type, props: Object.assign({}, props || {}, { children }) } },
      useState(init) { return [typeof init === 'function' ? init() : init, function () {}] },
      useRef(init) { return { current: init } },
      useMemo(fn) { return fn() },
      useCallback(fn) { return fn },
      useEffect() {},
      useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    }
    let plugin
    const windowObject = {
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: { load: entry => { plugin = entry.factory(() => fakeReact) } },
    }
    const evaluate = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', client + '\n//# sourceURL=client.js')
    evaluate(windowObject, undefined, console, setTimeout, clearTimeout)
    const calls = []
    const group = { id: 'g1', name: 'Group one', memberCount: 2, unread: 1 }
    const workspace = { path: 'D:\\ws', title: 'Workspace', unread: 1, sessions: [{ sessionId: 's1', title: 'Session one', running: false, updatedAt: 0 }] }
    const tree = plugin.__test.WorkspaceColumn({
      t: (zh, en) => en,
      workspaces: [workspace],
      groups: [group],
      unreadTotal: 2,
      expanded: { 'D:\\ws': true },
      workspacePathFilter: null,
      groupIdFilter: null,
      selectedSessionId: null,
      now: Date.now(),
      hasData: true,
      loading: false,
      error: '',
      onToggle() {},
      onSelectAll() { calls.push('all') },
      onSelectWorkspace(value) { calls.push('ws:' + value.path) },
      onSelectSession(value, session) { calls.push('session:' + session.sessionId) },
      onSelectGroup(value) { calls.push('select:' + value.id) },
      onEditGroup(value) { calls.push('edit:' + value.id) },
      onCreateGroup() { calls.push('create') },
      onRetry() {},
    })
    const nodes = []
    const walk = node => {
      if (!node) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (typeof node !== 'object' || !node.props) return
      nodes.push(node)
      walk(node.props.children)
    }
    walk(tree)
    const byText = text => nodes.find(node => node.props && typeof node.props.onClick === 'function' && JSON.stringify(node.props.children || '').includes(text))
    byText('All workspaces').props.onClick()
    byText('Workspace').props.onClick()
    byText('Session one').props.onClick()
    const newButton = byText('New')
    assert.ok(newButton)
    newButton.props.onClick()
    const groupButton = byText('Group one')
    assert.ok(groupButton)
    groupButton.props.onClick()
    const editButton = nodes.find(node => node.props && typeof node.props.onClick === 'function' && String(node.props.label || '').includes('Edit group'))
    assert.ok(editButton)
    editButton.props.onClick()
    assert.deepEqual(calls, ['all', 'ws:D:\\ws', 'session:s1', 'create', 'select:g1', 'edit:g1'])

    const groupCalls = []
    const groupTree = plugin.__test.GroupDirectory({
      t: (zh, en) => en,
      groups: [group],
      onCreate() { groupCalls.push('create') },
      onSelect(value) { groupCalls.push('select:' + value.id) },
      onEdit(value) { groupCalls.push('edit:' + value.id) },
    })
    const groupNodes = []
    const walkGroup = node => {
      if (!node) return
      if (Array.isArray(node)) { node.forEach(walkGroup); return }
      if (typeof node !== 'object' || !node.props) return
      groupNodes.push(node)
      walkGroup(node.props.children)
    }
    walkGroup(groupTree)
    const groupByText = text => groupNodes.find(node => node.props && typeof node.props.onClick === 'function' && JSON.stringify(node.props.children || '').includes(text))
    groupByText('New group').props.onClick()
    groupByText('Group one').props.onClick()
    groupByText('Edit').props.onClick()
    assert.deepEqual(groupCalls, ['create', 'select:g1', 'edit:g1'])

    assert.doesNotMatch(client, /on[A-Z][A-Za-z]+: function \(\) \{\s*\}/)
    assert.match(client, /onSelectGroup: function \(group\)/)
    assert.match(client, /onEditGroup: function \(group\)/)
    assert.match(client, /onCreateGroup: function \(\)/)
    assert.match(client, /设置入口在 Harness 设置页/)
    assert.match(client, /onOpen: function \(mail\)/)
    assert.match(client, /refreshWithNotice/)
    assert.match(client, /条结果/)
  })

  it('keeps the U4 menu order and secondary pages', () => {
    const menuStart = client.indexOf("label: t('已发送', 'Sent')")
    const menuEnd = client.indexOf("label: t('设置', 'Settings')")
    assert.ok(menuStart >= 0 && menuEnd > menuStart)
    const menu = client.slice(menuStart, menuEnd)
    const order = ["t('已发送', 'Sent')", "t('群组…', 'Groups…')", "t('工作区', 'Workspaces')", "t('交流图', 'Graph')", "t('全部已读', 'Mark all read')", "t('刷新', 'Refresh')"]
    const positions = order.map(token => menu.indexOf(token))
    assert.ok(positions.every(position => position >= 0), JSON.stringify(positions))
    assert.deepEqual(positions, positions.slice().sort((left, right) => left - right))
    assert.match(client, /function openSecondary\(/)
    assert.match(client, /function closeSecondary\(/)
    assert.match(client, /secondary === 'workspaces'/)
    assert.match(client, /secondary === 'groups'/)
  })

  it('hides the top action on narrow screens and shows a safe-area FAB', () => {
    assert.match(client, /!narrow \? h\(Button/)
    assert.match(client, /narrow && !compose/)
    assert.match(client, /safe-area-inset-bottom/)
    assert.match(client, /width: 48/)

    const dark = client.match(/@media \(prefers-color-scheme:dark\)\{\.dshcw-dash\{([^}]*)\}\}/)
    assert.ok(dark, 'dark dashboard token block missing')
    const expected = {
      '--dshcw-status-delivered': '#4ADE80',
      '--dshcw-status-queued': '#FBBF24',
      '--dshcw-status-failed': '#F87171',
      '--dshcw-status-mailbox': '#9CA3AF',
      '--dshcw-status-none': '#9CA3AF',
    }
    for (const [name, value] of Object.entries(expected)) {
      assert.match(dark[1], new RegExp(name + ':' + value))
      const ratio = contrastRatio(value, '#111827')
      assert.ok(ratio >= 4.5, name + ' contrast ' + ratio.toFixed(2) + ' < 4.5')
    }
  })

  it('clear-read is described as fully-read-only', () => {
    assert.match(client, /仅删除全员已读/)
    assert.match(client, /Delete fully read/)
    assert.doesNotMatch(client, /t\('删除已读', 'Delete read'\)/)
  })

  it('renders failed delivery and a bounded retry action', () => {
    assert.match(client, /mode === 'failed'/)
    assert.match(client, /canRetryDelivery/)
    assert.match(client, /重试中/)
    assert.match(client, /MAX_DELIVERY_ATTEMPTS/)
  })
})
