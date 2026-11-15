import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const source = await readFile(new URL('../client.v1.js', import.meta.url), 'utf8')

function load(initialData, initialView, initialParams) {
  const hooks = []
  let cursor = 0
  let tree = null
  let props = null
  const render = () => {
    cursor = 0
    tree = plugin.__test.App(props)
    return tree
  }
  const fakeReact = {
    createElement(type, config, ...children) { return { type, props: Object.assign({}, config || {}, { children }) } },
    useState(init) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof init === 'function' ? init() : init
      return [hooks[index], function (next) {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
        render()
      }]
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
    localStorage: { getItem() { return null }, setItem() {} },
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: { load: entry => { plugin = entry.factory(() => fakeReact) } },
  }
  const evaluate = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', source + '\n//# sourceURL=client.v1.js')
  evaluate(windowObject, { hidden: false, addEventListener() {}, removeEventListener() {} }, console, setTimeout, clearTimeout)
  props = {
    ctx: { locale: null, get: () => undefined },
    runtime: { controllers: new Set() },
    initialData,
    initialView,
    initialParams,
  }
  render()
  return {
    plugin,
    get tree() { return tree },
    render,
    props,
    direct(component, componentProps) {
      hooks.length = 0
      cursor = 0
      return component(componentProps)
    },
  }
}

function nodesOf(node) {
  const out = []
  const walk = current => {
    if (!current) return
    if (Array.isArray(current)) { current.forEach(walk); return }
    if (typeof current !== 'object' || !current.props) return
    out.push(current)
    walk(current.props.children)
  }
  walk(node)
  return out
}

function clickableByText(node, text) {
  return nodesOf(node).find(item => item.props && typeof item.props.onClick === 'function' && JSON.stringify(item.props.children || '').includes(text))
}

function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach(item => texts(item, out)); return out }
  if (node.props) texts(node.props.children, out)
  return out
}

const now = Date.now()
const data = {
  settings: { allowWake: true },
  viewer: { key: 's:s-me', sessionId: 's-me' },
  workspaces: [{ path: 'D:\\ws', title: 'Workspace', unread: 1, sessions: [{ sessionId: 's-me', title: 'Me', running: false, updatedAt: now, unread: 1 }] }],
  groups: [{ id: 'g1', name: 'Group', memberCount: 2, unread: 1, members: [{ sessionId: 's-me' }, { sessionId: 's-other' }] }],
  orphans: [],
  messages: [
    { id: 'm1', threadId: 't1', createdAt: now - 1000, read: false, subject: 'Unread', body: 'body', from: { sessionId: 's-other', sessionTitle: 'Other' }, to: { sessionId: 's-me' }, files: [], tags: [], delivery: { mode: 'mailbox' } },
    { id: 'm2', threadId: 't2', createdAt: now - 2000, read: true, subject: 'Read', body: 'body2', from: { sessionId: 's-other', sessionTitle: 'Other' }, to: { sessionId: 's-me' }, files: [], tags: [], delivery: { mode: 'failed', attempts: 1 } },
  ],
  stats: {
    scope: 'viewer', total: 2, unread: 1, sent: 0, groups: 1, workspaces: 1,
    delivered: 1, queued: 0, failed: 1, mailbox: 0, none: 0,
    days: Array.from({ length: 30 }, (_, index) => ({
      date: '2026-11-' + String(1 + index).padStart(2, '0'), sent: 0, received: index === 29 ? 2 : 0,
      delivered: index === 29 ? 1 : 0, queued: 0, failed: index === 29 ? 1 : 0, mailbox: 0, none: 0,
    })),
  },
  unreadTotal: 1, returned: 2, total: 2, now,
}

