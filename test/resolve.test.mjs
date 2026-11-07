/**
 * Unit tests for lib/resolve.js — workspace/session index and mail addressing.
 *
 * All directories are real directories inside a mkdtemp sandbox so the
 * default `existsSync` path behaves like production; the injected `exists`
 * function is exercised explicitly where the test needs a synthetic result.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { canonicalPath } from '../lib/store.js'
import {
  TargetError,
  buildIndex,
  isListableSession,
  pickWakeSession,
  resolveTarget,
  titleOf,
  viewerFor,
  wakeSessionFor,
  workspaceForCwd,
} from '../lib/resolve.js'

let root
let wsAlpha
let wsBeta
let wsGamma
let wsGhost
let wsDupA
let wsDupB
let wsPreA
let wsPreB

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-xw-resolve-'))
  wsAlpha = join(root, 'alpha')
  wsBeta = join(root, 'beta')
  wsGamma = join(root, 'gamma')
  wsGhost = join(root, 'ghost')
  wsDupA = join(root, 'dup-a')
  wsDupB = join(root, 'dup-b')
  wsPreA = join(root, 'pre-a')
  wsPreB = join(root, 'pre-b')
  for (const directory of [wsAlpha, wsBeta, wsGamma, wsDupA, wsDupB, wsPreA, wsPreB]) {
    await mkdir(directory, { recursive: true })
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeCtx({ workspaces = [], summaries = [], titles = {}, live = {}, liveTitles = {}, archivedSessionIds = undefined } = {}) {
  const calls = { list: [], titles: [], resolveAgent: [] }
  const services = {
    workspaceRegistry: {
      list: () => workspaces,
      ...(archivedSessionIds === undefined ? {} : { archivedSessionIds }),
    },
    sessionController: {
      list: async (options, signal) => {
        calls.list.push({ options, signal })
        return { items: summaries }
      },
      resolveAgent: async (sessionId) => {
        calls.resolveAgent.push(sessionId)
        return { agent: undefined }
      },
    },
    sessionQuery: {
      readTitleSnapshots: async (sessionIds, signal) => {
        calls.titles.push({ ids: [...sessionIds], signal })
        // Mirrors the real Host sessionQuery shape:
        //   { sessionId, status, value: { session, title: TitleSnapshot } }
        // where TitleSnapshot.title is the accepted title string.
        return sessionIds.map(sessionId => (
          titles[sessionId] === undefined
            ? { sessionId, status: 'rejected', reason: new Error('no snapshot') }
            : {
                sessionId,
                status: 'fulfilled',
                value: {
                  session: { id: sessionId },
                  title: {
                    title: titles[sessionId],
                    messageSeqs: [1],
                    source: { kind: 'fallback' },
                    eventSeq: 1,
                    updatedAt: 1,
                  },
                },
              }
        ))
      },
    },
    sessions: { get: sessionId => live[sessionId] },
    sessionTitle: {
      get: session => (
        session === undefined || liveTitles[session.id] === undefined
          ? undefined
          : { title: liveTitles[session.id] }
      ),
    },
  }
  return { get: name => services[name], calls }
}

function defaultFixture() {
  return {
    workspaces: [
      { id: 'w-alpha', path: wsAlpha, title: 'Alpha Project', sessionIds: ['s-alpha-1'] },
      { id: 'w-beta', path: wsBeta, title: 'Beta Docs', sessionIds: ['s-beta-1'] },
      { id: 'w-dup-a', path: wsDupA, title: 'Dup Title', sessionIds: [] },
      { id: 'w-dup-b', path: wsDupB, title: 'Dup Title', sessionIds: [] },
      { id: 'w-pre-a', path: wsPreA, title: 'Project One', sessionIds: [] },
      { id: 'w-pre-b', path: wsPreB, title: 'Project Two', sessionIds: [] },
    ],
    summaries: [
      { sessionId: 's-alpha-1', cwd: wsAlpha, updatedAt: 100, running: false, blank: false },
      { sessionId: 's-beta-1', cwd: wsBeta, updatedAt: 200, running: false, blank: false },
      { sessionId: 's-orphan', cwd: wsGamma, updatedAt: 300, running: false, blank: false },
      { sessionId: 's-title', cwd: wsGamma, updatedAt: 400, running: false, blank: false },
      { sessionId: 's-deploy-a', cwd: wsGamma, updatedAt: 500, running: false, blank: false },
      { sessionId: 's-deploy-b', cwd: wsGamma, updatedAt: 600, running: false, blank: false },
      { sessionId: 's-sub', cwd: wsAlpha, updatedAt: 700, running: false, blank: false, origin: 'subagent' },
    ],
    titles: {
      's-alpha-1': 'Alpha Worker',
      's-beta-1': 'Beta Worker',
      's-orphan': 'Orphan Worker',
      's-title': 'Unique Session Title',
      's-deploy-a': 'Deploy A',
      's-deploy-b': 'Deploy B',
    },
  }
}

async function defaultIndex() {
  return buildIndex(makeCtx(defaultFixture()))
}

describe('buildIndex', () => {
  it('unions registry sessionIds with cwd matches, sorts and filters subagents', async () => {
    const fixture = {
      workspaces: [{ id: 'w', path: wsAlpha, title: 'Union WS', sessionIds: ['s-1', 's-2'] }],
      summaries: [
        // Registry member even though its cwd points elsewhere.
        { sessionId: 's-1', cwd: wsBeta, updatedAt: 100, running: false, blank: false },
        // Registry member that also matches by cwd must not be listed twice.
        { sessionId: 's-2', cwd: wsAlpha, updatedAt: 200, running: true, blank: false },
        // Not registered: attaches through its cwd.
        { sessionId: 's-3', cwd: wsAlpha, updatedAt: 50, running: false, blank: false },
        // Outside every workspace.
        { sessionId: 's-4', cwd: wsGamma, updatedAt: 400, running: false, blank: false },
        // Subagent sessions never enter the index.
        { sessionId: 's-sub', cwd: wsAlpha, updatedAt: 900, running: true, blank: false, origin: 'subagent' },
      ],
      titles: { 's-1': 'One', 's-2': 'Two', 's-3': 'Three', 's-4': 'Four' },
    }
    const ctx = makeCtx(fixture)
    const index = await buildIndex(ctx)

    assert.equal(index.workspaces.length, 1)
    const workspace = index.workspaces[0]
    assert.equal(workspace.title, 'Union WS')
    assert.equal(workspace.exists, true)
    // Running first, then newest; s-2 appears once despite two membership paths.
    assert.deepEqual(workspace.sessions.map(record => record.sessionId), ['s-2', 's-1', 's-3'])
    assert.equal(workspace.sessions.find(record => record.sessionId === 's-2').title, 'Two')
    assert.equal(workspace.sessions.find(record => record.sessionId === 's-1').title, 'One')
    assert.equal(index.byPath.get(canonicalPath(wsAlpha)), workspace)
    assert.equal(index.sessions.has('s-sub'), false)
    assert.deepEqual(index.orphans.map(record => record.sessionId), ['s-4'])
    assert.ok(index.generatedAt > 0)
    // The controller list call receives an abort signal.
    assert.equal(ctx.calls.list.length, 1)
    assert.ok(ctx.calls.list[0].signal === undefined || typeof ctx.calls.list[0].signal === 'object')
  })

  it('prefers live session titles and falls back to title snapshots', async () => {
    const ctx = makeCtx({
      workspaces: [{ path: wsAlpha, title: 'Titles', sessionIds: ['s-live', 's-snap'] }],
      summaries: [
        { sessionId: 's-live', cwd: wsAlpha, updatedAt: 1, running: false },
        { sessionId: 's-snap', cwd: wsAlpha, updatedAt: 2, running: false },
      ],
      titles: { 's-live': 'Snapshot Live', 's-snap': 'Snapshot Only' },
      live: { 's-live': { id: 's-live' } },
      liveTitles: { 's-live': 'Live Title' },
    })
    const index = await buildIndex(ctx)
    assert.equal(index.sessions.get('s-live').title, 'Live Title')
    assert.equal(index.sessions.get('s-snap').title, 'Snapshot Only')
    // Only sessions without a live title are asked for a snapshot.
    assert.deepEqual(ctx.calls.titles.at(-1).ids, ['s-snap'])
  })

  it('reports directory existence from the injected exists function', async () => {
    const workspaces = [
      { path: wsAlpha, title: 'Existing', sessionIds: [] },
      { path: wsGhost, title: 'Missing', sessionIds: [] },
      { path: join(root, 'untitled'), title: '   ', sessionIds: [] },
    ]
    const index = await buildIndex(makeCtx({ workspaces, summaries: [], titles: {} }))
    const existing = index.workspaces.find(workspace => workspace.title === 'Existing')
    const missing = index.workspaces.find(workspace => workspace.title === 'Missing')
    assert.equal(existing.exists, true)
    assert.equal(missing.exists, false)
    // Empty titles fall back to the directory name.
    const untitled = index.workspaces.find(workspace => workspace.title === 'untitled')
    assert.equal(untitled.title, basename(join(root, 'untitled')))

    const injected = await buildIndex(makeCtx({ workspaces, summaries: [], titles: {} }), {
      exists: path => path === wsGhost,
    })
    assert.equal(injected.workspaces.find(workspace => workspace.title === 'Missing').exists, true)
    assert.equal(injected.workspaces.find(workspace => workspace.title === 'Existing').exists, false)
  })

  it('degrades gracefully without Harness services', async () => {
    const empty = await buildIndex(undefined)
    assert.deepEqual(empty.workspaces, [])
    assert.equal(empty.sessions.size, 0)
    assert.deepEqual(empty.orphans, [])
    assert.equal(empty.byPath.size, 0)

    const throwing = {
      get: name => (name === 'sessionController'
        ? { list: async () => { throw new Error('boom') } }
        : undefined),
    }
    const index = await buildIndex(throwing)
    assert.deepEqual(index.workspaces, [])
    assert.equal(index.sessions.size, 0)
  })

  it('does not put cwd-less sessions into workspaces or orphans', async () => {
    const index = await buildIndex(makeCtx({
      workspaces: [{ path: wsAlpha, title: 'Alpha', sessionIds: [] }],
      summaries: [{ sessionId: 's-no-cwd', updatedAt: 1, running: false, blank: false }],
      titles: {},
    }))
    assert.equal(index.sessions.has('s-no-cwd'), true)
    assert.deepEqual(index.workspaces[0].sessions, [])
    assert.deepEqual(index.orphans, [])
  })

  it('marks archived sessions and classifies listable sessions', async () => {
    const index = await buildIndex(makeCtx({
      workspaces: [{ path: wsAlpha, title: 'Alpha', sessionIds: ['s-engaged', 's-blank', 's-archived', 's-stale'] }],
      summaries: [
        { sessionId: 's-engaged', cwd: wsAlpha, updatedAt: 300, running: false, blank: false },
        { sessionId: 's-blank', cwd: wsAlpha, updatedAt: 200, running: false, blank: true },
        { sessionId: 's-archived', cwd: wsAlpha, updatedAt: 100, running: false, blank: false },
      ],
      titles: { 's-engaged': 'Engaged', 's-archived': 'Archived' },
      archivedSessionIds: ['s-archived'],
    }))

    const engaged = index.sessions.get('s-engaged')
    const blank = index.sessions.get('s-blank')
    const archived = index.sessions.get('s-archived')
    assert.equal(engaged.archived, false)
    assert.equal(blank.archived, false)
    assert.equal(archived.archived, true)
    assert.equal(isListableSession(engaged), true)
    assert.equal(isListableSession(blank), false)
    assert.equal(isListableSession(archived), false)
    assert.equal(isListableSession(undefined), false)
    assert.equal(isListableSession(null), false)
    assert.equal(isListableSession({ sessionId: 'stale', unknown: true }), false)

    // index.sessions keeps every known conversation (explicit ids stay
    // addressable); filtering happens at the list/presentation layer.
    assert.equal(index.workspaces[0].sessions.length, 4)
    const stalePlaceholder = index.workspaces[0].sessions.find(record => record.sessionId === 's-stale')
    assert.ok(stalePlaceholder)
    assert.equal(stalePlaceholder.unknown, true)
    assert.equal(isListableSession(stalePlaceholder), false)
    // A stale registry id has no live summary, so it is not addressable at all.
    assert.equal(index.sessions.has('s-stale'), false)
    assert.throws(
      () => resolveTarget(index, { to: 'session:s-stale' }),
      error => error.code === 'session-not-found',
    )

    const archivedTarget = resolveTarget(index, { to: 'session:s-archived' })
    assert.equal(archivedTarget.kind, 'session')
    assert.equal(archivedTarget.session.sessionId, 's-archived')
    const blankTarget = resolveTarget(index, { to: 'session:s-blank' })
    assert.equal(blankTarget.kind, 'session')
    assert.equal(blankTarget.session.sessionId, 's-blank')
  })
})

describe('resolveTarget', () => {
  it('resolves absolute paths, exact titles, unique title prefixes and prefixes', async () => {
    const index = await defaultIndex()

    const byPath = resolveTarget(index, { to: wsAlpha })
    assert.equal(byPath.kind, 'workspace')
    assert.equal(byPath.workspace.path, wsAlpha)
    assert.equal(byPath.workspace.title, 'Alpha Project')

    const byTitle = resolveTarget(index, { to: 'Alpha Project' })
    assert.equal(byTitle.kind, 'workspace')
    assert.equal(byTitle.workspace.path, wsAlpha)

    const byPrefix = resolveTarget(index, { to: 'Alpha Pro' })
    assert.equal(byPrefix.workspace.path, wsAlpha)

    const explicitWorkspace = resolveTarget(index, { to: `workspace:${wsAlpha}` })
    assert.equal(explicitWorkspace.workspace.path, wsAlpha)

    const bySessionId = resolveTarget(index, { to: 's-beta-1' })
    assert.equal(bySessionId.kind, 'session')
    assert.equal(bySessionId.session.sessionId, 's-beta-1')
    assert.equal(bySessionId.workspace.path, wsBeta)

    const explicitSession = resolveTarget(index, { to: 'session:s-alpha-1' })
    assert.equal(explicitSession.kind, 'session')
    assert.equal(explicitSession.session.sessionId, 's-alpha-1')
  })

  it('honours toSessionId over a workspace `to`', async () => {
    const index = await defaultIndex()
    const override = resolveTarget(index, { to: 'Alpha Project', toSessionId: 's-beta-1' })
    assert.equal(override.kind, 'session')
    assert.equal(override.session.sessionId, 's-beta-1')
    assert.equal(override.workspace.path, wsBeta)

    assert.throws(
      () => resolveTarget(index, { to: 'Alpha Project', toSessionId: 's-missing' }),
      error => error instanceof TargetError && error.code === 'session-not-found',
    )
  })

  it('matches session titles by exact value and unique prefix', async () => {
    const index = await defaultIndex()
    const exact = resolveTarget(index, { to: 'Unique Session Title' })
    assert.equal(exact.kind, 'session')
    assert.equal(exact.session.sessionId, 's-title')
    const uniquePrefix = resolveTarget(index, { to: 'Unique' })
    assert.equal(uniquePrefix.session.sessionId, 's-title')
  })

  it('reports ambiguity with candidates for titles and prefixes', async () => {
    const index = await defaultIndex()

    assert.throws(
      () => resolveTarget(index, { to: 'Dup Title' }),
      (error) => {
        assert.ok(error instanceof TargetError)
        assert.equal(error.code, 'ambiguous')
        assert.equal(error.candidates.length, 2)
        return true
      },
    )
    assert.throws(
      () => resolveTarget(index, { to: 'Project' }),
      (error) => {
        assert.equal(error.code, 'ambiguous')
        assert.equal(error.candidates.length, 2)
        return true
      },
    )
    assert.throws(
      () => resolveTarget(index, { to: 'Deploy' }),
      (error) => {
        assert.equal(error.code, 'ambiguous')
        assert.equal(error.candidates.length, 2)
        assert.ok(error.candidates.every(candidate => candidate.startsWith('session:')))
        return true
      },
    )
  })

  it('errors on missing and invalid targets with actionable candidates', async () => {
    const index = await defaultIndex()

    assert.throws(
      () => resolveTarget(index, { to: 'session:missing' }),
      (error) => {
        assert.equal(error.code, 'session-not-found')
        assert.ok(error.candidates.length > 0)
        return true
      },
    )
    assert.throws(
      () => resolveTarget(index, { to: 'no-such-target' }),
      (error) => {
        assert.equal(error.code, 'target-not-found')
        assert.ok(error.candidates.some(candidate => candidate.startsWith('workspace:')))
        assert.ok(error.candidates.some(candidate => candidate.startsWith('session:')))
        return true
      },
    )
    for (const to of ['', '   ', null, undefined, 'workspace:   ', 'session:   ']) {
      assert.throws(
        () => resolveTarget(index, { to }),
        error => error instanceof TargetError && error.code === 'invalid',
        `expected invalid for ${JSON.stringify(to)}`,
      )
    }
  })

  it('builds a synthetic workspace for an existing unregistered directory', async () => {
    const index = await defaultIndex()

    // On-disk directory that is not in the workspace registry is still addressable.
    const synthetic = resolveTarget(index, { to: wsGamma })
    assert.equal(synthetic.kind, 'workspace')
    assert.equal(synthetic.workspace.path, resolve(wsGamma))
    assert.equal(synthetic.workspace.exists, true)
    assert.deepEqual(
      synthetic.workspace.sessions.map(record => record.sessionId).sort(),
      ['s-deploy-a', 's-deploy-b', 's-orphan', 's-title'],
    )

    // Injected exists() can vouch for a directory that does not exist on disk.
    const fresh = join(root, 'fresh-injected')
    const injected = resolveTarget(index, { to: fresh, exists: () => true })
    assert.equal(injected.kind, 'workspace')
    assert.equal(injected.workspace.path, resolve(fresh))

    // A missing, unregistered directory is not a target.
    assert.throws(
      () => resolveTarget(index, { to: wsGhost }),
      error => error.code === 'target-not-found',
    )

    // workspace:<relative> resolves against the sender cwd.
    const relative = resolveTarget(index, {
      to: 'workspace:child',
      fromCwd: wsAlpha,
      exists: candidate => candidate === resolve(wsAlpha, 'child'),
    })
    assert.equal(relative.kind, 'workspace')
    assert.equal(relative.workspace.path, resolve(wsAlpha, 'child'))
    assert.equal(relative.workspace.title, 'child')
  })
})

describe('wake selection and helpers', () => {
  it('pickWakeSession prefers engaged idle sessions, then the most recently active', () => {
    const workspace = {
      sessions: [
        { sessionId: 'blank-newest', updatedAt: 1000, blank: true, running: false },
        { sessionId: 'engaged-older', updatedAt: 500, blank: false, running: false },
        { sessionId: 'engaged-newer', updatedAt: 800, blank: false, running: false },
        { sessionId: 'unknown-record', updatedAt: 2000, blank: false, unknown: true },
      ],
    }
    assert.equal(pickWakeSession(workspace).sessionId, 'engaged-newer')
    // A blank "New Session" is never woken automatically.
    assert.equal(pickWakeSession({
      sessions: [
        { sessionId: 'engaged', blank: false, updatedAt: 1 },
        { sessionId: 'blank', blank: true, updatedAt: 99 },
      ],
    }).sessionId, 'engaged')
    // All-blank workspace has no listable wake target.
    assert.equal(pickWakeSession({
      sessions: [
        { sessionId: 'blank-a', blank: true, updatedAt: 1 },
        { sessionId: 'blank-b', blank: true, updatedAt: 2 },
      ],
    }), undefined)
    // Archived sessions are never woken, even when most recent.
    assert.equal(pickWakeSession({
      sessions: [
        { sessionId: 'archived', blank: false, archived: true, running: false, updatedAt: 100 },
        { sessionId: 'engaged', blank: false, running: false, updatedAt: 1 },
      ],
    }).sessionId, 'engaged')
    // Stale registry placeholders (unknown:true) are never woken either.
    assert.equal(pickWakeSession({
      sessions: [
        { sessionId: 'stale', blank: false, unknown: true, running: false, updatedAt: 99 },
        { sessionId: 'engaged', blank: false, running: false, updatedAt: 1 },
      ],
    }).sessionId, 'engaged')
    assert.equal(pickWakeSession({
      sessions: [{ sessionId: 'stale-only', blank: false, unknown: true, running: false, updatedAt: 1 }],
    }), undefined)
    // An idle session is preferred over a running one, then recency decides.
    assert.equal(pickWakeSession({
      sessions: [
        { sessionId: 'running-newer', blank: false, running: true, updatedAt: 99 },
        { sessionId: 'idle-older', blank: false, running: false, updatedAt: 1 },
      ],
    }).sessionId, 'idle-older')
    assert.equal(pickWakeSession({ sessions: [] }), undefined)
    assert.equal(pickWakeSession(undefined), undefined)
  })

  it('pickWakeSession(workspace, excludeSessionId) skips the sender', () => {
    const workspace = {
      sessions: [
        { sessionId: 'sender', blank: false, running: false, updatedAt: 100 },
        { sessionId: 'peer-idle', blank: false, running: false, updatedAt: 50 },
        { sessionId: 'peer-running', blank: false, running: true, updatedAt: 90 },
      ],
    }
    // The excluded session is never returned while another engaged session exists.
    assert.equal(pickWakeSession(workspace, 'sender').sessionId, 'peer-idle')
    // Without the sender, the remaining idle session beats the running one.
    assert.equal(pickWakeSession(workspace, 'peer-idle').sessionId, 'sender')
    // Unknown exclusion ids are ignored; idle still wins over running.
    assert.equal(pickWakeSession(workspace, 'not-a-member').sessionId, 'sender')
    assert.equal(pickWakeSession(workspace).sessionId, 'sender')

    // Only non-blank session is the sender: nothing to wake.
    assert.equal(pickWakeSession({
      sessions: [{ sessionId: 'only', blank: false, running: false, updatedAt: 1 }],
    }, 'only'), undefined)

    // Blank sessions are never in the fallback pool, even when the sender is excluded.
    assert.equal(pickWakeSession({
      sessions: [
        { sessionId: 'sender', blank: false, running: false, updatedAt: 1 },
        { sessionId: 'new-session', blank: true, running: false, updatedAt: 2 },
      ],
    }, 'sender'), undefined)

    // Archived peers are not woken either.
    assert.equal(pickWakeSession({
      sessions: [
        { sessionId: 'sender', blank: false, running: false, updatedAt: 1 },
        { sessionId: 'archived-peer', blank: false, archived: true, running: false, updatedAt: 2 },
      ],
    }, 'sender'), undefined)
  })

  it('wakeSessionFor, workspaceForCwd, viewerFor and titleOf behave as documented', async () => {
    const index = await defaultIndex()

    const workspaceTarget = resolveTarget(index, { to: 'Alpha Project' })
    assert.equal(wakeSessionFor(workspaceTarget).sessionId, 's-alpha-1')
    const sessionTarget = resolveTarget(index, { to: 'session:s-beta-1' })
    assert.equal(wakeSessionFor(sessionTarget).sessionId, 's-beta-1')
    assert.equal(wakeSessionFor(undefined), undefined)

    assert.equal(workspaceForCwd(index, wsAlpha).title, 'Alpha Project')
    assert.equal(workspaceForCwd(index, undefined), undefined)
    assert.equal(workspaceForCwd(index, ''), undefined)

    assert.deepEqual(viewerFor(index, { sessionId: 's-alpha-1' }), {
      sessionId: 's-alpha-1',
      workspacePath: wsAlpha,
    })
    assert.deepEqual(viewerFor(index, { workspacePath: wsAlpha }), { workspacePath: wsAlpha })

    assert.equal(titleOf({ title: '  A title  ' }), 'A title')
    assert.equal(titleOf({ title: '   ' }), undefined)
    assert.equal(titleOf(undefined), undefined)
  })
})

describe('group addressing', () => {
  function groupFixtures() {
    return [
      { id: 'g-team-one', name: 'Team One', sessionIds: ['s-alpha-1'], createdAt: 1, updatedAt: 1 },
      { id: 'g-team-two', name: 'Team Two', sessionIds: ['s-beta-1'], createdAt: 2, updatedAt: 2 },
      { id: 'g-deploy-a', name: 'Deploy Alpha', sessionIds: [], createdAt: 3, updatedAt: 3 },
      { id: 'g-deploy-b', name: 'Deploy Beta', sessionIds: [], createdAt: 4, updatedAt: 4 },
      { id: 'g-dup-a', name: 'Dup Group', sessionIds: [], createdAt: 5, updatedAt: 5 },
      { id: 'g-dup-b', name: 'Dup Group', sessionIds: [], createdAt: 6, updatedAt: 6 },
      { id: 'g-workspace-name', name: 'Alpha Project', sessionIds: [], createdAt: 7, updatedAt: 7 },
    ]
  }

  it('resolves groups by id, exact name, unique prefix and group: prefix', async () => {
    const index = await defaultIndex()
    const groups = groupFixtures()

    const byId = resolveTarget(index, { to: 'g-team-one', groups })
    assert.equal(byId.kind, 'group')
    assert.equal(byId.group.id, 'g-team-one')
    assert.equal(byId.group.name, 'Team One')

    const byName = resolveTarget(index, { to: 'Team One', groups })
    assert.equal(byName.kind, 'group')
    assert.equal(byName.group.id, 'g-team-one')

    const byPrefix = resolveTarget(index, { to: 'Team O', groups })
    assert.equal(byPrefix.kind, 'group')
    assert.equal(byPrefix.group.id, 'g-team-one')

    const explicitName = resolveTarget(index, { to: 'group:Team Two', groups })
    assert.equal(explicitName.kind, 'group')
    assert.equal(explicitName.group.id, 'g-team-two')

    const explicitId = resolveTarget(index, { to: 'group:g-team-two', groups })
    assert.equal(explicitId.group.id, 'g-team-two')

    const explicitPrefix = resolveTarget(index, { to: 'group:Team T', groups })
    assert.equal(explicitPrefix.group.id, 'g-team-two')

    // Without the groups list the same expression is not found.
    assert.throws(
      () => resolveTarget(index, { to: 'Team One' }),
      error => error.code === 'target-not-found',
    )
  })

  it('reports ambiguous and missing groups with candidates', async () => {
    const index = await defaultIndex()
    const groups = groupFixtures()

    assert.throws(
      () => resolveTarget(index, { to: 'Deploy', groups }),
      (error) => {
        assert.equal(error.code, 'ambiguous')
        assert.equal(error.candidates.length, 2)
        assert.ok(error.candidates.every(candidate => candidate.startsWith('group:')))
        return true
      },
    )
    assert.throws(
      () => resolveTarget(index, { to: 'Dup Group', groups }),
      (error) => {
        assert.equal(error.code, 'ambiguous')
        assert.equal(error.candidates.length, 2)
        return true
      },
    )
    assert.throws(
      () => resolveTarget(index, { to: 'group:Nowhere', groups }),
      (error) => {
        assert.equal(error.code, 'group-not-found')
        assert.ok(error.candidates.some(candidate => candidate.startsWith('group:')))
        return true
      },
    )
    assert.throws(
      () => resolveTarget(index, { to: 'Nowhere Z', groups }),
      (error) => {
        assert.equal(error.code, 'target-not-found')
        assert.ok(error.candidates.some(candidate => candidate.startsWith('group:')))
        return true
      },
    )
  })

  it('keeps the documented precedence between sessions, groups and workspaces', async () => {
    const index = await defaultIndex()
    const groups = groupFixtures()

    // Exact session id wins over a same-named group.
    const sessionWins = resolveTarget(index, {
      to: 's-alpha-1',
      groups: [...groups, { id: 'g-session-name', name: 's-alpha-1', sessionIds: [] }],
    })
    assert.equal(sessionWins.kind, 'session')
    assert.equal(sessionWins.session.sessionId, 's-alpha-1')

    // Exact group name wins over a same-named workspace title in auto mode...
    const groupWins = resolveTarget(index, { to: 'Alpha Project', groups })
    assert.equal(groupWins.kind, 'group')
    assert.equal(groupWins.group.id, 'g-workspace-name')

    // ...but the explicit workspace: prefix forces workspace resolution.
    const forcedWorkspace = resolveTarget(index, { to: 'workspace:Alpha Project', groups })
    assert.equal(forcedWorkspace.kind, 'workspace')
    assert.equal(forcedWorkspace.workspace.path, wsAlpha)

    // And an exact session title is only consulted after group names.
    const groupBeatsSessionTitle = resolveTarget(index, {
      to: 'Unique Session Title',
      groups: [...groups, { id: 'g-session-title', name: 'Unique Session Title', sessionIds: [] }],
    })
    assert.equal(groupBeatsSessionTitle.kind, 'group')
  })
})
