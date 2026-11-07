/**
 * Delivery decisions for the cross-workspace courier.
 *
 * `deliverMessage` never throws: a failed wake is downgraded to a mailbox
 * message and recorded on the message itself. Downgrades exist to stop agent
 * ping-pong from turning into an unbounded wake loop.
 *
 * A single message may target one session, one workspace wake target, or a
 * group (whose member snapshot is stored on the message). Group delivery tries
 * each member independently and records the per-member result.
 */
import { randomUUID } from 'node:crypto'
import { buildWakeText, pickText } from './format.js'

function deliveryLocale(settings) {
  return settings?.promptLocale === 'en' ? 'en' : 'zh'
}

function readService(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    return undefined
  }
  return ctx[name]
}

export class WakeLimiter {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.times = []
    this.lastByTarget = new Map()
  }

  check({ perMinute, minIntervalSeconds, targetSessionId } = {}) {
    const now = this.now()
    this.times = this.times.filter(time => now - time < 60_000)
    if (perMinute > 0 && this.times.length >= perMinute) {
      return { allowed: false, code: 'rate', reason: `每分钟最多唤醒 ${perMinute} 次，本次改为只投信箱。` }
    }
    if (minIntervalSeconds > 0 && typeof targetSessionId === 'string') {
      const last = this.lastByTarget.get(targetSessionId)
      if (last !== undefined && now - last < minIntervalSeconds * 1000) {
        return { allowed: false, code: 'cooldown', reason: `距离上次唤醒目标会话不足 ${minIntervalSeconds} 秒，本次改为只投信箱。` }
      }
    }
    return { allowed: true }
  }

  record(targetSessionId) {
    const now = this.now()
    this.times.push(now)
    if (typeof targetSessionId === 'string') this.lastByTarget.set(targetSessionId, now)
  }
}

async function resolveAgent(ctx, sessionId) {
  const agents = readService(ctx, 'agents')
  let agent
  try {
    agent = agents?.get?.(sessionId)
  } catch {
    agent = undefined
  }
  if (agent !== undefined && agent !== null) return agent
  const controller = readService(ctx, 'sessionController')
  if (typeof controller?.resolveAgent !== 'function') return undefined
  try {
    const result = await controller.resolveAgent(sessionId)
    if (result !== undefined && result !== null && result.error !== undefined) return undefined
    return result?.agent
  } catch {
    return undefined
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function groupMembersOf(message) {
  const ids = Array.isArray(message?.to?.memberSessionIds) ? message.to.memberSessionIds : []
  return [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0 && id !== message?.from?.sessionId))]
}

/**
 * Read the session's last turn number when the runtime exposes it. A followup
 * that is merely queued does not start a turn, so the caller can compare this
 * marker after the wake attempt instead of trusting the call's return value.
 */
function turnMarker(ctx, agent) {
  const agents = readService(ctx, 'agents')
  if (typeof agents?.turnBoundaryOf !== 'function' || agent?.session === undefined) return undefined
  try {
    const boundary = agents.turnBoundaryOf(agent.session)
    return typeof boundary?.lastTurn === 'number' ? boundary.lastTurn : undefined
  } catch {
    return undefined
  }
}

async function followupAgent(agent, message, settings) {
  // Agent.followup() takes a complete UserMessage, not a { content, source }
  // draft: the role is part of the wire protocol and omitting it makes the
  // next provider request invalid ("missing field role").
  const id = randomUUID()
  await agent.followup({
    role: 'user',
    id,
    content: [{ type: 'text', text: buildWakeText(message, settings) }],
    source: { kind: 'user' },
  })
  return id
}

function sessionEvents(agent) {
  const session = agent?.session
  if (session === undefined || session === null) return undefined
  // eventsSnapshot is a cache invalidated by every append and only populated by
  // a full-range snapshotEvents() read. Read through the public method, never
  // trust the cache directly.
  if (typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch {
      // Fall through to the defensive accessors below.
    }
  }
  if (Array.isArray(session.eventsSnapshot)) return session.eventsSnapshot
  if (Array.isArray(session.events)) return session.events
  return undefined
}

/**
 * Whether the specific UserMessage was admitted into the Session log. A turn
 * that starts but ends blocked (for example an archived Session) never admits
 * the message; reporting that as a wake would be a lie.
 */
