/**
 * Integration tests for the Host half (index.js): the management HTTP route,
 * security fences and the six model-facing tools.
 *
 * A fake Cordis context boots `apply()` against a mkdtemp store. No real
 * Harness service is touched and no production file is modified.
 */
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { apply } from '../index.js'
import { MailStore } from '../lib/store.js'
import { deliverMessage } from '../lib/delivery.js'

const HOST = '127.0.0.1:51999'
const ROUTE_PATH = '/plugins/dsh-cross-workspace/api'
const TOOL_NAMES = ['mail_send', 'mail_inbox', 'mail_read', 'mail_reply', 'mail_wait', 'workspace_list']

let harness

function makeResponse() {
  return {
    status: 0,
    headers: {},
    text: '',
    ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) this.text += String(chunk)
      this.ended = true
    },
  }
}

async function boot(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-xw-route-'))
  const wsAlpha = join(root, 'ws-alpha')
  const wsBeta = join(root, 'ws-beta')
  const wsGamma = join(root, 'ws-gamma')
  await mkdir(wsAlpha)
  await mkdir(wsBeta)
  await mkdir(wsGamma)
  const storeDir = resolve(join(root, 'store'))

  // Optional pre-boot store fixture (used for legacy on-disk records).
  if (typeof options.seedStore === 'function') {
    await mkdir(storeDir, { recursive: true })
    await options.seedStore({ root, storeDir, wsAlpha, wsBeta, wsGamma })
  }

  const followups = []
  const prompts = new Map()
  const disposed = new Set()
  const makeAgent = (id, status) => ({
    id,
    status,
    followup: async (payload) => {
      followups.push({ target: id, payload })
    },
    ctx: {
      systemPrompt: {
        context: (definition) => {
          prompts.set(id, definition)
          return () => { disposed.add(id) }
        },
      },
    },
  })

  const agents = new Map([
    ['s-01', makeAgent('s-01', 'idle')],
    ['s-02', makeAgent('s-02', 'idle')],
    ['s-03', makeAgent('s-03', 'running')],
  ])
  const sessions = new Map([
    ['s-01', { id: 's-01', cwd: wsAlpha }],
    ['s-02', { id: 's-02', cwd: wsBeta }],
    ['s-03', { id: 's-03', cwd: wsBeta }],
  ])
  const summaries = [
    { sessionId: 's-01', cwd: wsAlpha, updatedAt: 100, running: false, blank: false },
    { sessionId: 's-02', cwd: wsBeta, updatedAt: 200, running: false, blank: false },
    { sessionId: 's-03', cwd: wsBeta, updatedAt: 300, running: true, blank: false },
  ]
  const workspaces = [
    { id: 'w-alpha', path: wsAlpha, title: 'Alpha', sessionIds: ['s-01'] },
    { id: 'w-beta', path: wsBeta, title: 'Beta', sessionIds: ['s-02', 's-03'] },
  ]
  const titles = { 's-01': 'Alpha Lead', 's-02': 'Beta Worker', 's-03': 'Beta Runner' }
  const snapshotCalls = []
  const warnings = []
  const agentGetMissing = new Set(options.agentGetMissing ?? [])

  // Wake-verification harness (task-14/15/17). options.turnBoundary exposes
  // agent.session + ctx.agents.turnBoundaryOf({lastTurn}). options.eventsSnapshot
  // (or admitOnFollowup) exposes a fake Session that models the real cache
  // contract: `.eventsSnapshot` is a cache populated only by a full
  // `snapshotEvents()` call and invalidated to undefined on every append.
  //   startOnFollowup        -> followup increments lastTurn (turn/status fallback)
  //   startStatusOnFollowup  -> followup flips agent.status to 'running'
  //   admitOnFollowup        -> followup appends {type:'user/message', data:{id: UserMessage.id}} to the log
  //   blockOnFollowup        -> followup bumps lastTurn but admits no user/message
  const turnState = new Map()
  const startOnFollowup = new Set(
    options.startOnFollowup === 'all'
      ? [] // resolved to every agent below
      : (options.startOnFollowup ?? []),
  )
  const startStatusOnFollowup = new Set(options.startStatusOnFollowup ?? [])
  const admitOnFollowup = new Set(options.admitOnFollowup ?? [])
  const blockOnFollowup = new Set(options.blockOnFollowup ?? [])
  if (options.startOnFollowup === 'all') {
    for (const id of agents.keys()) startOnFollowup.add(id)
  }

  function createObservableSession(id) {
    const log = []
    return {
      id,
      log,
      eventsSnapshot: undefined,
      snapshotCalls: 0,
      // Full-range read: materializes and caches the current log.
      snapshotEvents() {
        this.snapshotCalls += 1
        this.eventsSnapshot = log.map(event => ({
          type: event.type,
          ...(event.data === undefined ? {} : { data: { ...event.data } }),
        }))
        return this.eventsSnapshot
      },
      // Every append invalidates the cache, exactly like the real Session.
      appendEvent(event) {
        log.push(event)
        this.eventsSnapshot = undefined
      },
    }
  }

  for (const extra of options.extraSessions ?? []) {
    const cwd = extra.cwd === 'gamma' ? wsGamma : (extra.cwd ?? wsBeta)
    agents.set(extra.id, makeAgent(extra.id, extra.status ?? 'idle'))
    sessions.set(extra.id, { id: extra.id, cwd })
    summaries.push({
      sessionId: extra.id,
      cwd,
      updatedAt: extra.updatedAt ?? 10,
      running: extra.status === 'running',
      blank: extra.blank === true,
    })
  }
  for (const agent of agents.values()) {
    const observable = options.eventsSnapshot === true || admitOnFollowup.has(agent.id)
    if (observable) {
      agent.session = createObservableSession(agent.id)
    } else if (options.turnBoundary === true) {
      agent.session = { id: agent.id }
    }
    const idleAfterMs = options.whenIdleAfterMs?.[agent.id]
    if (typeof idleAfterMs === 'number') {
      agent.whenIdle = () => new Promise(resolve => setTimeout(resolve, idleAfterMs))
    }
    const bumpsTurn = startOnFollowup.has(agent.id) || blockOnFollowup.has(agent.id)
    const flipsStatus = startStatusOnFollowup.has(agent.id)
    const admits = admitOnFollowup.has(agent.id)
    if (bumpsTurn || flipsStatus || admits) {
      const originalFollowup = agent.followup
      agent.followup = async (payload) => {
        await originalFollowup(payload)
        if (bumpsTurn) turnState.set(agent.id, (turnState.get(agent.id) ?? 0) + 1)
        if (flipsStatus) agent.status = 'running'
        if (admits) {
          agent.session.appendEvent({
            type: 'user/message',
            data: { id: payload?.id },
          })
        }
      }
    }
  }

  const logger = {
    warn: (...args) => warnings.push(args),
    error: (...args) => warnings.push(args),
    info: () => {},
  }

  const services = {
    agents: {
      list: () => [...agents.values()],
      get: id => (agentGetMissing.has(id) ? undefined : agents.get(id)),
      ...(options.turnBoundary === true
        ? { turnBoundaryOf: session => ({ lastTurn: turnState.get(session?.id) ?? 0 }) }
        : {}),
    },
    sessions: { get: id => sessions.get(id) },
    workingDirectory: { get: session => session?.cwd },
    workspaceRegistry: {
      list: () => workspaces,
      archivedSessionIds: options.archivedSessionIds ?? [],
    },
    sessionController: {
      list: async () => ({ items: summaries }),
      resolveAgent: async id => ({ agent: agents.get(id) }),
    },
    sessionQuery: {
      readTitleSnapshots: async (ids) => {
        snapshotCalls.push([...ids])
        return ids.map(id => ({
          sessionId: id,
          status: 'fulfilled',
          value: { title: { title: titles[id] } },
        }))
      },
    },
    ...(options.connection === undefined ? {} : { connection: options.connection }),
  }

  const registered = { routes: [], tools: [], handlers: new Map(), effects: [] }
  const ctx = {
    logger,
    get: name => services[name],
    effect(fn) {
      const result = fn()
      registered.effects.push(result)
      return result
    },
    on(name, handler) {
      registered.handlers.set(name, handler)
    },
    webServer: {
      register: (route) => {
        registered.routes.push(route)
        return () => {}
      },
    },
    tools: {
      register: (definition) => {
        registered.tools.push(definition)
        return () => {}
      },
    },
    agents: services.agents,
    sessions: services.sessions,
    workingDirectory: services.workingDirectory,
    workspaceRegistry: services.workspaceRegistry,
    sessionController: services.sessionController,
  }

  apply(ctx, {
    storeDir,
    settings: Object.assign({ allowWorkspaceBroadcast: true }, options.settings || {}),
  })

  const route = registered.routes[0]
  if (route === undefined) throw new Error('management route was not registered')

  const invoke = async ({ method = 'POST', headers = {}, bodyText = '' } = {}) => {
    const mergedHeaders = {
      host: HOST,
      origin: `http://${HOST}`,
      'content-type': 'application/json',
      'x-dsh-cross-workspace': '1',
      ...headers,
    }
    const req = {
      method,
      headers: mergedHeaders,
      async *[Symbol.asyncIterator]() {
        if (bodyText.length > 0) yield Buffer.from(bodyText)
      },
    }
    const res = makeResponse()
    await route.handler(req, res)
    let body
    try {
      body = res.text.length > 0 ? JSON.parse(res.text) : undefined
    } catch {
      body = undefined
    }
    return { status: res.status, headers: res.headers, body, text: res.text }
  }

  const call = async (action, payload = {}, opts = {}) => {
    const bodyText = opts.bodyText !== undefined ? opts.bodyText : JSON.stringify({ action, ...payload })
    return invoke({ ...opts, bodyText })
  }

  const toolsByName = new Map(registered.tools.map(tool => [tool.name, tool]))

  const h = {
    root,
    wsAlpha,
    wsBeta,
    wsGamma,
    storeDir,
    followups,
    prompts,
    disposed,
    warnings,
    snapshotCalls,
    summaries,
    sessions,
    agents,
    titles,
    workspaces,
    turnState,
    route,
    routes: registered.routes,
    tools: registered.tools,
    toolsByName,
    handlers: registered.handlers,
    effects: registered.effects,
    invoke,
    call,
    async destroy() {
      // Let a scheduled read-state write settle before deleting the directory.
      await new Promise(done => setTimeout(done, 30))
      await rm(root, { recursive: true, force: true })
    },
  }
  return h
}

function assertTextOutput(definition, value) {
  assert.equal(typeof definition.output.render, 'function', `${definition.name} has no output.render`)
  assert.equal(definition.output.schema?.type, 'object')
  const output = definition.output.render({}, value)
  assert.ok(Array.isArray(output), 'render must return an array')
  assert.equal(output.length, 1)
  assert.equal(output[0].type, 'text')
  assert.equal(typeof output[0].text, 'string')
  return output[0]
}

async function executeTool(h, name, args, exec = { agent: { id: 's-01' } }) {
  const definition = h.toolsByName.get(name)
  assert.ok(definition, `tool ${name} not registered`)
  return definition.execute(args, exec)
}

/** Workspace broadcasts are opt-in; tests that exercise them enable the setting. */
async function enableWorkspaceBroadcast(h = harness) {
  const response = await h.call('settings', { patch: { allowWorkspaceBroadcast: true } })
  assert.equal(response.status, 200)
  assert.equal(response.body.value.settings.allowWorkspaceBroadcast, true)
}

function sleep(ms) {
  return new Promise(done => setTimeout(done, ms))
}

/**
 * Tool values must be lossless JSON (docs/API.md §6): no undefined, no
 * non-finite numbers, no functions/symbols/bigints, no non-plain objects or
 * prototypes, and no cycles. Also verifies an exact JSON round-trip.
 */
function assertLosslessJson(value, { path = '$', label = 'value' } = {}) {
  const seen = new Set()
  const visit = (current, at) => {
    if (current === undefined) throw new Error(`undefined value at ${at} (${label})`)
    const type = typeof current
    if (type === 'function' || type === 'symbol' || type === 'bigint') {
      throw new Error(`non-JSON ${type} at ${at} (${label})`)
    }
    if (type === 'number' && !Number.isFinite(current)) {
      throw new Error(`non-finite number at ${at} (${label})`)
    }
    if (current === null || type !== 'object') return
    if (seen.has(current)) throw new Error(`cyclic reference at ${at} (${label})`)
    const prototype = Object.getPrototypeOf(current)
    const expected = Array.isArray(current) ? Array.prototype : Object.prototype
    if (prototype !== expected && prototype !== null) {
      throw new Error(`non-plain prototype at ${at} (${label})`)
    }
    seen.add(current)
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${at}[${index}]`))
    } else {
      for (const [key, item] of Object.entries(current)) visit(item, `${at}.${key}`)
    }
    seen.delete(current)
  }
  visit(value, path)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} does not survive a JSON round-trip`)
}

function assertNoOwnUndefinedKeys(value, label = 'value', path = '$') {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoOwnUndefinedKeys(item, label, `${path}[${index}]`))
    return
  }
  for (const [key, item] of Object.entries(value)) {
    assert.notEqual(item, undefined, `own property ${path}.${key} is undefined (${label})`)
    assertNoOwnUndefinedKeys(item, label, `${path}.${key}`)
  }
}

beforeEach(async () => {
  harness = await boot()
})

afterEach(async () => {
  if (harness !== undefined) {
    const current = harness
    harness = undefined
    await current.destroy()
  }
})

describe('Host boot', () => {
  it('registers the exact management route, six tools and agent lifecycle hooks', () => {
    assert.equal(harness.routes.length, 1)
    assert.equal(harness.route.kind, 'exact')
    assert.equal(harness.route.path, ROUTE_PATH)
    assert.equal(typeof harness.route.handler, 'function')

    assert.equal(harness.tools.length, 6)
    for (const name of TOOL_NAMES) {
      const definition = harness.toolsByName.get(name)
      assert.ok(definition, `missing tool ${name}`)
      assert.equal(typeof definition.execute, 'function')
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(typeof definition.description, 'string')
    }

    assert.equal(typeof harness.handlers.get('agent/created'), 'function')
    assert.equal(typeof harness.handlers.get('agent/disposed'), 'function')
    // The prompt context is installed for every live agent found at boot.
    for (const sessionId of ['s-01', 's-02', 's-03']) {
      assert.ok(harness.prompts.has(sessionId), `prompt context missing for ${sessionId}`)
    }
  })
})

describe('action: state', () => {
  it('returns workspaces, sessions, viewer identity and unread totals', async () => {
    const response = await harness.call('state', { sessionId: 's-01' })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(response.body.ok, true)

    const value = response.body.value
    assert.equal(typeof value.storeDir, 'string')
    assert.equal(value.storeVersion, 2)
    assert.equal(typeof value.now, 'number')
    assert.equal(value.settings.defaultDelivery, 'wake')
    assert.equal(value.unreadTotal, 0)
    assert.deepEqual(value.messages, [])
    assert.deepEqual(value.orphans, [])

    assert.equal(value.viewer.key, 's:s-01')
    assert.equal(value.viewer.sessionId, 's-01')
    assert.equal(value.viewer.workspacePath, harness.wsAlpha)
    assert.equal(value.viewer.workspaceTitle, 'Alpha')
    assert.equal(value.viewer.sessionTitle, 'Alpha Lead')

    assert.equal(value.workspaces.length, 2)
    const alpha = value.workspaces.find(workspace => workspace.path === harness.wsAlpha)
    const beta = value.workspaces.find(workspace => workspace.path === harness.wsBeta)
    assert.equal(alpha.title, 'Alpha')
    assert.equal(alpha.exists, true)
    assert.equal(alpha.unread, 0)
    assert.equal(alpha.sessions.length, 1)
    assert.deepEqual(
      Object.keys(alpha.sessions[0]).sort(),
      ['cwd', 'running', 'sessionId', 'title', 'unread', 'updatedAt'].sort(),
    )
    // `blank` is no longer exposed by state workspace rows.
    assert.equal(Object.hasOwn(alpha.sessions[0], 'blank'), false)
    assert.equal(alpha.sessions[0].sessionId, 's-01')
    assert.equal(alpha.sessions[0].title, 'Alpha Lead')
    assert.equal(alpha.sessions[0].running, false)
    assert.deepEqual(beta.sessions.map(session => session.sessionId), ['s-03', 's-02'])
    assert.equal(beta.sessions.find(session => session.sessionId === 's-03').running, true)
  })

  it('shows a mailbox broadcast to its workspace and hides it elsewhere', async () => {
    await enableWorkspaceBroadcast(harness)
    const sent = await harness.call('send', {
      fromSessionId: 's-02',
      to: 'Alpha',
      subject: 'Sync',
      body: 'hello',
      wake: false,
    })
    assert.equal(sent.status, 200)
    const sentValue = sent.body.value
    assert.match(sentValue.message.id, /^m-/)
    assert.equal(sentValue.message.to.workspacePath, harness.wsAlpha)
    assert.equal(sentValue.message.to.workspaceTitle, 'Alpha')
    assert.equal(sentValue.message.from.sessionId, 's-02')
    assert.equal(sentValue.message.from.workspaceTitle, 'Beta')
    assert.equal(sentValue.message.delivery.requested, 'mailbox')
    assert.equal(sentValue.message.delivery.mode, 'mailbox')
    assert.equal(sentValue.message.delivery.delivered, false)
    assert.equal(sentValue.delivery.mode, 'mailbox')
    assert.equal(sentValue.warnings.length, 1)
    assert.ok(sentValue.warnings[0].includes('广播'))

    const inbox = await harness.call('state', { sessionId: 's-01' })
    const messages = inbox.body.value.messages
    assert.equal(messages.length, 1)
    const message = messages[0]
    assert.equal(message.id, sentValue.message.id)
    assert.equal(message.subject, 'Sync')
    assert.equal(message.body, 'hello')
    assert.equal(message.read, false)
    assert.equal(message.hop, 0)
    assert.ok(Array.isArray(message.files))
    assert.ok(Array.isArray(message.tags))
    assert.equal(message.delivery.mode, 'mailbox')
    assert.equal(inbox.body.value.unreadTotal, 1)

    const alphaRow = inbox.body.value.workspaces.find(workspace => workspace.path === harness.wsAlpha)
    const betaRow = inbox.body.value.workspaces.find(workspace => workspace.path === harness.wsBeta)
    assert.equal(alphaRow.unread, 1)
    assert.equal(betaRow.unread, 0)

    // Management view with filter 'all' lists every stored message.
    const management = await harness.call('state', { filter: 'all' })
    assert.equal(management.body.value.messages.length, 1)

    // The sender's own workspace does not see the Alpha broadcast.
    const senderInbox = await harness.call('state', { sessionId: 's-02' })
    assert.deepEqual(senderInbox.body.value.messages, [])
  })
})