describe('v1 rewrite client skeleton', () => {
  it('renders dashboard with build stamp and KPI values', () => {
    const { tree, plugin } = load(data, 'dashboard')
    const stamp = texts(tree).find(value => value.indexOf('1.0.0-rewrite ') === 0)
    assert.ok(stamp, 'build stamp missing')
    assert.equal(stamp, plugin.__test.BUILD_STAMP)
    const dashboard = plugin.__test.DashboardView({
      t: (zh, en) => en,
      stats: data.stats,
      messages: data.messages,
      groups: data.groups,
      workspaces: data.workspaces,
      range: 7,
      rows: 6,
      now: data.now,
      search: '',
      onUnread() {},
      onGroups() {},
      onWorkspaces() {},
      onGroup() {},
      onAllMessages() {},
      onMoreRows() {},
      onOpen() {},
      onRetry() {},
      onNew() {},
    })
    const values = texts(dashboard)
    const nodes = []
    const walk = node => {
      if (!node) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (typeof node !== 'object' || !node.props) return
      nodes.push(node)
      walk(node.props.children)
    }
    walk(dashboard)
    const kpis = nodes.filter(node => node.props && typeof node.props.label === 'string' && 'value' in node.props)
    assert.ok(kpis.some(kpi => kpi.props.label === 'Failed / retry' && kpi.props.value === 1))
    assert.ok(values.includes('1'), 'unread KPI value missing')
  })

  it('navigates every top-level view with one view state', () => {
    for (const view of ['messages', 'groups', 'workspaces', 'graph', 'settings', 'detail', 'compose', 'groupEditor']) {
      const { tree } = load(data, view, view === 'detail' ? { messageId: 'm1' } : {})
      assert.ok(tree && typeof tree === 'object', view + ' did not render')
    }
  })

  it('wires dashboard KPI and table buttons', () => {
    const env = load(data, 'dashboard')
    const calls = []
    const dashboard = env.direct(env.plugin.__test.DashboardView, {
      t: (zh, en) => en, stats: data.stats, messages: data.messages, groups: data.groups, workspaces: data.workspaces,
      range: 7, rows: 6, now: data.now, search: '',
      onUnread() { calls.push('unread') }, onGroups() { calls.push('groups') }, onWorkspaces() { calls.push('workspaces') },
      onGroup() {}, onAllMessages() { calls.push('all') }, onMoreRows() { calls.push('more') },
      onOpen(mail) { calls.push('open:' + mail.id) }, onRetry() {}, onNew() {},
    })
    nodesOf(dashboard).filter(node => node.props && typeof node.props.onClick === 'function' && typeof node.props.label === 'string').forEach(node => node.props.onClick())
    clickableByText(dashboard, 'All messages').props.onClick()
    nodesOf(dashboard).find(node => node.props && node.props.className === 'cw-subject' && JSON.stringify(node.props.children).includes('Unread')).props.onClick()
    assert.deepEqual(calls.sort(), ['all', 'groups', 'open:m1', 'unread', 'workspaces'])
  })

  it('wires messages and detail buttons', () => {
    const env = load(data, 'messages')
    const calls = []
    const messages = env.direct(env.plugin.__test.MessagesView, {
      t: (zh, en) => en, messages: data.messages, search: '', filter: 'unread', now: data.now,
      onOpen(mail) { calls.push('open:' + mail.id) }, onBack() { calls.push('back') },
    })
    const rows = nodesOf(messages).filter(node => node.props && node.props.className && String(node.props.className).includes('cw-row'))
    assert.equal(rows.length, 1)
    rows[0].props.onClick()
    clickableByText(messages, 'Dashboard').props.onClick()
    assert.deepEqual(calls, ['open:m1', 'back'])

    const detailCalls = []
    const detail = env.direct(env.plugin.__test.DetailView, {
      t: (zh, en) => en, mail: data.messages[1],
      onBack() { detailCalls.push('back') }, onReply() { detailCalls.push('reply') },
      onMark() { detailCalls.push('mark') }, onRetry() { detailCalls.push('retry') },
    })
    clickableByText(detail, 'Reply').props.onClick()
    clickableByText(detail, 'Mark unread').props.onClick()
    clickableByText(detail, 'Retry').props.onClick()
    assert.deepEqual(detailCalls, ['reply', 'mark', 'retry'])
  })

  it('wires groups and workspaces page buttons', () => {
    const env = load(data, 'groups')
    const calls = []
    const groups = env.direct(env.plugin.__test.GroupsView, {
      t: (zh, en) => en, groups: data.groups,
      onBack() { calls.push('back') }, onCreate() { calls.push('create') },
      onOpen(group) { calls.push('open:' + group.id) }, onEdit(group) { calls.push('edit:' + group.id) },
    })
    clickableByText(groups, 'New group').props.onClick()
    clickableByText(groups, 'Group').props.onClick()
    clickableByText(groups, 'Edit').props.onClick()
    clickableByText(groups, 'Dashboard').props.onClick()
    assert.deepEqual(calls, ['create', 'open:g1', 'edit:g1', 'back'])

    const workspaceCalls = []
    const workspaces = env.direct(env.plugin.__test.WorkspacesView, {
      t: (zh, en) => en, workspaces: data.workspaces,
      onBack() { workspaceCalls.push('back') },
      onWorkspace(workspace) { workspaceCalls.push('ws:' + workspace.path) },
      onSession(workspace, session) { workspaceCalls.push('session:' + session.sessionId) },
    })
    clickableByText(workspaces, 'Workspace').props.onClick()
    clickableByText(workspaces, 'Me').props.onClick()
    assert.deepEqual(workspaceCalls, ['ws:D:\\ws', 'session:s-me'])
  })

  it('wires graph and settings page buttons', () => {
    const env = load(data, 'graph')
    const calls = []
    const graph = env.direct(env.plugin.__test.GraphView, {
      t: (zh, en) => en, messages: data.messages,
      onBack() { calls.push('back') }, onOpen(mail) { calls.push('open:' + mail.id) },
    })
    clickableByText(graph, 'Other').props.onClick()
    clickableByText(graph, 'Me').props.onClick()
    assert.deepEqual(calls, ['open:m1', 'back'])

    const settingsCalls = []
    const settings = env.direct(env.plugin.__test.SettingsView, {
      t: (zh, en) => en,
      onBack() { settingsCalls.push('back') }, onOpen() { settingsCalls.push('open') },
    })
    clickableByText(settings, 'Open settings').props.onClick()
    clickableByText(settings, 'Dashboard').props.onClick()
    assert.deepEqual(settingsCalls, ['open', 'back'])
  })

  it('wires topbar new/theme/menu handlers', () => {
    const env = load(data, 'dashboard')
    const themeButton = nodesOf(env.tree).find(node => node.props && node.props['aria-label'] === 'Toggle theme')
    assert.ok(themeButton)
    themeButton.props.onClick()
    assert.ok(texts(env.tree).includes('☀') || texts(env.tree).includes('☾'))
    clickableByText(env.tree, 'New message').props.onClick()
    assert.ok(texts(env.tree).some(value => value.indexOf('view=compose') >= 0))
    const menuButton = nodesOf(env.tree).find(node => node.props && node.props['aria-label'] === 'More')
    if (menuButton) {
      menuButton.props.onClick()
      assert.ok(nodesOf(env.tree).some(node => node.props && node.props.role === 'menu'))
    }
  })

  it('builds compose and group-editor payloads from real button handlers', () => {
    const env = load(data, 'compose')
    const payloads = []
    const compose = env.direct(env.plugin.__test.ComposeView, {
      t: (zh, en) => en,
      groups: data.groups,
      workspaces: data.workspaces,
      replyTo: data.messages[0],
      mySessionId: 's-me',
      onSend(payload) { payloads.push(payload); return Promise.resolve({}) },
      onCancel() {},
      onSent() {},
    })
    clickableByText(compose, 'Send').props.onClick()
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].fromSessionId, 's-me')
    assert.equal(payloads[0].replyTo, 'm1')
    assert.equal(payloads[0].toSessionId, 's-other')
    assert.equal(payloads[0].to, 'Other')

    const groupPayloads = []
    const groupReply = env.direct(env.plugin.__test.ComposeView, {
      t: (zh, en) => en,
      groups: data.groups,
      workspaces: data.workspaces,
      replyTo: {
        id: 'gm1',
        subject: 'Group message',
        from: { sessionId: 's-other' },
        to: { groupId: 'g1', groupName: 'Group' },
      },
      mySessionId: 's-me',
      onSend(payload) { groupPayloads.push(payload); return Promise.resolve({}) },
      onCancel() {},
      onSent() {},
    })
    clickableByText(groupReply, 'Send').props.onClick()
    assert.equal(groupPayloads.length, 1)
    assert.equal(groupPayloads[0].groupId, 'g1')
    assert.equal(groupPayloads[0].to, 'group:Group')
    assert.equal(groupPayloads[0].toSessionId, undefined)

    const saves = []
    const editor = env.direct(env.plugin.__test.GroupEditorView, {
      t: (zh, en) => en,
      group: { id: 'g1', name: 'Group', memberSessionIds: ['s-me', 's-other'] },
      workspaces: data.workspaces,
      onCancel() {},
      onSave(action, payload) { saves.push({ action, payload }); return Promise.resolve({}) },
      onSaved() {},
    })
    clickableByText(editor, 'Save').props.onClick()
    assert.equal(saves.length, 1)
    assert.equal(saves[0].action, 'groupUpdate')
    assert.equal(saves[0].payload.id, 'g1')
    assert.equal(saves[0].payload.name, 'Group')
    assert.deepEqual(saves[0].payload.sessionIds, ['s-me', 's-other'])
  })

  it('builds scoped state payloads and uses read-only settings', () => {
    const env = load(data, 'dashboard')
    const scopedGroup = env.plugin.__test.buildStatePayload('s-me', 's-me', null, 'g1', 300)
    assert.equal(scopedGroup.filter, 'all')
    assert.equal(scopedGroup.groupIdFilter, 'g1')
    assert.equal(scopedGroup.sessionId, undefined)
    const scopedWorkspace = env.plugin.__test.buildStatePayload('s-me', 's-me', 'D:\\ws', null, 300)
    assert.equal(scopedWorkspace.filter, 'all')
    assert.equal(scopedWorkspace.workspacePathFilter, 'D:\\ws')
    assert.equal(scopedWorkspace.sessionId, undefined)
    const inbox = env.plugin.__test.buildStatePayload('s-me', 's-me', null, null, 300)
    assert.equal(inbox.filter, 'inbox')
    assert.equal(inbox.sessionId, 's-me')
    const all = env.plugin.__test.buildStatePayload('s-me', 's-me', null, null, 300, true)
    assert.equal(all.filter, 'all')
    assert.equal(all.sessionId, undefined)
    assert.match(source, /call\('state', \{ filter: 'all', limit: 1 \}\)/)
    assert.doesNotMatch(source, /call\('settings', \{\}\)/)
    const signature = env.plugin.__test.stateSignature(data)
    assert.equal(signature, env.plugin.__test.stateSignature(data))
    const changed = Object.assign({}, data, { messages: [Object.assign({}, data.messages[0], { read: true }), data.messages[1]] })
    assert.notEqual(signature, env.plugin.__test.stateSignature(changed))
    assert.match(source, /visibilitychange/)
    assert.match(source, /document\.hasFocus/)
  })

  it('reads settings through the read-only state action', async () => {
    const hooks = []
    let cursor = 0
    let plugin
    const fakeReact = {
      createElement(type, config, ...children) { return { type, props: Object.assign({}, config || {}, { children }) } },
      useState(init) {
        const index = cursor++
        if (!(index in hooks)) hooks[index] = typeof init === 'function' ? init() : init
        return [hooks[index], function (next) { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
      },
      useRef(init) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: init }; return hooks[index] },
      useMemo(fn) { return fn() },
      useCallback(fn) { return fn },
      useEffect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') hooks.push(cleanup) },
      useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    }
    const windowObject = {
      innerWidth: 1280, addEventListener() {}, removeEventListener() {},
      localStorage: { getItem() { return null }, setItem() {} },
      __ModuleLoader__: { load: entry => { plugin = entry.factory(() => fakeReact) } },
    }
    const evaluate = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', source + '\n//# sourceURL=client.v1.js')
    evaluate(windowObject, { hidden: false, addEventListener() {}, removeEventListener() {} }, console, setTimeout, clearTimeout)
    const bodies = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { settings: { allowWake: true } } }) }
    }
    try {
      plugin.__test.SettingsSection({
        ctx: { locale: null, get: () => undefined },
        runtime: { controllers: new Set() },
      })
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].action, 'state')
    assert.equal(bodies[0].filter, 'all')
    assert.equal(bodies[0].limit, 1)
  })

  it('keeps explicit buttons and no empty handlers in source', () => {
    assert.doesNotMatch(source, /onClick:\s*function\s*\(\)\s*\{\s*\}/)
    assert.match(source, /function navigate\(/)
    assert.match(source, /BUILD_STAMP = '1\.0\.0-rewrite [0-9a-f]+'/)
    assert.match(source, /data-theme/)
    assert.match(source, /dshcw-theme/)
    assert.match(source, /prefers-reduced-motion/)
    assert.match(source, /max-width:860px/)
    assert.match(source, /requestAnimationFrame/)
  })
})