function messageAdmitted(agent, messageId) {
  const events = sessionEvents(agent)
  if (events === undefined || typeof messageId !== 'string') return undefined
  return events.some(event => event?.type === 'user/message' && event?.data?.id === messageId)
}

/**
 * Wait briefly for the wake to actually admit the message and start a turn.
 * Returns true when observed, false when the message stayed queued/blocked, and
 * undefined when this runtime cannot expose Session events (legacy assumed
 * success so reduced test harnesses stay compatible).
 */
async function waitForTurnStart(ctx, agent, beforeTurn, messageId, timeoutMs = 1600) {
  const eventsObservable = sessionEvents(agent) !== undefined
  if (!eventsObservable && beforeTurn === undefined) return true
  const deadline = Date.now() + timeoutMs
  let sawTurn = false
  while (Date.now() < deadline) {
    const admitted = messageAdmitted(agent, messageId)
    if (admitted === true) return true
    if (beforeTurn !== undefined) {
      const now = turnMarker(ctx, agent)
      if (now !== undefined && now > beforeTurn) sawTurn = true
    }
    if (!eventsObservable && (agent?.status === 'running' || sawTurn)) {
      // No Session event access: fall back to the observable turn/status.
      return true
    }
    await sleep(100)
  }
  return false
}

/**
 * Wait until a running agent becomes idle, bounded by `seconds`.
 * Returns false when the wait is disabled (0) or the bound expires; the caller
 * then queues the message for the next turn instead of claiming a wake.
 */
async function waitForAgentIdle(agent, seconds) {
  if (agent?.status !== 'running') return true
  const secondsValue = Number(seconds)
  if (!Number.isFinite(secondsValue) || secondsValue <= 0) return false
  if (typeof agent.whenIdle !== 'function') return false
  return new Promise((resolve) => {
    let settled = false
    let timer
    const done = (value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => done(false), Math.max(0, secondsValue * 1000))
    Promise.resolve(agent.whenIdle()).then(() => done(true), () => done(false))
  })
}