describe('action: send and delivery', () => {
  it('wakes an idle agent and records the followup', async () => {
    // Make the cooldown wide enough that the second send below is guaranteed
    // to hit it without depending on wall-clock timing inside the test.
    await harness.call('settings', { patch: { targetWakeCooldownSeconds: 3600 } })
    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      subject: 'Ping',
      body: 'wake up',
      wake: true,
    })
    assert.equal(response.status, 200)
    const value = response.body.value
    assert.equal(value.warnings.length, 0)
    assert.equal(value.delivery.requested, 'wake')
    assert.equal(value.delivery.mode, 'wake')
    assert.equal(value.delivery.delivered, true)
    assert.equal(value.delivery.targetSessionId, 's-02')
    assert.equal(typeof value.delivery.at, 'number')
    assert.equal(value.message.delivery.mode, 'wake')

    assert.equal(harness.followups.length, 1)
    const followup = harness.followups[0]
    assert.equal(followup.target, 's-02')
    assert.ok(Array.isArray(followup.payload.content))
    assert.equal(followup.payload.content[0].type, 'text')
    assert.ok(followup.payload.content[0].text.includes(value.message.id))
    assert.ok(followup.payload.content[0].text.includes('外部输入'))
    assert.deepEqual(followup.payload.source, { kind: 'user' })

    const targetState = await harness.call('state', { sessionId: 's-02' })
    assert.equal(targetState.body.value.messages.length, 1)
    assert.equal(targetState.body.value.messages[0].read, false)
    assert.equal(targetState.body.value.unreadTotal, 1)

    // Cooldown: a second wake to the same session right away is downgraded.
    const second = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      subject: 'Again',
      body: 'again',
      wake: true,
    })
    assert.equal(second.body.value.delivery.requested, 'wake')
    assert.equal(second.body.value.delivery.mode, 'mailbox')
    assert.equal(second.body.value.delivery.delivered, false)
    assert.equal(second.body.value.delivery.targetSessionId, 's-02')
    assert.match(second.body.value.delivery.note, /不足/)
    assert.equal(harness.followups.length, 1)
  })

  it('queues a wake to a running agent instead of claiming delivery', async () => {
    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-03',
      subject: 'Busy',
      body: 'do not disturb',
      wake: true,
    })
    assert.equal(response.status, 200)
    const value = response.body.value
    assert.equal(value.delivery.requested, 'wake')
    assert.equal(value.delivery.mode, 'queued')
    assert.equal(value.delivery.delivered, false)
    assert.equal(value.delivery.targetSessionId, 's-03')
    assert.match(value.delivery.note, /正在运行/)
    assert.match(value.delivery.note, /已排到当前轮结束后的下一轮/)
    // The queued followup was still enqueued for the next turn.
    assert.equal(harness.followups.length, 1)
    assert.equal(harness.followups[0].target, 's-03')

    const targetState = await harness.call('state', { sessionId: 's-03' })
    assert.equal(targetState.body.value.messages.length, 1)
    assert.equal(targetState.body.value.messages[0].delivery.mode, 'queued')
    assert.equal(targetState.body.value.messages[0].delivery.delivered, false)
  })

  it('recovers a wake target through sessionController.resolveAgent', async () => {
    // agents.get() misses s-02, so delivery must fall back to the controller.
    const local = await boot({ agentGetMissing: ['s-02'] })
    try {
      const response = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'fallback wake',
        wake: true,
      })
      assert.equal(response.status, 200)
      assert.equal(response.body.value.delivery.mode, 'wake')
      assert.equal(response.body.value.delivery.delivered, true)
      assert.equal(response.body.value.delivery.targetSessionId, 's-02')
      assert.equal(local.followups.length, 1)
      assert.equal(local.followups[0].target, 's-02')
    } finally {
      await local.destroy()
    }
  })

  it('accepts a files-only send with no body or data', async () => {
    // The sender is s-01, whose workspace is Alpha: the attachment must live
    // inside the sender's workspace under the default settings.
    const file = join(harness.wsAlpha, 'files-only.txt')
    await writeFile(file, 'files only payload')

    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      files: [file],
      wake: false,
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    const value = response.body.value
    assert.equal(value.message.body, '')
    assert.equal(value.message.data, undefined)
    assert.equal(value.message.files.length, 1)
    assert.equal(value.message.files[0].name, 'files-only.txt')
    assert.equal(value.message.files[0].bytes, Buffer.byteLength('files only payload'))

    const state = await harness.call('state', { sessionId: 's-02' })
    assert.equal(state.body.value.messages.length, 1)
    assert.equal(state.body.value.messages[0].files.length, 1)
  })

  it('uses mailbox mode for a mailbox send to an empty workspace and none for a wake request', async () => {
    await enableWorkspaceBroadcast(harness)
    const emptyWorkspace = join(harness.root, 'empty-workspace')
    await mkdir(emptyWorkspace)
    assert.equal(harness.followups.length, 0)

    const mailbox = await harness.call('send', {
      fromSessionId: 's-01',
      to: emptyWorkspace,
      subject: 'Stored only',
      body: 'no sessions here',
      wake: false,
    })
    assert.equal(mailbox.status, 200)
    assert.equal(mailbox.body.value.delivery.requested, 'mailbox')
    assert.equal(mailbox.body.value.delivery.mode, 'mailbox')
    assert.equal(mailbox.body.value.message.to.workspacePath, resolve(emptyWorkspace))
    assert.equal(harness.followups.length, 0)

    const wake = await harness.call('send', {
      fromSessionId: 's-01',
      to: emptyWorkspace,
      subject: 'Nobody to wake',
      body: 'still stored',
      wake: true,
    })
    assert.equal(wake.status, 200)
    assert.equal(wake.body.value.delivery.requested, 'wake')
    assert.equal(wake.body.value.delivery.mode, 'none')
    assert.equal(wake.body.value.delivery.delivered, false)
    assert.match(wake.body.value.delivery.note, /没有可唤醒的会话/)
    assert.equal(harness.followups.length, 0)
  })

  it('rejects self-send and missing/unknown recipients', async () => {
    const self = await harness.call('send', { fromSessionId: 's-01', to: 'session:s-01', body: 'self' })
    assert.equal(self.status, 400)
    assert.equal(self.body.ok, false)
    assert.equal(self.body.error.code, 'self-send')

    const noSession = await harness.call('send', { to: 'Alpha', body: 'x' })
    assert.equal(noSession.status, 400)
    assert.equal(noSession.body.error.code, 'no-session')

    const emptyTarget = await harness.call('send', { fromSessionId: 's-01', to: '  ', body: 'x' })
    assert.equal(emptyTarget.status, 400)
    assert.equal(emptyTarget.body.error.code, 'invalid-target')

    const unknown = await harness.call('send', { fromSessionId: 's-01', to: 'Nowhere', body: 'x' })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error.code, 'target-not-found')
  })
})

describe('HTTP security fences', () => {
  it('enforces POST, same-origin, the marker header and JSON content type', async () => {
    const get = await harness.call('state', {}, { method: 'GET', bodyText: '' })
    assert.equal(get.status, 405)
    assert.equal(get.body.error.code, 'method-not-allowed')

    const missingHeader = await harness.call('state', {}, { headers: { 'x-dsh-cross-workspace': undefined } })
    assert.equal(missingHeader.status, 403)
    assert.equal(missingHeader.body.error.code, 'forbidden')

    const wrongHeader = await harness.call('state', {}, { headers: { 'x-dsh-cross-workspace': '0' } })
    assert.equal(wrongHeader.status, 403)

    const badOrigin = await harness.call('state', {}, { headers: { origin: 'http://evil.invalid' } })
    assert.equal(badOrigin.status, 403)

    const noOrigin = await harness.call('state', {}, { headers: { origin: undefined } })
    assert.equal(noOrigin.status, 403)

    const wrongContentType = await harness.call('state', {}, { headers: { 'content-type': 'text/plain' } })
    assert.equal(wrongContentType.status, 415)
    assert.equal(wrongContentType.body.error.code, 'unsupported-media-type')

    const invalidJson = await harness.call('state', {}, { bodyText: '{not json' })
    assert.equal(invalidJson.status, 400)
    assert.equal(invalidJson.body.error.code, 'invalid-json')

    const unknownAction = await harness.call('does-not-exist')
    assert.equal(unknownAction.status, 400)
    assert.equal(unknownAction.body.error.code, 'unknown-action')
  })

  it('accepts requests cleared by connection.requestRejection', async () => {
    const local = await boot({ connection: { requestRejection: () => undefined } })
    try {
      const response = await local.call('state', { sessionId: 's-01' }, { headers: { origin: 'http://elsewhere.invalid' } })
      assert.equal(response.status, 200)
      assert.equal(response.body.ok, true)
    } finally {
      await local.destroy()
    }
  })
})

describe('action: read, mark, delete', () => {
  it('tracks per-session read state through the API', async () => {
    const sent = await harness.call('send', { fromSessionId: 's-01', to: 'session:s-02', body: 'read me', wake: false })
    const id = sent.body.value.message.id

    let state = await harness.call('state', { sessionId: 's-02' })
    assert.equal(state.body.value.unreadTotal, 1)
    assert.equal(state.body.value.messages[0].read, false)
    const betaRow = state.body.value.workspaces.find(workspace => workspace.path === harness.wsBeta)
    assert.equal(betaRow.unread, 1)

    const read = await harness.call('read', { id, sessionId: 's-02' })
    assert.equal(read.status, 200)
    assert.equal(read.body.value.message.id, id)
    assert.equal(read.body.value.message.read, true)

    state = await harness.call('state', { sessionId: 's-02' })
    assert.equal(state.body.value.unreadTotal, 0)
    assert.equal(state.body.value.messages[0].read, true)
    assert.equal(state.body.value.workspaces.find(workspace => workspace.path === harness.wsBeta).unread, 0)

    const markedUnread = await harness.call('mark', { id, read: false, sessionId: 's-02' })
    assert.equal(markedUnread.body.value.message.read, false)
    state = await harness.call('state', { sessionId: 's-02' })
    assert.equal(state.body.value.unreadTotal, 1)

    const deleted = await harness.call('delete', { id })
    assert.equal(deleted.status, 200)
    assert.deepEqual(deleted.body.value, { deleted: true })
    state = await harness.call('state', { sessionId: 's-02' })
    assert.deepEqual(state.body.value.messages, [])
    assert.equal(state.body.value.unreadTotal, 0)

    const missingRead = await harness.call('read', { id: 'm-missing', sessionId: 's-02' })
    assert.equal(missingRead.status, 400)
    assert.equal(missingRead.body.error.code, 'message-not-found')

    const badMark = await harness.call('mark', { id, read: 'yes', sessionId: 's-02' })
    assert.equal(badMark.status, 400)
    assert.equal(badMark.body.error.code, 'invalid-read')

    const missingDelete = await harness.call('delete', { id: 'm-missing' })
    assert.equal(missingDelete.status, 400)
    assert.equal(missingDelete.body.error.code, 'message-not-found')
  })
})

describe('action: settings, prune, clear, deliver', () => {
  it('persists validated settings and applies the new default delivery', async () => {
    const updated = await harness.call('settings', {
      patch: { defaultDelivery: 'mailbox', allowWake: false, retentionDays: 7 },
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.value.settings.defaultDelivery, 'mailbox')
    assert.equal(updated.body.value.settings.allowWake, false)
    assert.equal(updated.body.value.settings.retentionDays, 7)

    const state = await harness.call('state', { sessionId: 's-01' })
    assert.equal(state.body.value.settings.defaultDelivery, 'mailbox')

    // Omitting `wake` now follows the stored default (mailbox).
    const sent = await harness.call('send', { fromSessionId: 's-01', to: 'session:s-02', body: 'default' })
    assert.equal(sent.body.value.delivery.requested, 'mailbox')
    assert.equal(sent.body.value.delivery.mode, 'mailbox')

    const badEnum = await harness.call('settings', { patch: { defaultDelivery: 'teleport' } })
    assert.equal(badEnum.status, 400)
    assert.equal(badEnum.body.error.code, 'invalid-settings')

    const unknownKey = await harness.call('settings', { patch: { nope: 1 } })
    assert.equal(unknownKey.status, 400)
    assert.equal(unknownKey.body.error.code, 'invalid-settings')

    const noPatch = await harness.call('settings', {})
    assert.equal(noPatch.status, 400)
    assert.equal(noPatch.body.error.code, 'invalid-settings')
  })

  it('round-trips the allowExternalAttachments setting through the API', async () => {
    const enabled = await harness.call('settings', { patch: { allowExternalAttachments: true } })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.value.settings.allowExternalAttachments, true)

    const state = await harness.call('state', { sessionId: 's-01' })
    assert.equal(state.body.value.settings.allowExternalAttachments, true)

    const disabled = await harness.call('settings', { patch: { allowExternalAttachments: false } })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.body.value.settings.allowExternalAttachments, false)

    const invalid = await harness.call('settings', { patch: { allowExternalAttachments: 'yes' } })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'invalid-settings')

    // waitForIdleSeconds round-trips and validates its 0..600 bounds.
    const waitPatched = await harness.call('settings', { patch: { waitForIdleSeconds: 45 } })
    assert.equal(waitPatched.status, 200)
    assert.equal(waitPatched.body.value.settings.waitForIdleSeconds, 45)
    const stateAfter = await harness.call('state', { sessionId: 's-01' })
    assert.equal(stateAfter.body.value.settings.waitForIdleSeconds, 45)
    const waitInvalid = await harness.call('settings', { patch: { waitForIdleSeconds: 601 } })
    assert.equal(waitInvalid.status, 400)
    assert.equal(waitInvalid.body.error.code, 'invalid-settings')
    const waitZero = await harness.call('settings', { patch: { waitForIdleSeconds: 0 } })
    assert.equal(waitZero.body.value.settings.waitForIdleSeconds, 0)
  })

  it('prunes and clears stored messages', async () => {
    const first = await harness.call('send', { fromSessionId: 's-01', to: 'session:s-02', subject: 'A', body: 'A', wake: false })
    const second = await harness.call('send', { fromSessionId: 's-01', to: 'session:s-02', subject: 'B', body: 'B', wake: false })
    await harness.call('read', { id: first.body.value.message.id, sessionId: 's-02' })

    const pruned = await harness.call('prune', {})
    assert.equal(pruned.status, 200)
    assert.equal(pruned.body.value.removed, 0)
    assert.equal(pruned.body.value.kept, 2)
    assert.equal(pruned.body.value.storeDir, harness.storeDir)

    const cleared = await harness.call('clear', { scope: 'read' })
    assert.equal(cleared.body.value.removed, 1)
    assert.equal(second.status, 200)

    const remaining = await harness.call('state', { filter: 'all' })
    assert.equal(remaining.body.value.messages.length, 1)

    const clearedAll = await harness.call('clear', { scope: 'all' })
    assert.equal(clearedAll.body.value.removed, 1)
    const empty = await harness.call('state', { filter: 'all' })
    assert.deepEqual(empty.body.value.messages, [])
  })

  it('deliver re-attempts a wake for an existing message', async () => {
    const sent = await harness.call('send', { fromSessionId: 's-01', to: 'session:s-02', body: 'deliver me', wake: false })
    const id = sent.body.value.message.id
    assert.equal(sent.body.value.delivery.mode, 'mailbox')

    const delivered = await harness.call('deliver', { id })
    assert.equal(delivered.status, 200)
    assert.equal(delivered.body.value.delivery.requested, 'wake')
    assert.equal(delivered.body.value.delivery.mode, 'wake')
    assert.equal(delivered.body.value.delivery.delivered, true)
    assert.equal(delivered.body.value.delivery.targetSessionId, 's-02')
    assert.equal(delivered.body.value.message.delivery.mode, 'wake')
    assert.equal(harness.followups.length, 1)
  })

  it('rejects re-delivering a workspace broadcast when broadcasts are disabled', async () => {
    const local = await boot({
      settings: { allowWorkspaceBroadcast: true, targetWakeCooldownSeconds: 0, wakesPerMinute: 0 },
    })
    try {
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Beta',
        subject: 'Broadcast delivery',
        body: 'to workspace',
        wake: false,
      })
      assert.equal(sent.status, 200)
      const id = sent.body.value.message.id
      assert.equal(sent.body.value.message.to.workspacePath, local.wsBeta)

      await local.call('settings', { patch: { allowWorkspaceBroadcast: false } })
      const followupsBefore = local.followups.length
      const blocked = await local.call('deliver', { id })
      assert.equal(blocked.status, 400)
      assert.equal(blocked.body.error.code, 'broadcast-disabled')
      assert.equal(local.followups.length, followupsBefore)

      // Session-targeted messages are not gated by the broadcast setting.
      const direct = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'direct delivery',
        wake: false,
      })
      const deliveredDirect = await local.call('deliver', { id: direct.body.value.message.id })
      assert.equal(deliveredDirect.status, 200)
      assert.equal(deliveredDirect.body.value.delivery.mode, 'wake')
      assert.equal(local.followups.length, followupsBefore + 1)

      // Re-enabling the setting allows the broadcast delivery again.
      await local.call('settings', { patch: { allowWorkspaceBroadcast: true } })
      const delivered = await local.call('deliver', { id })
      assert.equal(delivered.status, 200)
      assert.equal(delivered.body.value.delivery.requested, 'wake')
      assert.equal(delivered.body.value.delivery.mode, 'wake')
      assert.equal(delivered.body.value.delivery.delivered, true)
      assert.ok(['s-02', 's-03'].includes(delivered.body.value.delivery.targetSessionId))
      assert.equal(local.followups.length, followupsBefore + 2)
    } finally {
      await local.destroy()
    }
  })
})

