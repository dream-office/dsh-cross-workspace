/**
 * All-time (within the local retained store) stats for the v4 dashboard.
 *
 * Pure function: the Host supplies the viewer-visible messages and the full
 * retained store; no I/O, no React, no network. `total` is the union of
 * messages sent by the viewer and messages visible to the viewer as a
 * recipient, so a group message the viewer sent is counted once even if it is
 * also visible through another path.
 */

export const STATS_DAY_WINDOW = 7
export const STATS_TIME_ZONE = 'Asia/Shanghai'
export const STATS_MODES = Object.freeze(['delivered', 'queued', 'failed', 'mailbox', 'none'])

function modeOf(message) {
  const mode = message && message.delivery && message.delivery.mode
  if (mode === 'wake') return 'delivered'
  return STATS_MODES.indexOf(mode) >= 0 ? mode : 'none'
}

function dayKey(timestamp, formatter) {
  try {
    const text = formatter.format(new Date(timestamp))
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
  } catch {
    return ''
  }
}

function emptyCounts() {
  return { sent: 0, received: 0, delivered: 0, queued: 0, failed: 0, mailbox: 0, none: 0 }
}

function emptyDay(date) {
  return Object.assign({ date }, emptyCounts())
}

function lastSevenDayKeys(now, formatter) {
  const today = dayKey(now, formatter)
  if (!today) return []
  const parts = today.split('-').map(Number)
  const base = Date.UTC(parts[0], parts[1] - 1, parts[2])
  const keys = []
  for (let offset = STATS_DAY_WINDOW - 1; offset >= 0; offset -= 1) {
    keys.push(new Date(base - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
  }
  return keys
}

/**
 * @param {object} input
 * @param {Array} input.visibleMessages viewer-visible messages (inbox semantics)
 * @param {Array} input.allMessages every retained message
 * @param {string|undefined} input.viewerSessionId
 * @param {string|undefined} input.viewerKey
 * @param {number} [input.now]
 * @param {number} [input.groups]
 * @param {number} [input.workspaces]
 * @param {string} [input.timeZone]
 */
export function computeStats({
  visibleMessages = [],
  allMessages = [],
  viewerSessionId,
  viewerKey,
  now = Date.now(),
  groups = 0,
  workspaces = 0,
  timeZone = STATS_TIME_ZONE,
} = {}) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const days = lastSevenDayKeys(now, formatter).map(emptyDay)
  const dayByDate = new Map(days.map(day => [day.date, day]))

  if (typeof viewerSessionId !== 'string' || viewerSessionId.length === 0) {
    return {
      scope: 'viewer',
      total: 0,
      unread: 0,
      sent: 0,
      groups: 0,
      workspaces: 0,
      delivered: 0,
      queued: 0,
      failed: 0,
      mailbox: 0,
      none: 0,
      days,
    }
  }

  const union = new Map()
  const received = []
  for (const message of Array.isArray(allMessages) ? allMessages : []) {
    if (!message || typeof message.id !== 'string') continue
    if (message.from && message.from.sessionId === viewerSessionId) union.set(message.id, message)
  }
  for (const message of Array.isArray(visibleMessages) ? visibleMessages : []) {
    if (!message || typeof message.id !== 'string') continue
    if (message.from && message.from.sessionId === viewerSessionId) continue
    if (!union.has(message.id)) {
      union.set(message.id, message)
      received.push(message)
    }
  }

  const counts = emptyCounts()
  let unread = 0
  let sent = 0
  for (const message of union.values()) {
    const isSent = !!(message.from && message.from.sessionId === viewerSessionId)
    const mode = modeOf(message)
    if (isSent) sent += 1
    counts[mode] += 1
    if (!isSent && Array.isArray(message.readBy) && !message.readBy.includes(viewerKey)) unread += 1
    const key = dayKey(Number(message.createdAt) || 0, formatter)
    const day = dayByDate.get(key)
    if (day) {
      day[mode] += 1
      if (isSent) day.sent += 1
      else day.received += 1
    }
  }

  return {
    scope: 'viewer',
    total: union.size,
    unread,
    sent,
    groups: Number.isFinite(groups) && groups > 0 ? groups : 0,
    workspaces: Number.isFinite(workspaces) && workspaces > 0 ? workspaces : 0,
    delivered: counts.delivered,
    queued: counts.queued,
    failed: counts.failed,
    mailbox: counts.mailbox,
    none: counts.none,
    days,
  }
}
