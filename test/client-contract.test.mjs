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