describe('agent tools', () => {
  it('mail_send + mail_inbox + mail_read round-trip data and an attachment', async () => {
    await enableWorkspaceBroadcast(harness)
    // Sender s-02 lives in Beta: keep the attachment inside that workspace.
    const attachment = join(harness.wsBeta, 'tool-attachment.txt')
    await writeFile(attachment, 'TOOL ATTACHMENT')

    const sendValue = await executeTool(harness, 'mail_send', {
      to: 'Alpha',
      subject: 'Tool hello',
      body: 'tool body',
      data: { n: 42 },
      files: [attachment],
    }, { agent: { id: 's-02' } })
    assert.match(sendValue.message.id, /^m-/)
    assert.equal(sendValue.message.data.n, 42)
    assert.equal(sendValue.message.files.length, 1)
    assert.equal(sendValue.message.files[0].name, 'tool-attachment.txt')
    const sendText = assertTextOutput(harness.toolsByName.get('mail_send'), sendValue)
    assert.ok(sendText.text.includes(sendValue.message.id))
    assert.ok(sendText.text.includes('已存入跨工作区信箱'))

    const inboxValue = await executeTool(harness, 'mail_inbox', {}, { agent: { id: 's-01' } })
    assert.equal(inboxValue.unread, 1)
    assert.equal(inboxValue.visible, 1)
    assert.equal(inboxValue.messages.length, 1)
    assert.equal(inboxValue.messages[0].subject, 'Tool hello')
    assert.equal(inboxValue.messages[0].read, false)
    const inboxText = assertTextOutput(harness.toolsByName.get('mail_inbox'), inboxValue)
    assert.ok(inboxText.text.includes('Tool hello'))

    const readValue = await executeTool(harness, 'mail_read', { id: sendValue.message.id }, { agent: { id: 's-01' } })
    assert.equal(readValue.message.read, true)
    assert.equal(readValue.message.data.n, 42)
    assert.equal(readValue.fileTexts.length, 1)
    assert.equal(readValue.fileTexts[0].text, 'TOOL ATTACHMENT')
    const readText = assertTextOutput(harness.toolsByName.get('mail_read'), readValue)
    assert.ok(readText.text.includes('TOOL ATTACHMENT'))
    assert.ok(readText.text.includes('内容预览'))
    assert.ok(readText.text.includes('"n": 42'))

    const inboxAfter = await executeTool(harness, 'mail_inbox', {}, { agent: { id: 's-01' } })
    assert.equal(inboxAfter.unread, 0)
    assert.equal(inboxAfter.visible, 1)
  })

  it('mail_reply routes back to the sender and keeps the thread', async () => {
    const sent = await harness.call('send', {
      fromSessionId: 's-02',
      to: 'session:s-01',
      subject: 'Question',
      body: 'question',
      wake: false,
    })
    const parentId = sent.body.value.message.id

    const replyValue = await executeTool(harness, 'mail_reply', {
      id: parentId,
      body: 'answer',
    }, { agent: { id: 's-01' } })
    assert.equal(replyValue.message.to.sessionId, 's-02')
    assert.equal(replyValue.message.replyTo, parentId)
    assert.equal(replyValue.message.threadId, parentId)
    assert.equal(replyValue.message.hop, 1)
    assert.equal(replyValue.message.subject, 'Re: Question')
    assert.equal(replyValue.delivery.mode, 'wake')
    assert.equal(replyValue.delivery.targetSessionId, 's-02')
    assert.ok(harness.followups.some(followup => followup.target === 's-02'))

    const replyText = assertTextOutput(harness.toolsByName.get('mail_reply'), replyValue)
    assert.ok(replyText.text.includes('Re: Question'))

    // The reply lands in the original sender's inbox.
    const targetState = await harness.call('state', { sessionId: 's-02' })
    assert.ok(targetState.body.value.messages.some(message => message.id === replyValue.message.id))

    // Legacy prompts used messageId=; the tool accepts it as an alias for id.
    const aliasReply = await executeTool(harness, 'mail_reply', {
      messageId: parentId,
      body: 'alias answer',
    }, { agent: { id: 's-01' } })
    assert.equal(aliasReply.message.replyTo, parentId)
    assert.equal(aliasReply.message.to.sessionId, 's-02')
    assert.ok(harness.toolsByName.get('mail_reply').parameters.properties.messageId)
  })

  it('mail_wait times out with a helpful message and the text output shape', async () => {
    const startedAt = Date.now()
    const value = await executeTool(harness, 'mail_wait', { timeoutSeconds: 1 }, { agent: { id: 's-01' } })
    const elapsed = Date.now() - startedAt
    assert.equal(value.timedOut, true)
    assert.equal(value.aborted, false)
    assert.deepEqual(value.messages, [])
    assert.match(value.text, /超时/)
    assert.ok(value.waitedMs >= 800, `waitedMs=${value.waitedMs} elapsed=${elapsed}`)
    const output = assertTextOutput(harness.toolsByName.get('mail_wait'), value)
    assert.ok(output.text.includes('mail_wait 等待 1 秒超时'))
  })

  it('mail_send accepts an attachment path relative to the sender cwd', async () => {
    const relative = 'relative-note.txt'
    await writeFile(join(harness.wsBeta, relative), 'RELATIVE ATTACHMENT')

    const sendValue = await executeTool(harness, 'mail_send', {
      to: 'session:s-01',
      subject: 'Relative file',
      body: 'see attachment',
      files: [relative],
      wake: false,
    }, { agent: { id: 's-02' } })
    assert.equal(sendValue.message.files.length, 1)
    assert.equal(sendValue.message.files[0].name, relative)
    assert.ok(sendValue.message.files[0].path.includes(harness.storeDir))

    const readValue = await executeTool(harness, 'mail_read', { id: sendValue.message.id }, { agent: { id: 's-01' } })
    assert.equal(readValue.fileTexts.length, 1)
    assert.equal(readValue.fileTexts[0].text, 'RELATIVE ATTACHMENT')
  })

  it('workspace_list reports workspaces, sessions and unread counts', async () => {
    const value = await executeTool(harness, 'workspace_list', {}, { agent: { id: 's-01' } })
    assert.equal(value.me.sessionId, 's-01')
    assert.equal(value.me.cwd, harness.wsAlpha)
    assert.equal(value.me.workspacePath, harness.wsAlpha)
    assert.equal(value.workspaces.length, 2)
    const alpha = value.workspaces.find(workspace => workspace.title === 'Alpha')
    assert.ok(alpha)
    assert.ok(Object.hasOwn(alpha, 'unread'))
    assert.equal(alpha.sessions[0].sessionId, 's-01')
    assert.equal(alpha.sessions[0].title, 'Alpha Lead')

    const text = assertTextOutput(harness.toolsByName.get('workspace_list'), value)
    assert.ok(text.text.includes('Alpha'))
    assert.ok(text.text.includes('s-01'))

    const filtered = await executeTool(harness, 'workspace_list', { query: 'Beta' }, { agent: { id: 's-01' } })
    assert.equal(filtered.workspaces.length, 1)
    assert.equal(filtered.workspaces[0].title, 'Beta')
    // The workspace title itself matches the query, so both Beta sessions remain.
    assert.deepEqual(filtered.workspaces[0].sessions.map(session => session.sessionId), ['s-03', 's-02'])
  })

  it('rejects tool calls without an agent session or for unknown messages', async () => {
    await assert.rejects(
      executeTool(harness, 'mail_send', { to: 'Alpha', body: 'x' }, {}),
      /没有关联会话/,
    )
    await assert.rejects(
      executeTool(harness, 'mail_read', { id: 'm-missing' }, { agent: { id: 's-01' } }),
      /不存在/,
    )
    await assert.rejects(
      executeTool(harness, 'mail_reply', { id: 'm-missing' }, { agent: { id: 's-01' } }),
      /不存在/,
    )
  })
})

describe('system prompt context', () => {
  it('surfaces unread mail only while promptContext is enabled', async () => {
    const prompt = harness.prompts.get('s-01')
    assert.ok(prompt)
    assert.equal(prompt.name, 'cross-workspace-mail')
    assert.equal(prompt.order, 900)
    assert.equal(prompt.text(), '')

    await enableWorkspaceBroadcast(harness)
    await harness.call('send', {
      fromSessionId: 's-02',
      to: 'Alpha',
      subject: 'Prompt mail',
      body: 'yo',
      wake: false,
    })
    const text = prompt.text()
    assert.ok(text.includes('Prompt mail'))
    assert.ok(text.includes('1 条未读'))
    assert.ok(text.includes('外部内容'))

    await harness.call('settings', { patch: { promptContext: false } })
    assert.equal(prompt.text(), '')

    await harness.call('settings', { patch: { promptContext: true } })
    assert.ok(prompt.text().includes('Prompt mail'))

    const disposed = harness.handlers.get('agent/disposed')
    disposed({ agent: { id: 's-01' } })
    assert.equal(harness.disposed.has('s-01'), true)
  })
})

describe('attachment workspace root', () => {
  it('accepts an attachment inside the sender workspace', async () => {
    const file = join(harness.wsAlpha, 'inside.txt')
    await writeFile(file, 'inside payload')

    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      body: 'inside',
      files: [file],
      wake: false,
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.value.message.files.length, 1)
    assert.equal(response.body.value.message.files[0].name, 'inside.txt')
  })

  it('rejects an attachment outside the sender workspace', async () => {
    const outside = join(harness.root, 'outside-secret.txt')
    await writeFile(outside, 'outside payload')

    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      body: 'outside',
      files: [outside],
      wake: false,
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'attachment-outside-workspace')
    assert.match(response.body.error.message, /allowExternalAttachments/)
  })

  it('reports a missing file inside the sender workspace as file-not-found', async () => {
    const missing = join(harness.wsAlpha, 'does-not-exist.txt')
    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      body: 'missing',
      files: [missing],
      wake: false,
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'file-not-found')
    assert.notEqual(response.body.error.code, 'attachment-outside-workspace')
  })

  it('rejects a hardlink inside the sender workspace that points at an outside file', async (t) => {
    const outside = join(harness.root, 'hardlink-target.txt')
    await writeFile(outside, 'outside hardlink payload')
    const hardlink = join(harness.wsAlpha, 'hardlink-inside.txt')
    try {
      await link(outside, hardlink)
    } catch (error) {
      // Windows can deny hardlinks (or the temp/workspace could cross volumes).
      t.skip(`hardlink creation unavailable: ${error.code ?? error.message}`)
      return
    }

    // HTTP send surface.
    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      body: 'hardlink',
      files: [hardlink],
      wake: false,
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'attachment-hardlink')
    assert.match(response.body.error.message, /硬链接/)

    // Tool surface uses the same guard.
    await assert.rejects(
      executeTool(harness, 'mail_send', {
        to: 'session:s-02',
        body: 'hardlink tool',
        files: [hardlink],
        wake: false,
      }, { agent: { id: 's-01' } }),
      error => error?.code === 'attachment-hardlink',
    )
    assert.equal(harness.followups.length, 0)
  })

  it('allows a hardlink when allowExternalAttachments=true (guard is bypassed)', async () => {
    const local = await boot({ settings: { allowExternalAttachments: true } })
    try {
      const outside = join(local.root, 'hardlink-allowed-target.txt')
      await writeFile(outside, 'allowed hardlink payload')
      const hardlink = join(local.wsAlpha, 'hardlink-allowed.txt')
      await link(outside, hardlink)

      const response = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'allowed hardlink',
        files: [hardlink],
        wake: false,
      })
      assert.equal(response.status, 200)
      assert.equal(response.body.value.message.files.length, 1)
    } finally {
      await local.destroy()
    }
  })

  it('rejects a symlink inside the workspace that resolves outside it', async (t) => {
    const outsideDir = join(harness.root, 'outside-dir')
    await mkdir(outsideDir)
    const outside = join(outsideDir, 'symlink-target.txt')
    await writeFile(outside, 'symlink target')

    let escapedPath
    try {
      // Prefer a regular file symlink.
      const fileLink = join(harness.wsAlpha, 'escape-link.txt')
      await symlink(outside, fileLink)
      escapedPath = fileLink
    } catch (error) {
      // Windows without Developer Mode denies file symlinks (EPERM), but a
      // directory junction to an outside directory needs no elevation.
      try {
        const outsideLinkDir = join(harness.wsAlpha, 'escape-dir')
        await symlink(outsideDir, outsideLinkDir, 'junction')
        escapedPath = join(outsideLinkDir, 'symlink-target.txt')
      } catch {
        t.skip(`symlink/junction creation unavailable: ${error.code ?? error.message}`)
        return
      }
    }

    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      body: 'symlink escape',
      files: [escapedPath],
      wake: false,
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'attachment-outside-workspace')
  })

  it('allows external attachments when config.settings.allowExternalAttachments=true', async () => {
    const local = await boot({ settings: { allowExternalAttachments: true } })
    try {
      const outside = join(local.root, 'external-allowed.txt')
      await writeFile(outside, 'external payload')

      const response = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'external',
        files: [outside],
        wake: false,
      })
      assert.equal(response.status, 200)
      assert.equal(response.body.value.message.files.length, 1)
      assert.equal(response.body.value.message.files[0].name, 'external-allowed.txt')
    } finally {
      await local.destroy()
    }
  })
})

describe('HTTP fence peer admission', () => {
  it('rejects even a valid-looking Origin when requestRejection returns an object', async () => {
    const local = await boot({ connection: { requestRejection: () => ({ status: 401, code: 'unauthorized' }) } })
    try {
      // Default harness headers are same-origin + marker; the peer rejection
      // must still win and produce 403.
      const response = await local.call('state', { sessionId: 's-01' })
      assert.equal(response.status, 403)
      assert.equal(response.body.ok, false)
      assert.equal(response.body.error.code, 'forbidden')
    } finally {
      await local.destroy()
    }
  })

  it('rejects when requestRejection throws', async () => {
    const local = await boot({
      connection: {
        requestRejection: () => {
          throw new Error('peer admission exploded')
        },
      },
    })
    try {
      const response = await local.call('state', { sessionId: 's-01' })
      assert.equal(response.status, 403)
      assert.equal(response.body.error.code, 'forbidden')
    } finally {
      await local.destroy()
    }
  })

  it('falls back to the Origin/Host comparison when no connection service is mounted', async () => {
    // The default harness has no `connection` service.
    const sameOrigin = await harness.call('state', { sessionId: 's-01' })
    assert.equal(sameOrigin.status, 200)

    const crossOrigin = await harness.call('state', {}, { headers: { origin: 'http://evil.invalid' } })
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.body.error.code, 'forbidden')

    const noOrigin = await harness.call('state', {}, { headers: { origin: undefined } })
    assert.equal(noOrigin.status, 403)
  })
})

describe('self-wake exclusion', () => {
  it('does not wake the sender for a broadcast to its own workspace', async () => {
    await enableWorkspaceBroadcast(harness)
    // Alpha's only non-blank session is s-01, which is also the sender.
    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Alpha',
      subject: 'To own workspace',
      body: 'broadcast',
      wake: true,
    })
    assert.equal(response.status, 200)
    const value = response.body.value
    assert.equal(value.message.to.workspacePath, harness.wsAlpha)
    assert.equal(value.delivery.requested, 'wake')
    assert.equal(value.delivery.mode, 'none')
    assert.equal(value.delivery.delivered, false)
    assert.equal(harness.followups.length, 0)
    assert.equal(value.warnings.length, 1)
    // Distinct wording: the only possible wake target was the sender itself.
    assert.match(value.warnings[0], /只有发送方自己可唤醒/)
    assert.match(value.warnings[0], /已跳过自唤醒/)
  })

  it('localizes the only-sender self-wake warning in English', async () => {
    await enableWorkspaceBroadcast(harness)
    await harness.call('settings', { patch: { promptLocale: 'en' } })
    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Alpha',
      body: 'self wake en',
      wake: true,
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.value.delivery.mode, 'none')
    assert.equal(harness.followups.length, 0)
    assert.equal(response.body.value.warnings.length, 1)
    assert.match(response.body.value.warnings[0], /only the sender as a wake target/)
    assert.match(response.body.value.warnings[0], /self-wake was skipped/)
  })

  it('stores a mailbox-only broadcast to the sender workspace without waking', async () => {
    await enableWorkspaceBroadcast(harness)
    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Alpha',
      body: 'mailbox self',
      wake: false,
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.value.delivery.mode, 'mailbox')
    assert.equal(harness.followups.length, 0)
  })
})

describe('delivery downgrades', () => {
  it('downgrades a reply beyond maxHops to the mailbox', async () => {
    await harness.call('settings', { patch: { maxHops: 0 } })
    const parent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      body: 'root',
      wake: false,
    })
    const reply = await harness.call('send', {
      fromSessionId: 's-02',
      to: 'session:s-01',
      body: 'too deep',
      replyTo: parent.body.value.message.id,
      wake: true,
    })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.value.message.hop, 1)
    assert.equal(reply.body.value.delivery.requested, 'wake')
    assert.equal(reply.body.value.delivery.mode, 'mailbox')
    assert.equal(reply.body.value.delivery.delivered, false)
    assert.match(reply.body.value.delivery.note, /回复深度/)
    assert.equal(harness.followups.length, 0)
  })

  it('downgrades a wake once wakesPerMinute is exhausted', async () => {
    await harness.call('settings', { patch: { wakesPerMinute: 1 } })

    const first = await harness.call('send', {
      fromSessionId: 's-02',
      to: 'session:s-01',
      body: 'first wake',
      wake: true,
    })
    assert.equal(first.body.value.delivery.mode, 'wake')
    assert.equal(harness.followups.length, 1)

    const second = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      body: 'second wake',
      wake: true,
    })
    assert.equal(second.body.value.delivery.requested, 'wake')
    assert.equal(second.body.value.delivery.mode, 'mailbox')
    assert.equal(second.body.value.delivery.delivered, false)
    assert.match(second.body.value.delivery.note, /每分钟最多唤醒/)
    assert.equal(harness.followups.length, 1)
  })
})

