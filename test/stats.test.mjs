import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeStats, STATS_DAY_WINDOW, sumStatsDays } from '../lib/stats.js'

const NOW = Date.UTC(2026, 10, 15, 4, 0, 0) // 2026-11-15 12:00 Asia/Shanghai
const DAY = 24 * 60 * 60 * 1000

function mail(id, overrides = {}) {
  return {
    id,
    from: { sessionId: 's-other' },
    createdAt: NOW - 60 * 60 * 1000,
    readBy: [],
    delivery: { mode: 'mailbox' },
    ...overrides,
  }
}

function counts(stats) {
  return [stats.delivered, stats.queued, stats.failed, stats.mailbox, stats.none]
}

describe('v4 stats aggregation', () => {
  it('dedupes sent ∪ visible received and keeps five modes + none = total', () => {
    const m1 = mail('m1', { delivery: { mode: 'wake' }, createdAt: Date.UTC(2026, 10, 14, 18, 0, 0) }) // 11-15 02:00 SH
    const m2 = mail('m2', { delivery: { mode: 'queued' }, readBy: ['s:s-me'] })
    const m3 = mail('m3', { delivery: { mode: 'mailbox' } })
    const m4 = mail('m4', { delivery: { mode: 'failed' } })
    const m5 = mail('m5', { to: { workspacePath: 'D:\\ws' }, delivery: { mode: 'none' } })
    const sentDirect = mail('m6', { from: { sessionId: 's-me' }, delivery: { mode: 'wake' } })
    const sentGroupAlsoVisible = mail('m7', {
      from: { sessionId: 's-me' },
      to: { groupId: 'g1', memberSessionIds: ['s-me', 's-other'] },
      delivery: { mode: 'wake' },
    })
    const old = mail('m8', { delivery: { mode: 'wake' }, createdAt: NOW - 20 * DAY })

    const visibleMessages = [m1, m2, m3, m4, m5, sentGroupAlsoVisible, old]
    const allMessages = [...visibleMessages, sentDirect]
    const stats = computeStats({
      visibleMessages,
      allMessages,
      viewerSessionId: 's-me',
      viewerKey: 's:s-me',
      now: NOW,
      groups: 3,
      workspaces: 2,
    })

    assert.equal(stats.scope, 'viewer')
    assert.equal(stats.total, 8)
    assert.equal(stats.sent, 2)
    assert.equal(stats.unread, 5)
    assert.equal(stats.groups, 3)
    assert.equal(stats.workspaces, 2)
    assert.deepEqual(counts(stats), [4, 1, 1, 1, 1])
    assert.equal(counts(stats).reduce((sum, value) => sum + value, 0), stats.total)

    assert.equal(stats.days.length, STATS_DAY_WINDOW)
    assert.equal(stats.days[stats.days.length - 1].date, '2026-11-15')
    assert.equal(stats.days[stats.days.length - 1].sent, 2)
    assert.equal(stats.days[stats.days.length - 1].received, 5)
    assert.equal(stats.days[stats.days.length - 1].none, 1)
    const dayTotal = stats.days.reduce((sum, day) => sum + day.sent + day.received, 0)
    assert.equal(dayTotal, 8) // old 20-day message is inside the 30-day window
    assert.equal(sumStatsDays(stats.days, 7).total, 7)
    assert.equal(sumStatsDays(stats.days, 30).total, 8)
  })

  it('includes 29 days and excludes 31 days from the 30-day window', () => {
    const inside = mail('inside', { delivery: { mode: 'mailbox' }, createdAt: NOW - 29 * DAY })
    const outside = mail('outside', { delivery: { mode: 'mailbox' }, createdAt: NOW - 31 * DAY })
    const stats = computeStats({
      visibleMessages: [inside, outside],
      allMessages: [inside, outside],
      viewerSessionId: 's-me',
      viewerKey: 's:s-me',
      now: NOW,
    })
    assert.equal(stats.total, 2)
    assert.equal(stats.days.length, 30)
    assert.equal(stats.days.reduce((sum, day) => sum + day.sent + day.received, 0), 1)
    assert.equal(sumStatsDays(stats.days, 30).total, 1)
  })

  it('returns all zero without a viewer session', () => {
    const stats = computeStats({
      visibleMessages: [mail('m1')],
      allMessages: [mail('m1')],
      viewerSessionId: undefined,
      viewerKey: undefined,
      now: NOW,
      groups: 9,
      workspaces: 9,
    })
    assert.equal(stats.total, 0)
    assert.equal(stats.sent, 0)
    assert.equal(stats.unread, 0)
    assert.equal(stats.groups, 0)
    assert.equal(stats.workspaces, 0)
    assert.equal(counts(stats).reduce((sum, value) => sum + value, 0), 0)
    assert.equal(stats.days.length, STATS_DAY_WINDOW)
  })

  it('uses the Asia/Shanghai calendar day for the 30-day window', () => {
    const lateSh = mail('late-sh', {
      delivery: { mode: 'mailbox' },
      createdAt: Date.UTC(2026, 10, 14, 15, 59, 0), // 23:59 on 11-14 Shanghai
    })
    const earlySh = mail('early-sh', {
      delivery: { mode: 'mailbox' },
      createdAt: Date.UTC(2026, 10, 14, 16, 1, 0), // 00:01 on 11-15 Shanghai
    })
    const stats = computeStats({
      visibleMessages: [lateSh, earlySh],
      allMessages: [lateSh, earlySh],
      viewerSessionId: 's-me',
      viewerKey: 's:s-me',
      now: NOW,
    })
    const days = new Map(stats.days.map(day => [day.date, day]))
    assert.equal(days.get('2026-11-14').received, 1)
    assert.equal(days.get('2026-11-15').received, 1)
  })
})
