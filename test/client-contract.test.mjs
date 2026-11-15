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

  it('compose drawer searches recipients and folds advanced options', () => {
    assert.match(client, /收件人搜索/)
    assert.match(client, /function clearRecipient\(/)
    assert.match(client, /高级选项/)
    assert.match(client, /position: 'fixed'/)
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