describe('localized output (promptLocale)', () => {
  async function setEnglish() {
    const response = await harness.call('settings', { patch: { promptLocale: 'en' } })
    assert.equal(response.status, 200)
    assert.equal(response.body.value.settings.promptLocale, 'en')
  }

  it('renders mailbox and downgrade notes in English', async () => {
    const zhFirst = await harness.call('send', { fromSessionId: 's-01', to: 'session:s-02', body: 'default zh', wake: false })
    assert.match(zhFirst.body.value.delivery.note, /已存入信箱/)

    await setEnglish()

    const mailbox = await harness.call('send', { fromSessionId: 's-01', to: 'session:s-02', body: 'stored', wake: false })
    assert.equal(mailbox.body.value.delivery.mode, 'mailbox')
    assert.match(mailbox.body.value.delivery.note, /Stored in the mailbox/)

    const running = await harness.call('send', { fromSessionId: 's-01', to: 'session:s-03', body: 'busy', wake: true })
    assert.equal(running.body.value.delivery.mode, 'queued')
    assert.equal(running.body.value.delivery.delivered, false)
    assert.match(running.body.value.delivery.note, /The target is running; queued for its next turn after the current one/)
    // The queued followup still counts as a followup call.
    assert.equal(harness.followups.length, 1)
    assert.equal(harness.followups[0].target, 's-03')
  })

  it('localizes broadcast warnings', async () => {
    await setEnglish()
    await enableWorkspaceBroadcast(harness)
    const response = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Beta',
      body: 'broadcast en',
      wake: false,
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.value.warnings.length, 1)
    assert.match(response.body.value.warnings[0], /Broadcast to workspace/)
  })

  it('localizes mail_send and mail_reply rendered text', async () => {
    await setEnglish()

    const sendValue = await executeTool(harness, 'mail_send', {
      to: 'session:s-02',
      subject: 'EN send',
      body: 'english send',
      wake: false,
    }, { agent: { id: 's-01' } })
    const sendText = assertTextOutput(harness.toolsByName.get('mail_send'), sendValue)
    assert.ok(sendText.text.includes('Stored in the cross-workspace mailbox'))
    assert.ok(sendText.text.includes('Delivery: mailbox (not woken)'))
    assert.ok(!sendText.text.includes('已存入跨工作区信箱'))

    const replyValue = await executeTool(harness, 'mail_reply', {
      id: sendValue.message.id,
      body: 'english reply',
    }, { agent: { id: 's-02' } })
    const replyText = assertTextOutput(harness.toolsByName.get('mail_reply'), replyValue)
    assert.ok(replyText.text.includes('Stored in the cross-workspace mailbox'))
    assert.ok(replyText.text.includes('Delivery:'))
  })

  it('localizes the mail_wait timeout text', async () => {
    await setEnglish()
    const value = await executeTool(harness, 'mail_wait', { timeoutSeconds: 1 }, { agent: { id: 's-03' } })
    assert.equal(value.timedOut, true)
    assert.match(value.text, /timed out after 1s/)
  })
})

describe('mail_wait long poll', () => {
  it('returns as soon as new mail arrives', async () => {
    const waiting = executeTool(harness, 'mail_wait', { timeoutSeconds: 5 }, { agent: { id: 's-01' } })
    await sleep(150)
    await harness.call('send', {
      fromSessionId: 's-02',
      to: 'session:s-01',
      subject: 'While waiting',
      body: 'hi',
      wake: false,
    })
    const value = await waiting
    assert.equal(value.timedOut, false)
    assert.equal(value.aborted, false)
    assert.equal(value.messages.length, 1)
    assert.equal(value.messages[0].subject, 'While waiting')
    assert.ok(value.text.includes('While waiting'))
  })

  it('returns aborted=true when the exec signal is aborted', async () => {
    const controller = new AbortController()
    const waiting = executeTool(harness, 'mail_wait', { timeoutSeconds: 5 }, {
      agent: { id: 's-01' },
      signal: controller.signal,
    })
    await sleep(150)
    controller.abort()
    const value = await waiting
    assert.equal(value.aborted, true)
    assert.equal(value.timedOut, false)
    assert.deepEqual(value.messages, [])
    assert.match(value.text, /取消/)
  })
})

describe('tool visibility rules', () => {
  it('rejects mail_read and mail_reply for mail not addressed to the calling session', async () => {
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      subject: 'Private',
      body: 'for s-02 only',
      wake: false,
    })
    const id = sent.body.value.message.id

    await assert.rejects(
      executeTool(harness, 'mail_read', { id }, { agent: { id: 's-03' } }),
      /不是发给当前会话\/工作区\/群组的/,
    )
    await assert.rejects(
      executeTool(harness, 'mail_reply', { id, body: 'nope' }, { agent: { id: 's-03' } }),
      /不是发给当前会话\/工作区\/群组的/,
    )
  })
})

describe('tool values are lossless JSON', () => {
  it('every tool returns a JSON-lossless value, including untitled sessions', async () => {
    // Self-check the validator itself.
    assert.throws(() => assertLosslessJson({ bad: undefined }), /undefined value/)
    assert.throws(() => assertLosslessJson({ bad: Number.NaN }), /non-finite number/)
    assert.throws(() => assertLosslessJson({ bad: new Date() }), /non-plain prototype/)

    // A live session without a title snapshot (real sessions may be untitled).
    harness.summaries.push({ sessionId: 's-untitled', cwd: harness.wsAlpha, updatedAt: 5, running: false, blank: false })
    harness.sessions.set('s-untitled', { id: 's-untitled', cwd: harness.wsAlpha })

    const sendValue = await executeTool(harness, 'mail_send', {
      to: 'session:s-01',
      subject: 'Lossless',
      body: 'payload',
      data: { nested: { number: 1, bool: false, text: 'ok' }, list: [1, 2, 3] },
      wake: false,
    }, { agent: { id: 's-02' } })
    const inboxValue = await executeTool(harness, 'mail_inbox', {}, { agent: { id: 's-01' } })
    const readValue = await executeTool(harness, 'mail_read', { id: sendValue.message.id }, { agent: { id: 's-01' } })
    const replyValue = await executeTool(harness, 'mail_reply', { id: sendValue.message.id, body: 'reply' }, { agent: { id: 's-01' } })
    const listValue = await executeTool(harness, 'workspace_list', {}, { agent: { id: 's-01' } })
    const waitValue = await executeTool(harness, 'mail_wait', { timeoutSeconds: 1 }, { agent: { id: 's-03' } })

    // Group values go through the same lossless-JSON contract.
    const groupCreated = await harness.call('groupCreate', {
      name: 'Lossless Team',
      sessionIds: ['s-02', 's-03'],
      sessionId: 's-01',
    })
    assert.equal(groupCreated.status, 200)
    const groupSendValue = await executeTool(harness, 'mail_send', {
      groupId: groupCreated.body.value.group.id,
      body: 'group payload',
    }, { agent: { id: 's-01' } })
    const groupListValue = await executeTool(harness, 'workspace_list', {}, { agent: { id: 's-01' } })

    const values = {
      mail_send: sendValue,
      mail_inbox: inboxValue,
      mail_read: readValue,
      mail_reply: replyValue,
      workspace_list: listValue,
      mail_wait: waitValue,
      group_mail_send: groupSendValue,
      group_workspace_list: groupListValue,
    }
    for (const [name, value] of Object.entries(values)) {
      assertLosslessJson(value, { label: name })
      assertNoOwnUndefinedKeys(value, name)
    }

    assert.equal(groupListValue.groups.length, 1)
    assert.equal(groupListValue.groups[0].memberCount, 2)

    // workspace_list must omit unknown titles entirely instead of exposing
    // `title: undefined` (the live-not-JSON bug this guards).
    const untitled = listValue.workspaces
      .flatMap(workspace => workspace.sessions)
      .find(session => session.sessionId === 's-untitled')
    assert.ok(untitled)
    assert.equal(Object.hasOwn(untitled, 'title'), false)
    assert.equal(Object.hasOwn(untitled, 'cwd'), true)
  })
})

describe('attachment inline previews', () => {
  it('truncates over-limit text by bytes without breaking multibyte characters', async () => {
    const textFile = join(harness.wsAlpha, 'preview.txt')
    await writeFile(textFile, 'abcdefgh') // 8 bytes
    const cjkFile = join(harness.wsAlpha, 'cjk.txt')
    await writeFile(cjkFile, '中中') // 6 bytes, 3-byte codepoints
    const replacementFile = join(harness.wsAlpha, 'u-fffd.txt')
    // A complete (untruncated) file that legitimately ends with U+FFFD must
    // keep that character: only a *clipped* codepoint is stripped.
    await writeFile(replacementFile, 'abc\uFFFD')
    const binaryFile = join(harness.wsAlpha, 'binary.txt')
    // NUL byte => treated as binary and never inlined.
    await writeFile(binaryFile, Buffer.from([65, 0, 66]))

    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      body: 'preview',
      files: [textFile, cjkFile, replacementFile, binaryFile],
      wake: false,
    })
    assert.equal(sent.status, 200)
    const copies = Object.fromEntries(sent.body.value.message.files.map(file => [file.name, file]))
    assert.ok(copies['preview.txt'])
    assert.ok(copies['cjk.txt'])
    assert.ok(copies['u-fffd.txt'])
    const messageId = sent.body.value.message.id

    const entryFor = (value, name) => value.fileTexts.find(entry => entry.path === copies[name].path)
    const readAt = async (inlineTextBytes, promptLocale = undefined) => {
      await harness.call('settings', {
        patch: {
          inlineTextBytes,
          ...(promptLocale === undefined ? {} : { promptLocale }),
        },
      })
      return executeTool(harness, 'mail_read', { id: messageId }, { agent: { id: 's-02' } })
    }

    // Under the cap: full text, no truncation marker, NUL file skipped, and a
    // legitimately trailing U+FFFD survived untouched.
    const underCap = await readAt(16)
    assert.equal(underCap.fileTexts.length, 3)
    assert.equal(entryFor(underCap, 'preview.txt').text, 'abcdefgh')
    assert.equal(entryFor(underCap, 'cjk.txt').text, '中中')
    assert.equal(entryFor(underCap, 'u-fffd.txt').text, 'abc\uFFFD')
    assert.equal(underCap.fileTexts.some(entry => entry.path === copies['binary.txt'].path), false)

    // Above the cap: clipped by bytes with the zh truncation marker.
    const clipped = await readAt(5)
    assert.equal(entryFor(clipped, 'preview.txt').text, 'abcde\n…（预览已截断）')
    assert.ok(!entryFor(clipped, 'preview.txt').text.includes('\uFFFD'))

    // Multibyte boundary: the 4-byte cap splits the second 3-byte '中'; the
    // dangling U+FFFD must be dropped rather than leaked into the preview.
    const multibyte = await readAt(4)
    const cjkEntry = entryFor(multibyte, 'cjk.txt')
    assert.ok(cjkEntry)
    assert.equal(cjkEntry.text, '中\n…（预览已截断）')
    assert.ok(!cjkEntry.text.includes('\uFFFD'))

    // promptLocale='en' switches the truncation marker to English.
    const english = await readAt(5, 'en')
    assert.equal(entryFor(english, 'preview.txt').text, 'abcde\n…(preview truncated)')
    assert.ok(!entryFor(english, 'preview.txt').text.includes('预览已截断'))

    // inlineTextBytes=0 disables previews completely.
    const disabled = await readAt(0)
    assert.deepEqual(disabled.fileTexts, [])
  })
})

async function createGroupFixture(h, name, sessionIds, extra = {}) {
  const response = await h.call('groupCreate', { name, sessionIds, sessionId: 's-01', ...extra })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body.value.group
}

describe('manual groups — management actions', () => {
  it('creates groups, returns group views and lists them in state', async () => {
    const group = await createGroupFixture(harness, 'Team Alpha', ['s-01', 's-02'])
    assert.match(group.id, /^g-/)
    assert.equal(group.name, 'Team Alpha')
    assert.equal(group.memberCount, 2)
    assert.equal(group.unread, 0)
    assert.equal(typeof group.updatedAt, 'number')
    assert.equal(group.members.length, 2)
    const alpha = group.members.find(member => member.sessionId === 's-01')
    const beta = group.members.find(member => member.sessionId === 's-02')
    assert.deepEqual(alpha, {
      sessionId: 's-01',
      title: 'Alpha Lead',
      workspacePath: harness.wsAlpha,
      workspaceTitle: 'Alpha',
      running: false,
      blank: false,
    })
    assert.equal(beta.workspaceTitle, 'Beta')
    assert.equal(beta.title, 'Beta Worker')

    const state = await harness.call('state', { sessionId: 's-01' })
    assert.equal(state.body.value.groups.length, 1)
    assert.equal(state.body.value.groups[0].id, group.id)
    assert.equal(state.body.value.groups[0].memberCount, 2)
    assert.equal(state.body.value.groups[0].unread, 0)
  })

  it('updates names and members with mutual exclusion', async () => {
    const group = await createGroupFixture(harness, 'Team Alpha', ['s-01', 's-02'])

    const renamed = await harness.call('groupUpdate', { id: group.id, name: 'Team Beta' })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.body.value.group.name, 'Team Beta')

    const added = await harness.call('groupUpdate', { id: group.id, addSessionIds: ['s-03'] })
    assert.equal(added.body.value.group.memberCount, 3)
    assert.deepEqual(
      added.body.value.group.members.map(member => member.sessionId),
      ['s-01', 's-02', 's-03'],
    )

    const removed = await harness.call('groupUpdate', { id: group.id, removeSessionIds: ['s-01'] })
    assert.deepEqual(
      removed.body.value.group.members.map(member => member.sessionId),
      ['s-02', 's-03'],
    )

    const replaced = await harness.call('groupUpdate', { id: group.id, sessionIds: ['s-01'] })
    assert.equal(replaced.body.value.group.memberCount, 1)
    assert.equal(replaced.body.value.group.members[0].sessionId, 's-01')

    const conflict = await harness.call('groupUpdate', {
      id: group.id,
      sessionIds: ['s-01'],
      addSessionIds: ['s-02'],
    })
    assert.equal(conflict.status, 400)
    assert.equal(conflict.body.error.code, 'invalid-group-members')
  })

  it('validates group management input', async () => {
    const emptyName = await harness.call('groupCreate', { name: '   ', sessionIds: ['s-01'] })
    assert.equal(emptyName.status, 400)
    assert.equal(emptyName.body.error.code, 'invalid-group-name')

    const longName = await harness.call('groupCreate', { name: 'x'.repeat(61), sessionIds: ['s-01'] })
    assert.equal(longName.status, 400)
    assert.equal(longName.body.error.code, 'invalid-group-name')

    const missingMembers = await harness.call('groupCreate', { name: 'No Members' })
    assert.equal(missingMembers.status, 400)
    assert.equal(missingMembers.body.error.code, 'invalid-group-members')

    const group = await createGroupFixture(harness, 'Team Alpha', ['s-01'])
    const duplicate = await harness.call('groupCreate', { name: 'team alpha', sessionIds: ['s-02'] })
    assert.equal(duplicate.status, 400)
    assert.equal(duplicate.body.error.code, 'group-name-taken')

    await harness.call('settings', { patch: { maxGroupMembers: 1 } })
    const tooLarge = await harness.call('groupCreate', { name: 'Too Big', sessionIds: ['s-01', 's-02'] })
    assert.equal(tooLarge.status, 400)
    assert.equal(tooLarge.body.error.code, 'group-too-large')

    const missingId = await harness.call('groupUpdate', { name: 'x' })
    assert.equal(missingId.status, 400)
    assert.equal(missingId.body.error.code, 'invalid-id')
    const unknownUpdate = await harness.call('groupUpdate', { id: 'g-missing', name: 'x' })
    assert.equal(unknownUpdate.status, 400)
    assert.equal(unknownUpdate.body.error.code, 'group-not-found')
    const unknownDelete = await harness.call('groupDelete', { id: 'g-missing' })
    assert.equal(unknownDelete.status, 400)
    assert.equal(unknownDelete.body.error.code, 'group-not-found')
    const deleteWithoutId = await harness.call('groupDelete', {})
    assert.equal(deleteWithoutId.status, 400)
    assert.equal(deleteWithoutId.body.error.code, 'invalid-id')
    assert.equal(group.id, (await harness.call('state', { sessionId: 's-01' })).body.value.groups[0].id)
  })

  it('deletes the group but keeps its messages', async () => {
    const group = await createGroupFixture(harness, 'Doomed Team', ['s-01', 's-02'])
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Doomed Team',
      subject: 'Keep me',
      body: 'kept after group deletion',
    })
    const messageId = sent.body.value.message.id

    const deleted = await harness.call('groupDelete', { id: group.id })
    assert.equal(deleted.status, 200)
    assert.deepEqual(deleted.body.value, { deleted: true })

    let state = await harness.call('state', { sessionId: 's-01' })
    assert.deepEqual(state.body.value.groups, [])

    state = await harness.call('state', { filter: 'all' })
    const kept = state.body.value.messages.find(message => message.id === messageId)
    assert.ok(kept)
    assert.equal(kept.to.groupId, group.id)
    assert.equal(kept.to.groupName, 'Doomed Team')
  })
})

