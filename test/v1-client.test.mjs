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
  return { plugin, get tree() { return tree }, render, props }
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

  it('keeps explicit buttons and no empty handlers in source', () => {
    assert.doesNotMatch(source, /onClick:\s*function\s*\(\)\s*\{\s*\}/)
    assert.match(source, /function navigate\(/)
    assert.match(source, /BUILD_STAMP = '1\.0\.0-rewrite /)
  })
})
