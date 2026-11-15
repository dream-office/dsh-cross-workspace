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

  it('keeps the U4 menu order and secondary pages', () => {
    const menuStart = client.indexOf("{ key: 'sent'")
    const menuEnd = client.indexOf("{ key: 'settings'")
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