async function deliverGroup(ctx, store, message, { settings, locale, limiter, delivery, finish }) {
  const members = groupMembersOf(message)
  if (members.length === 0) {
    return finish({
      mode: 'none',
      members: [],
      note: pickText(locale,
        '群组没有除发送方以外的成员；消息已保存，但不会投递。',
        'The group has no members other than the sender; the message is stored but not delivered.'),
    })
  }
  const results = []
  const pending = []
  const deferred = []
  // One shared wait budget for the whole group, so a large group cannot block
  // the tool for members × waitForIdleSeconds.
  const idleDeadline = Date.now() + Math.max(0, Number(settings.waitForIdleSeconds) || 0) * 1000

  async function startMember(sessionId, agent) {
    try {
      const beforeTurn = turnMarker(ctx, agent)
      const messageId = await followupAgent(agent, message, settings)
      limiter.record(sessionId)
      const result = { sessionId, mode: 'wake' }
      results.push(result)
      pending.push({ result, agent, beforeTurn, messageId })
    } catch (error) {
      results.push({ sessionId, mode: 'mailbox', error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Resolve every member first; process idle members immediately, then spend
  // the shared wait budget on running members so they cannot delay idle ones.
  for (const sessionId of members) {
    const verdict = limiter.check({
      perMinute: settings.wakesPerMinute,
      minIntervalSeconds: settings.targetWakeCooldownSeconds,
      targetSessionId: sessionId,
    })
    if (!verdict.allowed) {
      const note = verdict.code === 'rate'
        ? pickText(locale,
          `每分钟最多唤醒 ${settings.wakesPerMinute} 次，本成员改为只投信箱。`,
          `At most ${settings.wakesPerMinute} wakes per minute; this member stays in the mailbox.`)
        : pickText(locale,
          `距离上次唤醒该成员不足 ${settings.targetWakeCooldownSeconds} 秒，本成员改为只投信箱。`,
          `Less than ${settings.targetWakeCooldownSeconds}s since this member was last woken; it stays in the mailbox.`)
      results.push({ sessionId, mode: 'mailbox', note })
      continue
    }
    let agent
    try {
      agent = await resolveAgent(ctx, sessionId)
    } catch (error) {
      results.push({ sessionId, mode: 'mailbox', error: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (agent === undefined || agent === null) {
      results.push({
        sessionId,
        mode: 'mailbox',
        note: pickText(locale, '会话暂时无法恢复为 live Agent。', 'The session cannot be resumed as a live Agent right now.'),
      })
      continue
    }
    if (agent.status === 'running') {
      deferred.push({ sessionId, agent })
      continue
    }
    await startMember(sessionId, agent)
  }

  for (const { sessionId, agent } of deferred) {
    const remainingSeconds = Math.max(0, idleDeadline - Date.now()) / 1000
    const idle = await waitForAgentIdle(agent, remainingSeconds)
    if (!idle) {
      try {
        await followupAgent(agent, message, settings)
        limiter.record(sessionId)
        results.push({
          sessionId,
          mode: 'queued',
          note: pickText(locale,
            '目标正在运行；已排到当前轮结束后的下一轮，尚未确认启动。',
            'The target is running; queued for its next turn after the current one, start not confirmed.'),
        })
      } catch (error) {
        results.push({ sessionId, mode: 'mailbox', error: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    await startMember(sessionId, agent)
  }
  // Do not report a queued message as a live wake: wait until each target
  // either starts a turn or stays idle (queued until someone opens it).
  await Promise.all(pending.map(async ({ result, agent, beforeTurn, messageId }) => {
    const started = await waitForTurnStart(ctx, agent, beforeTurn, messageId)
    if (started === false) {
      result.mode = 'mailbox'
      result.note = pickText(locale,
        '已入队但未观察到会话启动，需打开该会话后才会处理。',
        'Queued but no turn start was observed; the session must be opened to process it.')
    }
  }))
  const woke = results.filter(result => result.mode === 'wake').length
  const queued = results.filter(result => result.mode === 'queued').length
  const mode = woke > 0 ? 'wake' : (queued > 0 ? 'queued' : 'mailbox')
  const note = pickText(locale,
    `群组共 ${members.length} 个可投递成员：已确认唤醒 ${woke} 个，运行中已排队 ${queued} 个；其余留在信箱。`,
    `Group has ${members.length} deliverable member(s): ${woke} confirmed started, ${queued} queued behind a running turn; the rest stay in the mailbox.`)
  return finish({
    mode,
    delivered: woke > 0,
    ...(woke > 0 ? { at: Date.now() } : {}),
    ...(woke > 0 || queued > 0
      ? { targetSessionId: (results.find(result => result.mode === 'wake') ?? results.find(result => result.mode === 'queued'))?.sessionId }
      : {}),
    members: results,
    note,
  })
}

/**
 * Apply one delivery decision and persist it on the message.
 *
 * @param ctx Harness context (Host plugin context).
 * @param store MailStore.
 * @param message Already stored message record.
 * @param options.requested 'wake' | 'mailbox'
 * @param options.target `{ kind: 'session'|'workspace', sessionId? }` or `{ kind: 'group' }`
 * @param options.targetSessionId Legacy single-session target.
 * @param options.limiter WakeLimiter.
 */
export async function deliverMessage(ctx, store, message, {
  requested = 'mailbox',
  target,
  targetSessionId,
  limiter = new WakeLimiter(),
} = {}) {
  const settings = store.getSettings()
  const locale = deliveryLocale(settings)
  const delivery = {
    requested: requested === 'wake' ? 'wake' : 'mailbox',
    mode: 'mailbox',
    delivered: false,
  }
  const finish = async (patch) => {
    Object.assign(delivery, patch)
    try {
      await store.updateMessage(message.id, current => ({ ...current, delivery }))
    } catch {
      // The message itself is already stored; a failed delivery bookkeeping
      // write must not fail the send.
    }
    return { ...delivery }
  }

  const isGroup = target?.kind === 'group' || typeof message.to?.groupId === 'string'
  if (delivery.requested !== 'wake') {
    return finish({
      mode: 'mailbox',
      note: isGroup
        ? pickText(locale,
          `已存入信箱；群组 ${groupMembersOf(message).length} 个成员会在下次运行时看到未读摘要。`,
          `Stored in the mailbox; the ${groupMembersOf(message).length} group member(s) will see it on their next run.`)
        : pickText(locale,
          '已存入信箱；目标会话下次运行时会在系统提示里看到未读摘要。',
          'Stored in the mailbox; the target will see an unread summary on its next run.'),
    })
  }
  if (settings.allowWake !== true) {
    return finish({
      mode: 'mailbox',
      ...(typeof targetSessionId === 'string' ? { targetSessionId } : {}),
      note: pickText(locale, '唤醒投递已在设置中关闭，消息只进信箱。', 'Wake delivery is disabled in settings; the message stays in the mailbox.'),
    })
  }
  if (message.hop > settings.maxHops) {
    return finish({
      mode: 'mailbox',
      ...(typeof targetSessionId === 'string' ? { targetSessionId } : {}),
      note: pickText(locale,
        `回复深度 ${message.hop} 超过上限 ${settings.maxHops}，只进信箱以防止来回唤醒循环。`,
        `Reply depth ${message.hop} exceeds ${settings.maxHops}; kept in the mailbox to prevent wake loops.`),
    })
  }

  if (isGroup) return deliverGroup(ctx, store, message, { settings, locale, limiter, delivery, finish })

  const single = target?.kind === 'session' || target?.kind === 'workspace'
    ? target.sessionId
    : targetSessionId
  if (typeof single !== 'string' || single.length === 0) {
    return finish({
      mode: 'none',
      note: pickText(locale,
        '目标工作区当前没有可唤醒的会话；消息已保存，以后出现的会话也能看到。',
        'The target workspace has no session to wake; the message is stored and later sessions can see it.'),
    })
  }
  const verdict = limiter.check({
    perMinute: settings.wakesPerMinute,
    minIntervalSeconds: settings.targetWakeCooldownSeconds,
    targetSessionId: single,
  })
  if (!verdict.allowed) {
    const note = verdict.code === 'rate'
      ? pickText(locale,
        `每分钟最多唤醒 ${settings.wakesPerMinute} 次，本次改为只投信箱。`,
        `At most ${settings.wakesPerMinute} wakes per minute; this send was downgraded to the mailbox.`)
      : pickText(locale,
        `距离上次唤醒目标会话不足 ${settings.targetWakeCooldownSeconds} 秒，本次改为只投信箱。`,
        `Less than ${settings.targetWakeCooldownSeconds}s since the target was last woken; this send was downgraded to the mailbox.`)
    return finish({ mode: 'mailbox', targetSessionId: single, note })
  }

  let agent
  try {
    agent = await resolveAgent(ctx, single)
  } catch (error) {
    return finish({ mode: 'mailbox', error: error instanceof Error ? error.message : String(error) })
  }
  if (agent === undefined || agent === null) {
    return finish({
      mode: 'mailbox',
      targetSessionId: single,
      note: pickText(locale,
        '目标会话暂时无法恢复为 live Agent；消息留在信箱，恢复后会看到未读摘要。',
        'The target cannot be resumed as a live Agent right now; the message stays in the mailbox.'),
    })
  }
  const shouldWait = agent.status === 'running'
  const idle = shouldWait
    ? await waitForAgentIdle(agent, settings.waitForIdleSeconds)
    : true
  const queued = shouldWait && !idle

  try {
    const beforeTurn = turnMarker(ctx, agent)
    const messageId = await followupAgent(agent, message, settings)
    limiter.record(single)
    if (queued) {
      return finish({
        mode: 'queued',
        targetSessionId: single,
        note: pickText(locale,
          '目标正在运行；已排到当前轮结束后的下一轮，尚未确认启动。',
          'The target is running; queued for its next turn after the current one, start not confirmed.'),
      })
    }
    const started = await waitForTurnStart(ctx, agent, beforeTurn, messageId)
    if (started === false) {
      return finish({
        mode: 'mailbox',
        targetSessionId: single,
        note: pickText(locale,
          '已入队但未观察到会话启动；消息在信箱里，需打开该会话后才会处理。',
          'Queued but no turn start was observed; the message is in the mailbox until the session is opened.'),
      })
    }
    return finish({
      mode: 'wake',
      delivered: true,
      at: Date.now(),
      targetSessionId: single,
    })
  } catch (error) {
    return finish({
      mode: 'mailbox',
      error: error instanceof Error ? error.message : String(error),
      note: pickText(locale, '唤醒失败，消息已存入信箱。', 'Wake failed; the message is stored in the mailbox.'),
    })
  }
}