describe('manual groups — send and state', () => {
  it('sends mailbox-only group mail by name, prefix and groupId', async () => {
    const group = await createGroupFixture(harness, 'Send Team', ['s-01', 's-02', 's-03'])

    const first = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Send Team',
      subject: 'Group hello',
      body: 'hi',
    })
    assert.equal(first.status, 200)
    const firstValue = first.body.value
    assert.equal(firstValue.message.to.groupId, group.id)
    assert.equal(firstValue.message.to.groupName, 'Send Team')
    assert.deepEqual(firstValue.message.to.memberSessionIds, ['s-02', 's-03'])
    assert.equal(firstValue.delivery.requested, 'mailbox')
    assert.equal(firstValue.delivery.mode, 'mailbox')
    assert.equal(firstValue.delivery.delivered, false)
    assert.equal(Object.hasOwn(firstValue.delivery, 'members'), false)
    assert.equal(firstValue.message.delivery.mode, 'mailbox')
    assert.equal(Object.hasOwn(firstValue.message.delivery, 'members'), false)
    assert.equal(firstValue.warnings.length, 2)
    assert.match(firstValue.warnings[0], /群组「Send Team」的群发消息/)
    assert.match(firstValue.warnings[0], /快照/)
    assert.match(firstValue.warnings[1], /默认只投信箱/)
    assert.equal(harness.followups.length, 0)

    const prefixed = await harness.call('send', { fromSessionId: 's-01', to: 'group:Send Team', body: 'prefix' })
    assert.equal(prefixed.body.value.message.to.groupId, group.id)
    const byId = await harness.call('send', { fromSessionId: 's-01', groupId: group.id, body: 'by id' })
    assert.equal(byId.body.value.message.to.groupId, group.id)
    assert.deepEqual(byId.body.value.message.to.memberSessionIds, ['s-02', 's-03'])

    // Viewer unread is per group snapshot member; the sender is excluded.
    const memberState = await harness.call('state', { sessionId: 's-02' })
    assert.equal(memberState.body.value.messages.length, 3)
    assert.equal(memberState.body.value.groups[0].unread, 3)
    const senderState = await harness.call('state', { sessionId: 's-01' })
    assert.equal(senderState.body.value.groups[0].unread, 0)

    // Reading one group message clears only that message for that viewer.
    await harness.call('read', { id: firstValue.message.id, sessionId: 's-02' })
    const afterRead = await harness.call('state', { sessionId: 's-02' })
    assert.equal(afterRead.body.value.groups[0].unread, 2)

    // A second group plus groupIdFilter narrows the message list.
    const other = await createGroupFixture(harness, 'Other Team', ['s-02'])
    await harness.call('send', { fromSessionId: 's-01', to: 'Other Team', body: 'other group' })
    const filtered = await harness.call('state', { sessionId: 's-02', groupIdFilter: group.id })
    assert.equal(filtered.body.value.messages.length, 3)
    assert.ok(filtered.body.value.messages.every(message => message.to.groupId === group.id))
    const managementFiltered = await harness.call('state', { filter: 'all', groupIdFilter: other.id })
    assert.equal(managementFiltered.body.value.messages.length, 1)
    assert.equal(managementFiltered.body.value.messages[0].to.groupId, other.id)
  })

  it('wakes idle members and records per-member delivery results', async () => {
    await harness.call('settings', { patch: { targetWakeCooldownSeconds: 0, wakesPerMinute: 0 } })
    const group = await createGroupFixture(harness, 'Wake Team', ['s-01', 's-02', 's-03'])

    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Wake Team',
      subject: 'Wake everyone',
      body: 'wake up',
      wake: true,
    })
    assert.equal(sent.status, 200)
    const value = sent.body.value
    assert.equal(value.message.to.groupId, group.id)
    assert.deepEqual(value.message.to.memberSessionIds, ['s-02', 's-03'])
    assert.equal(value.delivery.requested, 'wake')
    assert.equal(value.delivery.mode, 'wake')
    assert.equal(value.delivery.delivered, true)
    assert.equal(value.delivery.targetSessionId, 's-02')
    assert.equal(value.delivery.members.length, 2)
    const awake = value.delivery.members.find(member => member.sessionId === 's-02')
    const queuedMember = value.delivery.members.find(member => member.sessionId === 's-03')
    assert.deepEqual(awake, { sessionId: 's-02', mode: 'wake' })
    assert.equal(queuedMember.mode, 'queued')
    assert.match(queuedMember.note, /正在运行/)
    assert.match(queuedMember.note, /已排到当前轮结束后的下一轮/)
    assert.match(value.delivery.note, /已确认唤醒 1 个，运行中已排队 1 个/)
    // Group wake does not emit the mailbox-only default warning.
    assert.equal(value.warnings.length, 1)
    assert.match(value.warnings[0], /快照/)
    // Both the confirmed wake and the queued followup were enqueued.
    assert.equal(harness.followups.length, 2)
    assert.deepEqual(harness.followups.map(followup => followup.target), ['s-02', 's-03'])
    assert.ok(harness.followups[0].payload.content[0].text.includes(value.message.id))
    assert.ok(harness.followups[0].payload.content[0].text.includes('群组「Wake Team」'))

    // The stored mailbox message can be redelivered as a group wake.
    const stored = await harness.call('send', { fromSessionId: 's-01', to: 'Wake Team', body: 'redeliver' })
    const delivered = await harness.call('deliver', { id: stored.body.value.message.id })
    assert.equal(delivered.status, 200)
    assert.equal(delivered.body.value.delivery.requested, 'wake')
    assert.equal(delivered.body.value.delivery.mode, 'wake')
    assert.equal(delivered.body.value.delivery.members.length, 2)
    assert.equal(harness.followups.length, 4)
  })

  it('downgrades group delivery for all-running, disabled wake and maxHops', async () => {
    await harness.call('settings', { patch: { targetWakeCooldownSeconds: 0, wakesPerMinute: 0 } })
    await createGroupFixture(harness, 'Busy Team', ['s-01', 's-03'])

    // All deliverable members are running -> queued with per-member results.
    const allRunning = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Busy Team',
      body: 'busy',
      wake: true,
    })
    const allRunningValue = allRunning.body.value
    assert.equal(allRunningValue.delivery.requested, 'wake')
    assert.equal(allRunningValue.delivery.mode, 'queued')
    assert.equal(allRunningValue.delivery.delivered, false)
    assert.equal(allRunningValue.delivery.targetSessionId, 's-03')
    assert.equal(allRunningValue.delivery.members.length, 1)
    assert.equal(allRunningValue.delivery.members[0].sessionId, 's-03')
    assert.equal(allRunningValue.delivery.members[0].mode, 'queued')
    assert.match(allRunningValue.delivery.members[0].note, /正在运行/)
    assert.match(allRunningValue.delivery.note, /已确认唤醒 0 个，运行中已排队 1 个/)
    // The queued followup for the running member was still enqueued.
    assert.equal(harness.followups.length, 1)

    // allowWake=false short-circuits before the group branch: no members list.
    await harness.call('settings', { patch: { allowWake: false } })
    const disabled = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Busy Team',
      body: 'wake off',
      wake: true,
    })
    assert.equal(disabled.body.value.delivery.mode, 'mailbox')
    assert.equal(disabled.body.value.delivery.delivered, false)
    assert.match(disabled.body.value.delivery.note, /唤醒投递已在设置中关闭/)
    assert.equal(Object.hasOwn(disabled.body.value.delivery, 'members'), false)

    // maxHops exceeded for a group reply: mailbox with a depth note.
    await harness.call('settings', { patch: { allowWake: true, maxHops: 0 } })
    await createGroupFixture(harness, 'Hop Team', ['s-01', 's-02'])
    const parent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Hop Team',
      subject: 'Root',
      body: 'root',
    })
    const reply = await harness.call('send', {
      fromSessionId: 's-02',
      to: 'group:Hop Team',
      body: 'too deep',
      replyTo: parent.body.value.message.id,
      wake: true,
    })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.value.message.hop, 1)
    assert.equal(reply.body.value.delivery.requested, 'wake')
    assert.equal(reply.body.value.delivery.mode, 'mailbox')
    assert.match(reply.body.value.delivery.note, /回复深度/)
    assert.equal(Object.hasOwn(reply.body.value.delivery, 'members'), false)
    // Only the earlier queued group followup; disabled/maxHops send none.
    assert.equal(harness.followups.length, 1)
  })

  it('rejects empty groups and unknown group targets', async () => {
    await createGroupFixture(harness, 'Solo Team', ['s-01'])
    const empty = await harness.call('send', { fromSessionId: 's-01', to: 'Solo Team', body: 'alone' })
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error.code, 'empty-group')

    const unknownName = await harness.call('send', { fromSessionId: 's-01', to: 'No Such Group', body: 'x' })
    assert.equal(unknownName.status, 400)
    assert.equal(unknownName.body.error.code, 'target-not-found')

    const unknownPrefixed = await harness.call('send', { fromSessionId: 's-01', to: 'group:No Such Group', body: 'x' })
    assert.equal(unknownPrefixed.status, 400)
    assert.equal(unknownPrefixed.body.error.code, 'group-not-found')

    const unknownId = await harness.call('send', { fromSessionId: 's-01', groupId: 'g-missing', body: 'x' })
    assert.equal(unknownId.status, 400)
    assert.equal(unknownId.body.error.code, 'group-not-found')

    const unknownMixed = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Alpha',
      groupId: 'g-missing',
      body: 'x',
    })
    assert.equal(unknownMixed.status, 400)
    assert.equal(unknownMixed.body.error.code, 'group-not-found')
  })
})

describe('manual groups — tools', () => {
  it('mail_send/mail_inbox/mail_read/mail_reply work with groups', async () => {
    const group = await createGroupFixture(harness, 'Tool Team', ['s-01', 's-02', 's-03'])

    const byName = await executeTool(harness, 'mail_send', {
      to: 'Tool Team',
      subject: 'Tool group',
      body: 'hello from tool',
    }, { agent: { id: 's-01' } })
    assert.equal(byName.message.to.groupId, group.id)
    assert.deepEqual(byName.message.to.memberSessionIds, ['s-02', 's-03'])
    assert.equal(byName.delivery.mode, 'mailbox')
    const byNameText = assertTextOutput(harness.toolsByName.get('mail_send'), byName)
    assert.ok(byNameText.text.includes('群组「Tool Team」/ 2 位成员'))

    const byId = await executeTool(harness, 'mail_send', {
      groupId: group.id,
      body: 'by group id',
    }, { agent: { id: 's-01' } })
    assert.equal(byId.message.to.groupId, group.id)

    const inbox = await executeTool(harness, 'mail_inbox', {}, { agent: { id: 's-02' } })
    assert.equal(inbox.unread, 2)
    assert.ok(inbox.messages.every(message => message.to.groupId === group.id))
    assert.ok(inbox.messages.every(message => message.read === false))

    const readValue = await executeTool(harness, 'mail_read', { id: byName.message.id }, { agent: { id: 's-02' } })
    assert.equal(readValue.message.read, true)
    const readText = assertTextOutput(harness.toolsByName.get('mail_read'), readValue)
    assert.ok(readText.text.includes('群组「Tool Team」'))

    const reply = await executeTool(harness, 'mail_reply', {
      id: byName.message.id,
      body: 'group reply',
    }, { agent: { id: 's-02' } })
    assert.equal(reply.message.to.groupId, group.id)
    assert.deepEqual(reply.message.to.memberSessionIds, ['s-01', 's-03'])
    assert.equal(reply.message.replyTo, byName.message.id)
    assert.equal(reply.message.threadId, byName.message.threadId)
    assert.equal(reply.message.hop, 1)
    assert.equal(reply.message.subject, 'Re: Tool group')
    assert.equal(reply.delivery.mode, 'mailbox')
    assert.equal(reply.warnings.length, 2)
    assert.ok(assertTextOutput(harness.toolsByName.get('mail_reply'), reply).text.includes('群组「Tool Team」'))
  })

  it('mail_reply to a group message fails after the group is deleted', async () => {
    const group = await createGroupFixture(harness, 'Gone Team', ['s-01', 's-02'])
    const sent = await executeTool(harness, 'mail_send', {
      to: 'Gone Team',
      body: 'will be orphaned',
    }, { agent: { id: 's-01' } })
    const deleted = await harness.call('groupDelete', { id: group.id })
    assert.equal(deleted.status, 200)

    await assert.rejects(
      executeTool(harness, 'mail_reply', { id: sent.message.id, body: 'too late' }, { agent: { id: 's-02' } }),
      /已删除，无法回群/,
    )
  })

  it('workspace_list exposes groups in value and text (with query filtering)', async () => {
    await createGroupFixture(harness, 'List Team', ['s-01', 's-02'])
    const value = await executeTool(harness, 'workspace_list', {}, { agent: { id: 's-01' } })
    assert.equal(value.groups.length, 1)
    const group = value.groups[0]
    assert.equal(group.name, 'List Team')
    assert.equal(group.memberCount, 2)
    assert.equal(group.unread, 0)
    assert.deepEqual(group.members.map(member => member.sessionId), ['s-01', 's-02'])
    assert.equal(group.members[0].workspaceTitle, 'Alpha')

    const text = assertTextOutput(harness.toolsByName.get('workspace_list'), value)
    assert.ok(text.text.includes('群组 1 个：'))
    assert.ok(text.text.includes('◆ List Team'))
    assert.ok(text.text.includes('group:<群组名>'))

    const filtered = await executeTool(harness, 'workspace_list', { query: 'list team' }, { agent: { id: 's-01' } })
    assert.equal(filtered.groups.length, 1)
    assert.equal(filtered.groups[0].name, 'List Team')
    assert.equal(filtered.workspaces.length, 0)
  })
})

describe('delivery legacy targetSessionId', () => {
  it('still supports the single-session target without a target object', async () => {
    const store = new MailStore({
      dir: join(harness.root, 'legacy-delivery'),
      logger: { warn: () => {}, error: () => {} },
    })
    await store.load()
    const message = await store.addMessage({
      from: { sessionId: 's-01' },
      to: { sessionId: 's-02' },
      body: 'legacy wake',
      delivery: { requested: 'wake', mode: 'none', delivered: false },
    })
    const ctx = { get: name => (name === 'agents' ? harness.agents : undefined) }
    const delivery = await deliverMessage(ctx, store, message, {
      requested: 'wake',
      targetSessionId: 's-02',
    })
    assert.equal(delivery.requested, 'wake')
    assert.equal(delivery.mode, 'wake')
    assert.equal(delivery.delivered, true)
    assert.equal(delivery.targetSessionId, 's-02')
    assert.equal(harness.followups.length, 1)
    assert.equal(harness.followups[0].target, 's-02')
  })
})

describe('wake followup UserMessage completeness', () => {
  // Agent.followup() takes a complete UserMessage. The live v0.2.0 bug passed
  // only { content, source }, which produced "messages[422]: missing field role".
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  function assertCompleteUserMessage(payload, messageId) {
    assert.equal(payload.role, 'user')
    assert.equal(typeof payload.id, 'string')
    assert.ok(payload.id.length > 0)
    assert.match(payload.id, UUID_RE)
    assert.deepEqual(payload.source, { kind: 'user' })
    assert.ok(Array.isArray(payload.content))
    assert.equal(payload.content.length, 1)
    assert.equal(payload.content[0].type, 'text')
    assert.equal(typeof payload.content[0].text, 'string')
    assert.ok(payload.content[0].text.length > 0)
    assert.ok(payload.content[0].text.includes(messageId))
  }

  it('sends a complete UserMessage for a single-session wake', async () => {
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      subject: 'Single wake',
      body: 'wake up',
      wake: true,
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.body.value.delivery.mode, 'wake')
    assert.equal(harness.followups.length, 1)
    assert.equal(harness.followups[0].target, 's-02')
    assertCompleteUserMessage(harness.followups[0].payload, sent.body.value.message.id)
  })

  it('sends a complete UserMessage for a group wake', async () => {
    await createGroupFixture(harness, 'Followup Team', ['s-01', 's-02', 's-03'])
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Followup Team',
      body: 'wake the group',
      wake: true,
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.body.value.delivery.mode, 'wake')
    assert.equal(sent.body.value.delivery.members.length, 2)
    // The idle member is woken; the running member is queued behind its turn.
    assert.equal(harness.followups.length, 2)
    assert.deepEqual(harness.followups.map(followup => followup.target), ['s-02', 's-03'])
    assertCompleteUserMessage(harness.followups[0].payload, sent.body.value.message.id)
    // Queued followups must also carry a complete UserMessage.
    assertCompleteUserMessage(harness.followups[1].payload, sent.body.value.message.id)
  })

  it('does not call followup for non-wake deliveries', async () => {
    await createGroupFixture(harness, 'Quiet Team', ['s-01', 's-02'])
    const direct = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      body: 'mailbox only',
      wake: false,
    })
    const group = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Quiet Team',
      body: 'group mailbox only',
    })
    assert.equal(direct.status, 200)
    assert.equal(group.status, 200)
    assert.equal(direct.body.value.delivery.mode, 'mailbox')
    assert.equal(group.body.value.delivery.mode, 'mailbox')
    assert.equal(harness.followups.length, 0)
  })

  it('uses a distinct UserMessage id per delivered followup', async () => {
    await harness.call('send', { fromSessionId: 's-01', to: 'session:s-02', body: 'first wake', wake: true })
    await harness.call('settings', { patch: { targetWakeCooldownSeconds: 0 } })
    await harness.call('send', { fromSessionId: 's-01', to: 'session:s-02', body: 'second wake', wake: true })

    assert.equal(harness.followups.length, 2)
    for (const followup of harness.followups) {
      assert.match(followup.payload.id, UUID_RE)
    }
    assert.equal(new Set(harness.followups.map(followup => followup.payload.id)).size, 2)
  })
})

describe('wake turn-start verification', () => {
  it('reports wake only when the turn marker advances (started)', async () => {
    const local = await boot({ turnBoundary: true, startOnFollowup: ['s-02'] })
    try {
      const startedAt = Date.now()
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'started wake',
        wake: true,
      })
      const elapsed = Date.now() - startedAt
      assert.equal(sent.status, 200)
      const delivery = sent.body.value.delivery
      assert.equal(delivery.requested, 'wake')
      assert.equal(delivery.mode, 'wake')
      assert.equal(delivery.delivered, true)
      assert.equal(delivery.targetSessionId, 's-02')
      assert.equal(local.turnState.get('s-02'), 1)
      assert.equal(local.followups.length, 1)
      // The complete UserMessage contract still holds on the verified path.
      const payload = local.followups[0].payload
      assert.equal(payload.role, 'user')
      assert.equal(typeof payload.id, 'string')
      assert.equal(payload.source.kind, 'user')
      assert.ok(payload.content[0].text.includes(sent.body.value.message.id))
      // Started turns return immediately instead of waiting out the timeout.
      assert.ok(elapsed < 1500, `started wake took ${elapsed}ms`)
    } finally {
      await local.destroy()
    }
  })

  it('also observes a start when the followup flips the agent to running', async () => {
    const local = await boot({ turnBoundary: true, startStatusOnFollowup: ['s-02'] })
    try {
      const startedAt = Date.now()
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'status-based start',
        wake: true,
      })
      const elapsed = Date.now() - startedAt
      const delivery = sent.body.value.delivery
      assert.equal(delivery.mode, 'wake')
      assert.equal(delivery.delivered, true)
      assert.equal(delivery.targetSessionId, 's-02')
      assert.equal(local.agents.get('s-02').status, 'running')
      // Observed through the running status, not the turn marker.
      assert.equal(local.turnState.get('s-02') ?? 0, 0)
      assert.ok(elapsed < 1500, `status-based wake took ${elapsed}ms`)
    } finally {
      await local.destroy()
    }
  })

  it('downgrades a queued wake when no turn start is observed', async () => {
    const local = await boot({ turnBoundary: true })
    try {
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'queued wake',
        wake: true,
      })
      assert.equal(sent.status, 200)
      const delivery = sent.body.value.delivery
      assert.equal(delivery.requested, 'wake')
      assert.equal(delivery.mode, 'mailbox')
      assert.equal(delivery.delivered, false)
      assert.equal(delivery.targetSessionId, 's-02')
      assert.match(delivery.note, /已入队但未观察到会话启动/)
      assert.equal(sent.body.value.message.delivery.mode, 'mailbox')
      assert.equal(sent.body.value.message.delivery.delivered, false)
      assert.match(sent.body.value.message.delivery.note, /已入队但未观察到会话启动/)
      assert.equal(local.turnState.get('s-02') ?? 0, 0)
      assert.equal(local.followups.length, 1)
    } finally {
      await local.destroy()
    }
  })

  it('records per-member results for a started + queued group mix', async () => {
    const local = await boot({
      turnBoundary: true,
      startOnFollowup: ['s-02'],
      extraSessions: [{ id: 's-04', status: 'idle' }],
    })
    try {
      const created = await local.call('groupCreate', {
        name: 'Verify Team',
        sessionIds: ['s-01', 's-02', 's-04'],
      })
      assert.equal(created.status, 200)

      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Verify Team',
        body: 'started and queued',
        wake: true,
      })
      const delivery = sent.body.value.delivery
      assert.equal(delivery.requested, 'wake')
      assert.equal(delivery.mode, 'wake')
      assert.equal(delivery.delivered, true)
      assert.equal(delivery.targetSessionId, 's-02')
      assert.equal(delivery.members.length, 2)

      const started = delivery.members.find(member => member.sessionId === 's-02')
      const queued = delivery.members.find(member => member.sessionId === 's-04')
      assert.deepEqual(started, { sessionId: 's-02', mode: 'wake' })
      assert.equal(queued.mode, 'mailbox')
      assert.match(queued.note, /已入队但未观察到会话启动/)
      assert.match(delivery.note, /已确认唤醒 1 个/)
      assert.equal(local.followups.length, 2)
    } finally {
      await local.destroy()
    }
  })

  it('keeps wake-success compatibility when turn boundaries are unavailable', async () => {
    const local = await boot() // no ctx.agents.turnBoundaryOf
    try {
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'legacy no-observation harness',
        wake: true,
      })
      assert.equal(sent.body.value.delivery.mode, 'wake')
      assert.equal(sent.body.value.delivery.delivered, true)
      assert.equal(local.followups.length, 1)
    } finally {
      await local.destroy()
    }
  })
})

describe('wake message-admission verification (eventsSnapshot)', () => {
  it('cold cache: admitted message is observed through snapshotEvents', async () => {
    const local = await boot({ eventsSnapshot: true, admitOnFollowup: ['s-02'] })
    try {
      const session = local.agents.get('s-02').session
      // Real Session cache starts cold and is only populated by a full read.
      assert.equal(session.eventsSnapshot, undefined)
      assert.equal(session.snapshotCalls, 0)

      const startedAt = Date.now()
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'admitted wake',
        wake: true,
      })
      const elapsed = Date.now() - startedAt
      assert.equal(sent.status, 200)
      const delivery = sent.body.value.delivery
      assert.equal(delivery.requested, 'wake')
      assert.equal(delivery.mode, 'wake')
      assert.equal(delivery.delivered, true)
      assert.equal(delivery.targetSessionId, 's-02')
      assert.ok(elapsed < 1500, `admitted wake took ${elapsed}ms`)

      // Delivery had to call snapshotEvents() (not the stale cache) to observe
      // the admitted UserMessage; the append invalidated the cache first.
      assert.ok(session.snapshotCalls > 0)
      assert.equal(session.log.length, 1)
      assert.equal(session.log[0].type, 'user/message')
      assert.equal(session.log[0].data.id, local.followups[0].payload.id)
      assert.equal(session.eventsSnapshot.length, 1)
      assert.equal(session.eventsSnapshot[0].data.id, local.followups[0].payload.id)
      // The complete UserMessage contract still holds on the admitted path.
      assert.equal(local.followups[0].payload.role, 'user')
      assert.equal(typeof local.followups[0].payload.id, 'string')
      assert.equal(local.followups[0].payload.source.kind, 'user')
    } finally {
      await local.destroy()
    }
  })

  it('cold cache: blocked turn does not fake wake', async () => {
    const local = await boot({
      eventsSnapshot: true,
      turnBoundary: true,
      blockOnFollowup: ['s-02'],
    })
    try {
      const session = local.agents.get('s-02').session
      assert.equal(session.eventsSnapshot, undefined)

      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-02',
        body: 'blocked wake',
        wake: true,
      })
      assert.equal(sent.status, 200)
      const delivery = sent.body.value.delivery
      assert.equal(delivery.requested, 'wake')
      assert.equal(delivery.mode, 'mailbox')
      assert.equal(delivery.delivered, false)
      assert.equal(delivery.targetSessionId, 's-02')
      assert.match(delivery.note, /已入队但未观察到会话启动/)
      assert.equal(sent.body.value.message.delivery.mode, 'mailbox')
      assert.equal(sent.body.value.message.delivery.delivered, false)

      // The turn did start (marker advanced) but no user/message was admitted.
      assert.equal(local.turnState.get('s-02'), 1)
      assert.ok(session.snapshotCalls > 0)
      assert.equal(session.log.length, 0)
      assert.deepEqual(session.eventsSnapshot, [])
      assert.equal(local.followups.length, 1)

      // The cache contract: appending anything invalidates it again.
      session.appendEvent({ type: 'turn/start', data: {} })
      assert.equal(session.eventsSnapshot, undefined)
    } finally {
      await local.destroy()
    }
  })

  it('reports admitted and blocked members separately in a group wake', async () => {
    const local = await boot({
      eventsSnapshot: true,
      turnBoundary: true,
      admitOnFollowup: ['s-02'],
      blockOnFollowup: ['s-04'],
      extraSessions: [{ id: 's-04', status: 'idle' }],
    })
    try {
      const admittedSession = local.agents.get('s-02').session
      const blockedSession = local.agents.get('s-04').session
      assert.equal(admittedSession.eventsSnapshot, undefined)
      assert.equal(blockedSession.eventsSnapshot, undefined)

      const created = await local.call('groupCreate', {
        name: 'Admission Team',
        sessionIds: ['s-01', 's-02', 's-04'],
      })
      assert.equal(created.status, 200)

      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Admission Team',
        body: 'one admitted one blocked',
        wake: true,
      })
      const delivery = sent.body.value.delivery
      assert.equal(delivery.requested, 'wake')
      assert.equal(delivery.mode, 'wake')
      assert.equal(delivery.delivered, true)
      assert.equal(delivery.targetSessionId, 's-02')
      assert.equal(delivery.members.length, 2)

      const admitted = delivery.members.find(member => member.sessionId === 's-02')
      const blocked = delivery.members.find(member => member.sessionId === 's-04')
      assert.deepEqual(admitted, { sessionId: 's-02', mode: 'wake' })
      assert.equal(blocked.mode, 'mailbox')
      assert.match(blocked.note, /已入队但未观察到会话启动/)
      assert.match(delivery.note, /已确认唤醒 1 个/)

      assert.ok(admittedSession.snapshotCalls > 0)
      assert.equal(admittedSession.log.length, 1)
      assert.equal(admittedSession.eventsSnapshot.length, 1)
      assert.ok(blockedSession.snapshotCalls > 0)
      assert.equal(blockedSession.log.length, 0)
      assert.deepEqual(blockedSession.eventsSnapshot, [])
      assert.equal(local.turnState.get('s-04'), 1)
      assert.equal(local.followups.length, 2)
    } finally {
      await local.destroy()
    }
  })
})

describe('archived and blank session filtering', () => {
  it('hides archived/blank sessions from state and workspace_list but resolves explicit ids', async () => {
    const local = await boot({
      extraSessions: [
        { id: 's-blank', status: 'idle', blank: true },
        { id: 's-archived', status: 'idle' },
        { id: 's-orphan-engaged', status: 'idle', cwd: 'gamma' },
        { id: 's-orphan-blank', status: 'idle', blank: true, cwd: 'gamma' },
        { id: 's-orphan-archived', status: 'idle', cwd: 'gamma' },
      ],
      archivedSessionIds: ['s-archived', 's-orphan-archived'],
    })
    try {
      const hiddenWorkspaceSessions = ['s-blank', 's-archived']
      const hiddenOrphans = ['s-orphan-blank', 's-orphan-archived']

      // Route state: workspace session rows and orphans are filtered.
      const state = await local.call('state', { sessionId: 's-01' })
      assert.equal(state.status, 200)
      const workspaceSessions = state.body.value.workspaces.flatMap(workspace => workspace.sessions)
      const workspaceSessionIds = workspaceSessions.map(session => session.sessionId)
      for (const id of ['s-01', 's-02', 's-03']) assert.ok(workspaceSessionIds.includes(id), id)
      for (const id of hiddenWorkspaceSessions) assert.equal(workspaceSessionIds.includes(id), false, id)
      for (const session of workspaceSessions) {
        assert.equal(Object.hasOwn(session, 'blank'), false)
      }
      assert.deepEqual(
        state.body.value.orphans.map(orphan => orphan.sessionId),
        ['s-orphan-engaged'],
      )

      // workspace_list value mirrors the filtering.
      const list = await executeTool(local, 'workspace_list', {}, { agent: { id: 's-01' } })
      const listSessionIds = list.workspaces.flatMap(workspace => workspace.sessions.map(session => session.sessionId))
      for (const id of hiddenWorkspaceSessions) assert.equal(listSessionIds.includes(id), false, id)
      assert.deepEqual(list.orphans.map(orphan => orphan.sessionId), ['s-orphan-engaged'])
      for (const session of list.workspaces.flatMap(workspace => workspace.sessions)) {
        assert.equal(Object.hasOwn(session, 'blank'), false)
      }

      const listText = assertTextOutput(local.toolsByName.get('workspace_list'), list).text
      for (const id of [...hiddenWorkspaceSessions, ...hiddenOrphans]) {
        assert.equal(listText.includes(id), false, id)
      }
      assert.ok(listText.includes('s-orphan-engaged'))
      assert.ok(!listText.includes('[空白]'))

      // Search still works over the filtered set.
      const search = await executeTool(local, 'workspace_list', { query: 'Beta Runner' }, { agent: { id: 's-01' } })
      assert.equal(search.workspaces.length, 1)
      assert.equal(search.workspaces[0].title, 'Beta')
      assert.deepEqual(search.workspaces[0].sessions.map(session => session.sessionId), ['s-03'])
      const orphanSearch = await executeTool(local, 'workspace_list', { query: 'orphan-engaged' }, { agent: { id: 's-01' } })
      assert.deepEqual(orphanSearch.orphans.map(orphan => orphan.sessionId), ['s-orphan-engaged'])

      // Explicit session ids remain addressable (they are still in the index).
      for (const target of ['s-blank', 's-archived']) {
        const sent = await local.call('send', {
          fromSessionId: 's-01',
          to: `session:${target}`,
          body: `explicit ${target}`,
          wake: false,
        })
        assert.equal(sent.status, 200, JSON.stringify(sent.body))
        assert.equal(sent.body.value.message.to.sessionId, target)
      }
    } finally {
      await local.destroy()
    }
  })
})

describe('stale registry records and unread consistency', () => {
  it('hides a stale unknown registry session from state and workspace_list', async () => {
    const local = await boot()
    try {
      // The registry still references a session that the live sessionController
      // no longer reports (stale id) -> buildIndex creates an unknown placeholder.
      const beta = local.workspaces.find(workspace => workspace.title === 'Beta')
      assert.ok(beta)
      beta.sessionIds.push('s-stale')

      const state = await local.call('state', { sessionId: 's-01' })
      assert.equal(state.status, 200)
      const stateSessionIds = state.body.value.workspaces
        .flatMap(workspace => workspace.sessions.map(session => session.sessionId))
      assert.equal(stateSessionIds.includes('s-stale'), false)
      assert.equal(state.body.value.orphans.some(orphan => orphan.sessionId === 's-stale'), false)

      const list = await executeTool(local, 'workspace_list', {}, { agent: { id: 's-01' } })
      const listSessionIds = list.workspaces
        .flatMap(workspace => workspace.sessions.map(session => session.sessionId))
      assert.equal(listSessionIds.includes('s-stale'), false)
      assert.equal(list.orphans.some(orphan => orphan.sessionId === 's-stale'), false)
      const text = assertTextOutput(local.toolsByName.get('workspace_list'), list).text
      assert.equal(text.includes('s-stale'), false)

      // A query for the stale id cannot resurrect it either.
      const search = await executeTool(local, 'workspace_list', { query: 's-stale' }, { agent: { id: 's-01' } })
      assert.equal(search.workspaces.length, 0)
      assert.equal(search.orphans.length, 0)
      assert.equal(assertTextOutput(local.toolsByName.get('workspace_list'), search).text.includes('s-stale'), false)
    } finally {
      await local.destroy()
    }
  })

  it('counts only listable sessions in workspace unread (state vs workspace_list agree)', async () => {
    const local = await boot({
      extraSessions: [
        { id: 's-blank', status: 'idle', blank: true },
        { id: 's-archived', status: 'idle' },
      ],
      archivedSessionIds: ['s-archived'],
    })
    try {
      const sendTo = async (target) => {
        const response = await local.call('send', {
          fromSessionId: 's-01',
          to: `session:${target}`,
          subject: `to ${target}`,
          body: 'seed',
          wake: false,
        })
        assert.equal(response.status, 200, JSON.stringify(response.body))
        return response.body.value.message.id
      }
      const blankId = await sendTo('s-blank')
      const archivedId = await sendTo('s-archived')
      const engagedId = await sendTo('s-02')

      // All three messages are stored; only the engaged session is listable.
      const all = await local.call('state', { filter: 'all' })
      assert.deepEqual(
        all.body.value.messages.map(message => message.id).sort(),
        [blankId, archivedId, engagedId].sort(),
      )

      const state = await local.call('state', { sessionId: 's-01' })
      const stateBeta = state.body.value.workspaces.find(workspace => workspace.path === local.wsBeta)
      const stateAlpha = state.body.value.workspaces.find(workspace => workspace.path === local.wsAlpha)
      assert.equal(stateBeta.unread, 1, 'only the engaged session unread counts')
      assert.equal(stateAlpha.unread, 0)
      assert.equal(
        stateBeta.sessions.some(session => session.sessionId === 's-blank' || session.sessionId === 's-archived'),
        false,
      )

      const list = await executeTool(local, 'workspace_list', {}, { agent: { id: 's-01' } })
      const listBeta = list.workspaces.find(workspace => workspace.path === local.wsBeta)
      const listAlpha = list.workspaces.find(workspace => workspace.path === local.wsAlpha)
      assert.equal(listBeta.unread, stateBeta.unread)
      assert.equal(listAlpha.unread, stateAlpha.unread)
      const text = assertTextOutput(local.toolsByName.get('workspace_list'), list).text
      assert.ok(text.includes(`■ Beta — ${local.wsBeta}（未读 1）`))
      assert.equal(text.includes('s-blank'), false)
      assert.equal(text.includes('s-archived'), false)

      // Reading the engaged message clears the badge everywhere, consistently.
      await local.call('read', { id: engagedId, sessionId: 's-02' })
      const stateAfter = await local.call('state', { sessionId: 's-01' })
      assert.equal(
        stateAfter.body.value.workspaces.find(workspace => workspace.path === local.wsBeta).unread,
        0,
      )
      const listAfter = await executeTool(local, 'workspace_list', {}, { agent: { id: 's-01' } })
      assert.equal(listAfter.workspaces.find(workspace => workspace.path === local.wsBeta).unread, 0)
      const textAfter = assertTextOutput(local.toolsByName.get('workspace_list'), listAfter).text
      assert.equal(textAfter.includes('（未读'), false)
    } finally {
      await local.destroy()
    }
  })
})

describe('running wake wait and queue', () => {
  it('queues a running target when no whenIdle API is available', async () => {
    const local = await boot() // s-03 is running and has no whenIdle()
    try {
      const startedAt = Date.now()
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-03',
        body: 'no idle api',
        wake: true,
      })
      const elapsed = Date.now() - startedAt
      assert.equal(sent.status, 200)
      const delivery = sent.body.value.delivery
      assert.equal(delivery.requested, 'wake')
      assert.equal(delivery.mode, 'queued')
      assert.equal(delivery.delivered, false)
      assert.equal(delivery.targetSessionId, 's-03')
      assert.match(delivery.note, /已排到当前轮结束后的下一轮/)
      assert.equal(local.followups.length, 1)
      assert.equal(local.followups[0].target, 's-03')
      assert.ok(elapsed < 1500, `queued path should not wait (${elapsed}ms)`)

      const state = await local.call('state', { sessionId: 's-03' })
      assert.equal(state.body.value.messages.length, 1)
      assert.equal(state.body.value.messages[0].delivery.mode, 'queued')
      assert.equal(state.body.value.messages[0].delivery.delivered, false)
    } finally {
      await local.destroy()
    }
  })

  it('does not wait when waitForIdleSeconds is 0 even if whenIdle exists', async () => {
    const local = await boot({ whenIdleAfterMs: { 's-03': 20 } })
    try {
      const configured = await local.call('settings', { patch: { waitForIdleSeconds: 0 } })
      assert.equal(configured.status, 200)
      assert.equal(configured.body.value.settings.waitForIdleSeconds, 0)

      const startedAt = Date.now()
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-03',
        body: 'zero wait',
        wake: true,
      })
      const elapsed = Date.now() - startedAt
      assert.equal(sent.body.value.delivery.mode, 'queued')
      assert.equal(sent.body.value.delivery.delivered, false)
      assert.ok(elapsed < 500, `wait=0 should queue immediately (${elapsed}ms)`)
      assert.equal(local.followups.length, 1)
    } finally {
      await local.destroy()
    }
  })

  it('waits for the running target to become idle and then confirms the wake', async () => {
    const local = await boot({
      eventsSnapshot: true,
      admitOnFollowup: ['s-03'],
      whenIdleAfterMs: { 's-03': 40 },
    })
    try {
      const startedAt = Date.now()
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-03',
        body: 'wait then wake',
        wake: true,
      })
      const elapsed = Date.now() - startedAt
      const delivery = sent.body.value.delivery
      assert.equal(delivery.requested, 'wake')
      assert.equal(delivery.mode, 'wake')
      assert.equal(delivery.delivered, true)
      assert.equal(delivery.targetSessionId, 's-03')
      assert.ok(elapsed >= 40, `should have waited for idle (${elapsed}ms)`)
      assert.ok(elapsed < 1500, `should not hit the 120s timeout (${elapsed}ms)`)
      assert.equal(local.followups.length, 1)
      assert.equal(local.followups[0].target, 's-03')
      // Admission was observed through snapshotEvents after the wait.
      const session = local.agents.get('s-03').session
      assert.equal(session.log.length, 1)
      assert.equal(session.log[0].data.id, local.followups[0].payload.id)
    } finally {
      await local.destroy()
    }
  })

  it('prioritises wake over queued and queued over mailbox in a group', async () => {
    const local = await boot({ extraSessions: [{ id: 's-04', status: 'idle' }] })
    try {
      await local.call('settings', { patch: { targetWakeCooldownSeconds: 3600, wakesPerMinute: 0 } })
      const created = await local.call('groupCreate', {
        name: 'Priority Team',
        sessionIds: ['s-01', 's-03', 's-04'],
      })
      assert.equal(created.status, 200)
      // Pre-wake the idle member so it hits the cooldown during the group send.
      const pre = await local.call('send', {
        fromSessionId: 's-01',
        to: 'session:s-04',
        body: 'pre-wake',
        wake: true,
      })
      assert.equal(pre.body.value.delivery.mode, 'wake')
      const followupsBefore = local.followups.length

      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Priority Team',
        body: 'priority',
        wake: true,
      })
      const delivery = sent.body.value.delivery
      assert.equal(delivery.mode, 'queued') // queued outranks mailbox, no confirmed wake
      assert.equal(delivery.delivered, false)
      assert.equal(delivery.targetSessionId, 's-03')
      assert.deepEqual(delivery.members.map(member => member.sessionId).sort(), ['s-03', 's-04'])
      const queuedMember = delivery.members.find(member => member.sessionId === 's-03')
      const mailboxMember = delivery.members.find(member => member.sessionId === 's-04')
      assert.equal(queuedMember.mode, 'queued')
      assert.equal(mailboxMember.mode, 'mailbox')
      assert.match(mailboxMember.note, /不足/)
      assert.match(delivery.note, /已确认唤醒 0 个，运行中已排队 1 个/)
      assert.equal(local.followups.length, followupsBefore + 1) // only the queued followup
    } finally {
      await local.destroy()
    }
  })
})

describe('group recipient subset', () => {
  it('sends only to selected members and hides the message from the others', async () => {
    const local = await boot()
    try {
      const created = await local.call('groupCreate', {
        name: 'Sub Team',
        sessionIds: ['s-01', 's-02', 's-03'],
      })
      assert.equal(created.status, 200)
      const groupId = created.body.value.group.id

      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Sub Team',
        memberSessionIds: ['s-02'],
        subject: 'Only S02',
        body: 'subset message',
        wake: false,
      })
      assert.equal(sent.status, 200)
      const value = sent.body.value
      assert.equal(value.message.to.groupId, groupId)
      assert.deepEqual(value.message.to.memberSessionIds, ['s-02'])
      assert.equal(value.delivery.mode, 'mailbox')
      assert.equal(value.warnings.length, 3) // snapshot + selected-only + mailbox-default
      assert.match(value.warnings[1], /只发给选中的 1 位成员/)

      const s02State = await local.call('state', { sessionId: 's-02' })
      const s03State = await local.call('state', { sessionId: 's-03' })
      const s01State = await local.call('state', { sessionId: 's-01' })
      assert.equal(s02State.body.value.messages.length, 1)
      assert.equal(s02State.body.value.messages[0].id, value.message.id)
      assert.equal(s03State.body.value.messages.length, 0)
      assert.equal(s01State.body.value.messages.length, 0)
    } finally {
      await local.destroy()
    }
  })

  it('excludes the sender and treats an empty subset as the whole group', async () => {
    const local = await boot()
    try {
      const created = await local.call('groupCreate', {
        name: 'Sub Team',
        sessionIds: ['s-01', 's-02', 's-03'],
      })
      const groupId = created.body.value.group.id

      const withSender = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Sub Team',
        memberSessionIds: ['s-01', 's-02'],
        body: 'include sender',
        wake: false,
      })
      assert.equal(withSender.status, 200)
      assert.deepEqual(withSender.body.value.message.to.memberSessionIds, ['s-02'])
      assert.equal(withSender.body.value.message.to.groupId, groupId)
      assert.equal(withSender.body.value.warnings.length, 3)
      assert.match(withSender.body.value.warnings[1], /只发给选中的 1 位成员/)

      const allMembers = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Sub Team',
        memberSessionIds: [],
        body: 'empty subset means all',
        wake: false,
      })
      assert.equal(allMembers.status, 200)
      assert.deepEqual(allMembers.body.value.message.to.memberSessionIds, ['s-02', 's-03'])
      assert.equal(allMembers.body.value.warnings.length, 2) // no selected-only warning
      assert.equal(allMembers.body.value.message.to.groupId, groupId)
    } finally {
      await local.destroy()
    }
  })

  it('rejects non-member subsets and subsets with no recipient left', async () => {
    const local = await boot()
    try {
      const created = await local.call('groupCreate', {
        name: 'Sub Team',
        sessionIds: ['s-01', 's-02'],
      })
      assert.equal(created.status, 200)

      const unknown = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Sub Team',
        memberSessionIds: ['s-04'],
        body: 'not a member',
      })
      assert.equal(unknown.status, 400)
      assert.equal(unknown.body.error.code, 'invalid-group-members')
      assert.match(unknown.body.error.message, /不在群组/)

      const onlySender = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Sub Team',
        memberSessionIds: ['s-01'],
        body: 'only sender',
      })
      assert.equal(onlySender.status, 400)
      assert.equal(onlySender.body.error.code, 'empty-group')
    } finally {
      await local.destroy()
    }
  })

  it('rejects malformed memberSessionIds and non-group member targeting', async () => {
    const local = await boot()
    try {
      const created = await local.call('groupCreate', {
        name: 'Sub Team',
        sessionIds: ['s-01', 's-02'],
      })
      assert.equal(created.status, 200)

      const malformed = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Sub Team',
        memberSessionIds: 's-02',
        body: 'malformed',
      })
      assert.equal(malformed.status, 400)
      assert.equal(malformed.body.error.code, 'invalid-group-members')

      const badEntry = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Sub Team',
        memberSessionIds: ['s-02', 42],
        body: 'bad entry',
      })
      assert.equal(badEntry.status, 400)
      assert.equal(badEntry.body.error.code, 'invalid-group-members')

      const nonGroup = await local.call('send', {
        fromSessionId: 's-01',
        to: 's-02',
        memberSessionIds: ['s-02'],
        body: 'not a group',
      })
      assert.equal(nonGroup.status, 400)
      assert.equal(nonGroup.body.error.code, 'invalid-target')
    } finally {
      await local.destroy()
    }
  })

  it('tools accept memberSessionIds for group send and group reply', async () => {
    const local = await boot()
    try {
      const created = await local.call('groupCreate', {
        name: 'Tool Sub Team',
        sessionIds: ['s-01', 's-02', 's-03'],
      })
      const groupId = created.body.value.group.id

      const sendValue = await executeTool(local, 'mail_send', {
        to: 'Tool Sub Team',
        memberSessionIds: ['s-02'],
        subject: 'tool subset',
        body: 'hello subset',
      }, { agent: { id: 's-01' } })
      assert.equal(sendValue.message.to.groupId, groupId)
      assert.deepEqual(sendValue.message.to.memberSessionIds, ['s-02'])
      assert.equal(sendValue.delivery.mode, 'mailbox') // groups default to mailbox

      const inboxS02 = await executeTool(local, 'mail_inbox', {}, { agent: { id: 's-02' } })
      const inboxS03 = await executeTool(local, 'mail_inbox', {}, { agent: { id: 's-03' } })
      assert.equal(inboxS02.messages.some(message => message.id === sendValue.message.id), true)
      assert.equal(inboxS03.messages.some(message => message.id === sendValue.message.id), false)

      const reply = await executeTool(local, 'mail_reply', {
        id: sendValue.message.id,
        body: 'narrow reply',
        memberSessionIds: ['s-03'],
      }, { agent: { id: 's-02' } })
      assert.equal(reply.message.to.groupId, groupId)
      assert.deepEqual(reply.message.to.memberSessionIds, ['s-03'])
      assert.equal(reply.message.replyTo, sendValue.message.id)
      assert.equal(reply.delivery.mode, 'mailbox')

      const replyInboxS03 = await executeTool(local, 'mail_inbox', {}, { agent: { id: 's-03' } })
      const replyInboxS01 = await executeTool(local, 'mail_inbox', {}, { agent: { id: 's-01' } })
      assert.equal(replyInboxS03.messages.some(message => message.id === reply.message.id), true)
      assert.equal(replyInboxS01.messages.some(message => message.id === reply.message.id), false)
    } finally {
      await local.destroy()
    }
  })
})

describe('action: markAll', () => {
  it('clears session, workspace and group unread badges and is idempotent', async () => {
    const group = await createGroupFixture(harness, 'All Team', ['s-02', 's-03'])
    const direct = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      subject: 'Direct',
      body: 'direct',
      wake: false,
    })
    const groupSend = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'All Team',
      subject: 'Group',
      body: 'group',
      wake: false,
    })
    assert.equal(direct.status, 200)
    assert.equal(groupSend.status, 200)

    const before = await harness.call('state', { sessionId: 's-02' })
    assert.equal(before.body.value.unreadTotal, 2) // direct + group
    assert.equal(before.body.value.groups.find(item => item.id === group.id).unread, 1)
    const betaBefore = before.body.value.workspaces.find(workspace => workspace.path === harness.wsBeta)
    assert.equal(betaBefore.unread, 1) // only the direct session message counts here
    assert.equal(
      betaBefore.sessions.find(session => session.sessionId === 's-02').unread,
      2,
    )
    assert.ok(before.body.value.messages.every(message => message.read === false))

    const marked = await harness.call('markAll', {})
    assert.equal(marked.status, 200)
    assert.deepEqual(marked.body.value, { marked: 2 })

    const after = await harness.call('state', { sessionId: 's-02' })
    assert.equal(after.body.value.unreadTotal, 0)
    assert.equal(after.body.value.groups[0].unread, 0)
    for (const workspace of after.body.value.workspaces) {
      assert.equal(workspace.unread, 0)
      for (const session of workspace.sessions) assert.equal(session.unread, 0)
    }
    assert.ok(after.body.value.messages.every(message => message.read === true))

    // Other intended recipients (group member s-03) are read as well.
    const s03 = await harness.call('state', { sessionId: 's-03' })
    assert.equal(s03.body.value.unreadTotal, 0)
    assert.equal(s03.body.value.groups[0].unread, 0)

    // Idempotent: a second markAll reports 0 changed.
    const again = await harness.call('markAll', {})
    assert.equal(again.status, 200)
    assert.deepEqual(again.body.value, { marked: 0 })

    // Same auth fence as the rest of the management API.
    const noHeader = await harness.call('markAll', {}, { headers: { 'x-dsh-cross-workspace': undefined } })
    assert.equal(noHeader.status, 403)
    assert.equal(noHeader.body.error.code, 'forbidden')
    const get = await harness.call('markAll', {}, { method: 'GET', bodyText: '' })
    assert.equal(get.status, 405)
  })

  it('returns marked 0 on an empty mailbox', async () => {
    const response = await harness.call('markAll', {})
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.value, { marked: 0 })
  })

  it('clears a workspace broadcast for a session viewer', async () => {
    await enableWorkspaceBroadcast(harness)
    const broadcast = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Beta',
      subject: 'Broadcast to Beta',
      body: 'hello workspace',
      wake: false,
    })
    assert.equal(broadcast.status, 200)

    const before = await harness.call('state', { sessionId: 's-02' })
    assert.equal(before.body.value.unreadTotal, 1)
    const betaBefore = before.body.value.workspaces.find(workspace => workspace.path === harness.wsBeta)
    assert.equal(betaBefore.unread, 1)
    assert.equal(betaBefore.sessions.find(session => session.sessionId === 's-02').unread, 1)
    assert.equal(before.body.value.messages[0].read, false)

    const marked = await harness.call('markAll', {})
    assert.equal(marked.status, 200)
    assert.deepEqual(marked.body.value, { marked: 1 })

    const after = await harness.call('state', { sessionId: 's-02' })
    assert.equal(after.body.value.unreadTotal, 0)
    assert.equal(after.body.value.workspaces.find(workspace => workspace.path === harness.wsBeta).unread, 0)
    for (const workspace of after.body.value.workspaces) {
      for (const session of workspace.sessions) assert.equal(session.unread, 0)
    }
    assert.equal(after.body.value.messages[0].read, true)

    // Other sessions in the workspace and the workspace viewer are cleared too.
    const s03 = await harness.call('state', { sessionId: 's-03' })
    assert.equal(s03.body.value.unreadTotal, 0)
    const workspaceViewer = await harness.call('state', { workspacePath: harness.wsBeta })
    assert.equal(workspaceViewer.body.value.unreadTotal, 0)

    // Idempotent.
    const again = await harness.call('markAll', {})
    assert.deepEqual(again.body.value, { marked: 0 })
  })

  it('keeps management group unread tied to the send-time member snapshot', async () => {
    const group = await createGroupFixture(harness, 'Snapshot Team', ['s-02', 's-03'])
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Snapshot Team',
      subject: 'Snapshot',
      body: 'snapshot message',
      wake: false,
    })
    assert.equal(sent.status, 200)
    const messageId = sent.body.value.message.id

    // Management view: nobody read the snapshot message yet.
    let management = await harness.call('state', { filter: 'all' })
    assert.equal(management.body.value.groups.find(item => item.id === group.id).unread, 1)

    // A snapshot member reads it and is then removed from the group. The
    // management badge must still honour the send-time snapshot.
    await harness.call('read', { id: messageId, sessionId: 's-02' })
    const removed = await harness.call('groupUpdate', { id: group.id, removeSessionIds: ['s-02'] })
    assert.equal(removed.status, 200)
    management = await harness.call('state', { filter: 'all' })
    assert.equal(management.body.value.groups.find(item => item.id === group.id).unread, 0)

    // A message sent after the membership edit uses the new snapshot and is
    // cleared by markAll.
    const second = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Snapshot Team',
      subject: 'Second',
      body: 'second message',
      wake: false,
    })
    assert.equal(second.status, 200)
    const marked = await harness.call('markAll', {})
    assert.equal(marked.status, 200)
    assert.equal(marked.body.value.marked, 2) // first message gains s-03, second gains s-03
    const after = await harness.call('state', { filter: 'all' })
    assert.equal(after.body.value.groups.find(item => item.id === group.id).unread, 0)
  })

  it('clears an orphan (unregistered directory) broadcast for its session viewer', async () => {
    const local = await boot({ extraSessions: [{ id: 's-orphan', status: 'idle', cwd: 'gamma' }] })
    try {
      await enableWorkspaceBroadcast(local)
      const sent = await local.call('send', {
        fromSessionId: 's-01',
        to: local.wsGamma,
        subject: 'Orphan broadcast',
        body: 'hello orphan',
        wake: false,
      })
      assert.equal(sent.status, 200)
      assert.equal(sent.body.value.message.to.workspacePath, local.wsGamma)

      const before = await local.call('state', { sessionId: 's-orphan' })
      assert.equal(before.body.value.unreadTotal, 1)
      assert.equal(before.body.value.orphans.some(orphan => orphan.sessionId === 's-orphan'), true)
      // gamma is not a registered workspace, so no workspace row exists.
      assert.equal(before.body.value.workspaces.some(workspace => workspace.path === local.wsGamma), false)

      const marked = await local.call('markAll', {})
      assert.equal(marked.status, 200)
      assert.deepEqual(marked.body.value, { marked: 1 })

      const after = await local.call('state', { sessionId: 's-orphan' })
      assert.equal(after.body.value.unreadTotal, 0)
      assert.equal(after.body.value.messages[0].read, true)
      const workspaceViewer = await local.call('state', { workspacePath: local.wsGamma })
      assert.equal(workspaceViewer.body.value.unreadTotal, 0)
    } finally {
      await local.destroy()
    }
  })

  it('falls back to current members for a legacy group message without a snapshot', async () => {
    const local = await boot({
      seedStore: async ({ storeDir }) => {
        const now = Date.now()
        await writeFile(join(storeDir, 'store.json'), JSON.stringify({
          version: 1,
          seq: 1,
          settings: {},
          groups: [{
            id: 'g-legacy',
            name: 'Legacy Team',
            createdAt: now,
            updatedAt: now,
            sessionIds: ['s-02', 's-03'],
          }],
          messages: [{
            id: 'm-legacy-group',
            threadId: 'm-legacy-group',
            hop: 0,
            createdAt: now,
            from: { sessionId: 's-01' },
            to: { groupId: 'g-legacy', groupName: 'Legacy Team' },
            subject: 'Legacy',
            body: 'legacy message without memberSessionIds',
            files: [],
            tags: [],
            readBy: [],
            delivery: { requested: 'mailbox', mode: 'mailbox', delivered: false },
          }],
        }))
      },
    })
    try {
      const before = await local.call('state', { filter: 'all' })
      const beforeGroup = before.body.value.groups.find(group => group.id === 'g-legacy')
      assert.ok(beforeGroup)
      assert.equal(beforeGroup.memberCount, 2)
      // No snapshot on the legacy record; management unread uses current members.
      assert.equal(beforeGroup.unread, 1)
      assert.equal(Array.isArray(before.body.value.messages[0].to.memberSessionIds), false)

      const marked = await local.call('markAll', {})
      assert.equal(marked.status, 200)
      assert.deepEqual(marked.body.value, { marked: 1 })

      const after = await local.call('state', { filter: 'all' })
      assert.equal(after.body.value.groups.find(group => group.id === 'g-legacy').unread, 0)
      const again = await local.call('markAll', {})
      assert.deepEqual(again.body.value, { marked: 0 })
    } finally {
      await local.destroy()
    }
  })
})

describe('group membership privacy and reply safety', () => {
  it('revokes history access when a member is removed from a live group', async () => {
    const group = await createGroupFixture(harness, 'Private Team', ['s-02', 's-03'])
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Private Team',
      subject: 'Private',
      body: 'members only',
      wake: false,
    })
    assert.equal(sent.status, 200)
    const messageId = sent.body.value.message.id

    const s03Before = await harness.call('state', { sessionId: 's-03' })
    assert.equal(s03Before.body.value.messages.length, 1)
    assert.equal(s03Before.body.value.unreadTotal, 1)

    const removed = await harness.call('groupUpdate', { id: group.id, removeSessionIds: ['s-03'] })
    assert.equal(removed.status, 200)

    const s03After = await harness.call('state', { sessionId: 's-03' })
    assert.equal(s03After.body.value.messages.length, 0)
    assert.equal(s03After.body.value.unreadTotal, 0)
    const inboxS03 = await executeTool(harness, 'mail_inbox', {}, { agent: { id: 's-03' } })
    assert.equal(inboxS03.messages.length, 0)
    await assert.rejects(
      () => executeTool(harness, 'mail_read', { id: messageId }, { agent: { id: 's-03' } }),
      /不是发给当前会话\/工作区\/群组的/,
    )
    await assert.rejects(
      () => executeTool(harness, 'mail_reply', { id: messageId, body: 'nope' }, { agent: { id: 's-03' } }),
      /不是发给当前会话\/工作区\/群组的/,
    )

    // Remaining snapshot member still reads it.
    const s02 = await harness.call('state', { sessionId: 's-02' })
    assert.equal(s02.body.value.messages.length, 1)
    assert.equal(s02.body.value.messages[0].id, messageId)

    // A member who joined after the send cannot see the old message.
    const added = await harness.call('groupUpdate', { id: group.id, addSessionIds: ['s-01'] })
    assert.equal(added.status, 200)
    const s01 = await harness.call('state', { sessionId: 's-01' })
    assert.equal(s01.body.value.messages.length, 0)

    // Re-adding s-03 restores access because the send-time snapshot still names it.
    await harness.call('groupUpdate', { id: group.id, addSessionIds: ['s-03'] })
    const s03Restored = await harness.call('state', { sessionId: 's-03' })
    assert.equal(s03Restored.body.value.messages.length, 1)
  })

  it('keeps snapshot-based history access after the group is deleted', async () => {
    const group = await createGroupFixture(harness, 'Archive Team', ['s-02', 's-03'])
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Archive Team',
      subject: 'Archived',
      body: 'deleted group history',
      wake: false,
    })
    const messageId = sent.body.value.message.id
    const deleted = await harness.call('groupDelete', { id: group.id })
    assert.equal(deleted.status, 200)

    for (const sessionId of ['s-02', 's-03']) {
      const state = await harness.call('state', { sessionId })
      assert.equal(state.body.value.messages.length, 1)
      assert.equal(state.body.value.messages[0].id, messageId)
    }
    const read = await executeTool(harness, 'mail_read', { id: messageId }, { agent: { id: 's-02' } })
    assert.equal(read.message.id, messageId)
    assert.equal(read.message.read, true)
  })

  it('refuses a direct reply when the original sender session is gone (no broadcast fallback)', async () => {
    const local = await boot({
      seedStore: async ({ storeDir, wsBeta }) => {
        const now = Date.now()
        await writeFile(join(storeDir, 'store.json'), JSON.stringify({
          version: 1,
          seq: 1,
          settings: {},
          groups: [],
          messages: [{
            id: 'm-ghost-sender',
            threadId: 'm-ghost-sender',
            hop: 0,
            createdAt: now,
            from: { sessionId: 's-ghost', workspacePath: wsBeta, workspaceTitle: 'Beta' },
            to: { sessionId: 's-02', workspacePath: wsBeta, workspaceTitle: 'Beta' },
            subject: 'Ghost',
            body: 'message from a vanished session',
            files: [],
            tags: [],
            readBy: [],
            delivery: { requested: 'mailbox', mode: 'mailbox', delivered: false },
          }],
        }))
      },
    })
    try {
      const before = await local.call('state', { filter: 'all' })
      assert.equal(before.body.value.messages.length, 1)

      // Old behaviour fell back to a workspace broadcast; it must throw now.
      await assert.rejects(
        () => executeTool(local, 'mail_reply', { id: 'm-ghost-sender', body: 'reply' }, { agent: { id: 's-02' } }),
        /原发件会话 s-ghost 已不存在，无法直接回复/,
      )

      const after = await local.call('state', { filter: 'all' })
      assert.equal(after.body.value.messages.length, 1) // no fallback broadcast created
    } finally {
      await local.destroy()
    }
  })

  it('does not restore deleted-group history to a member removed before deletion', async () => {
    const group = await createGroupFixture(harness, 'Tombstone Team', ['s-02', 's-03'])
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Tombstone Team',
      subject: 'Tombstone',
      body: 'history that must stay revoked',
      wake: false,
    })
    assert.equal(sent.status, 200)
    const messageId = sent.body.value.message.id

    await harness.call('groupUpdate', { id: group.id, removeSessionIds: ['s-03'] })
    const deleted = await harness.call('groupDelete', { id: group.id })
    assert.equal(deleted.status, 200)

    const s03 = await harness.call('state', { sessionId: 's-03' })
    assert.equal(s03.body.value.messages.length, 0)
    assert.equal(s03.body.value.unreadTotal, 0)
    const inboxS03 = await executeTool(harness, 'mail_inbox', {}, { agent: { id: 's-03' } })
    assert.equal(inboxS03.messages.length, 0)
    await assert.rejects(
      () => executeTool(harness, 'mail_read', { id: messageId }, { agent: { id: 's-03' } }),
      /不是发给当前会话\/工作区\/群组的/,
    )
    await assert.rejects(
      () => executeTool(harness, 'mail_reply', { id: messageId, body: 'nope' }, { agent: { id: 's-03' } }),
      /不是发给当前会话\/工作区\/群组的/,
    )

    // The member still in the group at deletion keeps the history.
    const s02 = await harness.call('state', { sessionId: 's-02' })
    assert.equal(s02.body.value.messages.length, 1)
    assert.equal(s02.body.value.messages[0].id, messageId)
  })

  it('keeps deleted-group history for a member re-added before deletion', async () => {
    const group = await createGroupFixture(harness, 'Returned Team', ['s-02', 's-03'])
    await harness.call('send', {
      fromSessionId: 's-01',
      to: 'Returned Team',
      subject: 'Returned',
      body: 'history for a returned member',
      wake: false,
    })
    await harness.call('groupUpdate', { id: group.id, removeSessionIds: ['s-03'] })
    await harness.call('groupUpdate', { id: group.id, addSessionIds: ['s-03'] })
    await harness.call('groupDelete', { id: group.id })

    for (const sessionId of ['s-02', 's-03']) {
      const state = await harness.call('state', { sessionId })
      assert.equal(state.body.value.messages.length, 1)
    }
  })

  it('handles legacy group records without snapshots or frozen members', async () => {
    const local = await boot({
      seedStore: async ({ storeDir }) => {
        const now = Date.now()
        const message = (id, to, body) => ({
          id,
          threadId: id,
          hop: 0,
          createdAt: now,
          from: { sessionId: 's-01' },
          to,
          subject: 'Legacy',
          body,
          files: [],
          tags: [],
          readBy: [],
          delivery: { requested: 'mailbox', mode: 'mailbox', delivered: false },
        })
        await writeFile(join(storeDir, 'store.json'), JSON.stringify({
          version: 1,
          seq: 2,
          settings: {},
          groups: [{
            id: 'g-live-legacy',
            name: 'Legacy Live',
            createdAt: now,
            updatedAt: now,
            sessionIds: ['s-02', 's-03'],
          }],
          messages: [
            // Live legacy record: no snapshot, follows current members.
            message('m-live-legacy', { groupId: 'g-live-legacy', groupName: 'Legacy Live' }, 'live no snapshot'),
            // Deleted by an older version: snapshot present, frozen field absent.
            message(
              'm-deleted-legacy',
              { groupId: 'g-gone', groupName: 'Gone', memberSessionIds: ['s-02'] },
              'deleted no frozen field',
            ),
          ],
        }))
      },
    })
    try {
      const s02 = await local.call('state', { sessionId: 's-02' })
      assert.deepEqual(
        new Set(s02.body.value.messages.map(message => message.id)),
        new Set(['m-live-legacy', 'm-deleted-legacy']),
      )
      const s03 = await local.call('state', { sessionId: 's-03' })
      assert.deepEqual(s03.body.value.messages.map(message => message.id), ['m-live-legacy'])
      const s01 = await local.call('state', { sessionId: 's-01' })
      assert.equal(s01.body.value.messages.length, 0)

      // Removing s-02 revokes the live legacy record but not the deleted
      // snapshot fallback record.
      await local.call('groupUpdate', { id: 'g-live-legacy', removeSessionIds: ['s-02'] })
      const s02After = await local.call('state', { sessionId: 's-02' })
      assert.deepEqual(s02After.body.value.messages.map(message => message.id), ['m-deleted-legacy'])
      const s03After = await local.call('state', { sessionId: 's-03' })
      assert.deepEqual(s03After.body.value.messages.map(message => message.id), ['m-live-legacy'])
    } finally {
      await local.destroy()
    }
  })
})

describe('action: edit', () => {
  it('edits subject/body/data and exposes editedAt without touching recipients or read state', async () => {
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      subject: 'Original',
      body: 'original body',
      data: { n: 1 },
      wake: false,
    })
    assert.equal(sent.status, 200)
    const id = sent.body.value.message.id
    const original = sent.body.value.message
    await harness.call('read', { id, sessionId: 's-02' })

    const startedAt = Date.now()
    const edited = await harness.call('edit', {
      id,
      sessionId: 's-02',
      subject: '  Edited subject  ',
      body: 'edited body',
      data: { n: 2, tag: 'x' },
    })
    assert.equal(edited.status, 200)
    assertLosslessJson(edited.body.value, { label: 'edit result' })
    const value = edited.body.value.message
    assert.equal(value.id, id)
    assert.equal(value.subject, 'Edited subject') // trimmed
    assert.equal(value.body, 'edited body')
    assert.deepEqual(value.data, { n: 2, tag: 'x' })
    assert.equal(value.read, true)
    assert.equal(Number.isFinite(value.editedAt), true)
    assert.ok(value.editedAt >= startedAt && value.editedAt <= Date.now())
    assert.deepEqual(value.to, original.to)
    assert.deepEqual(value.from, original.from)
    assert.deepEqual(value.delivery, original.delivery)

    const state = await harness.call('state', { sessionId: 's-02' })
    const listed = state.body.value.messages.find(message => message.id === id)
    assert.equal(listed.subject, 'Edited subject')
    assert.equal(listed.body, 'edited body')
    assert.deepEqual(listed.data, { n: 2, tag: 'x' })
    assert.equal(listed.editedAt, value.editedAt)
    assert.equal(listed.read, true)
    assert.deepEqual(listed.to, original.to)

    // A later body-only edit keeps data and bumps editedAt.
    const bodyOnly = await harness.call('edit', { id, sessionId: 's-02', body: 'second body' })
    assert.equal(bodyOnly.status, 200)
    assert.equal(bodyOnly.body.value.message.body, 'second body')
    assert.deepEqual(bodyOnly.body.value.message.data, { n: 2, tag: 'x' })
    assert.ok(bodyOnly.body.value.message.editedAt >= value.editedAt)
  })

  it('preserves read state when the viewer session is supplied', async () => {
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      subject: 'Viewer',
      body: 'viewer body',
      wake: false,
    })
    const id = sent.body.value.message.id
    await harness.call('read', { id, sessionId: 's-02' })

    const withViewer = await harness.call('edit', { id, sessionId: 's-02', body: 'edited with viewer' })
    assert.equal(withViewer.status, 200)
    assert.equal(withViewer.body.value.message.read, true)
    assert.equal(Number.isFinite(withViewer.body.value.message.editedAt), true)

    // Without a viewer the response filters read state for the unknown viewer,
    // but the stored per-session read flag must stay intact.
    const withoutViewer = await harness.call('edit', { id, body: 'edited without viewer' })
    assert.equal(withoutViewer.status, 200)
    assert.equal(withoutViewer.body.value.message.read, false)

    const state = await harness.call('state', { sessionId: 's-02' })
    const listed = state.body.value.messages.find(message => message.id === id)
    assert.equal(listed.body, 'edited without viewer')
    assert.equal(listed.read, true)
    assert.equal(Number.isFinite(listed.editedAt), true)
  })

  it('rejects invalid edits and fences the action', async () => {
    const sent = await harness.call('send', {
      fromSessionId: 's-01',
      to: 'session:s-02',
      subject: 'Original',
      body: 'original body',
      wake: false,
    })
    const id = sent.body.value.message.id
    const settings = (await harness.call('state', { sessionId: 's-01' })).body.value.settings

    const invalidId = await harness.call('edit', {})
    assert.equal(invalidId.status, 400)
    assert.equal(invalidId.body.error.code, 'invalid-id')
    const badId = await harness.call('edit', { id: 42, body: 'x' })
    assert.equal(badId.status, 400)
    assert.equal(badId.body.error.code, 'invalid-id')

    const empty = await harness.call('edit', { id })
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error.code, 'invalid-edit')
    const unknownKey = await harness.call('edit', { id, foo: 'x' })
    assert.equal(unknownKey.status, 400)
    assert.equal(unknownKey.body.error.code, 'invalid-edit')

    const missing = await harness.call('edit', { id: 'missing-message', body: 'x' })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error.code, 'message-not-found')

    const tooLongSubject = await harness.call('edit', {
      id,
      subject: 'x'.repeat(settings.maxSubjectChars + 1),
    })
    assert.equal(tooLongSubject.status, 400)
    assert.equal(tooLongSubject.body.error.code, 'subject-too-long')
    const tooLongBody = await harness.call('edit', {
      id,
      body: 'x'.repeat(settings.maxBodyBytes + 1),
    })
    assert.equal(tooLongBody.status, 400)
    assert.equal(tooLongBody.body.error.code, 'body-too-long')
    const tooLargeData = await harness.call('edit', {
      id,
      data: { blob: 'x'.repeat(settings.maxDataBytes + 1) },
    })
    assert.equal(tooLargeData.status, 400)
    assert.equal(tooLargeData.body.error.code, 'data-too-large')

    // Failed edits left the stored message untouched.
    const state = await harness.call('state', { sessionId: 's-02' })
    const listed = state.body.value.messages.find(message => message.id === id)
    assert.equal(listed.subject, 'Original')
    assert.equal(listed.body, 'original body')
    assert.equal(listed.editedAt, undefined)

    const noHeader = await harness.call('edit', { id, body: 'x' }, { headers: { 'x-dsh-cross-workspace': undefined } })
    assert.equal(noHeader.status, 403)
    assert.equal(noHeader.body.error.code, 'forbidden')
    const get = await harness.call('edit', { id }, { method: 'GET', bodyText: '' })
    assert.equal(get.status, 405)
  })
})

describe('workspace broadcast privacy', () => {
  it('gates broadcasts behind allowWorkspaceBroadcast', async () => {
    const local = await boot({ settings: { allowWorkspaceBroadcast: false } })
    try {
      const settings = (await local.call('state', { sessionId: 's-01' })).body.value.settings
      assert.equal(settings.allowWorkspaceBroadcast, false)

      const blocked = await local.call('send', {
        fromSessionId: 's-01',
        to: 'Alpha',
        subject: 'Blocked broadcast',
        body: 'should not go out',
        wake: false,
      })
      assert.equal(blocked.status, 400)
      assert.equal(blocked.body.error.code, 'broadcast-disabled')
      assert.equal((await local.call('state', { sessionId: 's-01' })).body.value.messages.length, 0)

      const enabled = await local.call('settings', { patch: { allowWorkspaceBroadcast: true } })
      assert.equal(enabled.status, 200)
      assert.equal(enabled.body.value.settings.allowWorkspaceBroadcast, true)
      const sent = await local.call('send', {
        fromSessionId: 's-02',
        to: 'Alpha',
        subject: 'Allowed broadcast',
        body: 'now visible',
        wake: false,
      })
      assert.equal(sent.status, 200)
      const visible = await local.call('state', { sessionId: 's-01' })
      assert.equal(visible.body.value.messages.length, 1)
      assert.equal(visible.body.value.messages[0].id, sent.body.value.message.id)
      assert.equal(visible.body.value.unreadTotal, 1)

      // Turning the setting off hides the stored broadcast again.
      await local.call('settings', { patch: { allowWorkspaceBroadcast: false } })
      const hidden = await local.call('state', { sessionId: 's-01' })
      assert.equal(hidden.body.value.messages.length, 0)
      assert.equal(hidden.body.value.unreadTotal, 0)
      const management = await local.call('state', { filter: 'all' })
      assert.equal(
        management.body.value.workspaces.find(workspace => workspace.path === local.wsAlpha).unread,
        0,
      )

      await local.call('settings', { patch: { allowWorkspaceBroadcast: true } })
      assert.equal((await local.call('state', { sessionId: 's-01' })).body.value.messages.length, 1)
    } finally {
      await local.destroy()
    }
  })
})
