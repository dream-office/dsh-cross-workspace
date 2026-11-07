/**
 * Workspace / session discovery and mail addressing.
 *
 * `buildIndex` reads the live Harness services (workspace registry, session
 * controller, title query) and flattens them into a small index. All functions
 * here are Harness-optional: a missing service simply produces a smaller index,
 * so the store, tools and panel keep working in reduced compositions.
 */
import { existsSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { canonicalPath } from './store.js'

export class TargetError extends Error {
  constructor(code, message, candidates = []) {
    super(message)
    this.name = 'TargetError'
    this.code = code
    this.candidates = candidates
  }
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

function byUpdatedDesc(left, right) {
  const running = (right.running === true ? 1 : 0) - (left.running === true ? 1 : 0)
  if (running !== 0) return running
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
}

export function isPathLike(value) {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith('~')
}

function expandHome(value) {
  if (!value.startsWith('~')) return value
  const home = process.env.USERPROFILE || process.env.HOME
  return home === undefined ? value : resolve(home, value.slice(1).replace(/^[\\/]/, ''))
}

/** Build a compact index of registered workspaces and visible sessions. */
export async function buildIndex(ctx, options = {}) {
  const signal = options.signal
  const exists = typeof options.exists === 'function' ? options.exists : existsSync
  const now = typeof options.now === 'function' ? options.now : Date.now
  const registry = readService(ctx, 'workspaceRegistry')
  let registered = []
  try {
    registered = registry?.list?.() ?? []
  } catch {
    registered = []
  }

  const controller = readService(ctx, 'sessionController')
  let summaries = []
  if (typeof controller?.list === 'function') {
    try {
      const value = await controller.list({}, signal ?? AbortSignal.timeout(5000))
      if (Array.isArray(value?.items)) summaries = value.items
    } catch {
      summaries = []
    }
  }

  // The registry keeps the durable archive set (the same set the Workspace UI
  // reads); archived Sessions must not surface as addressable conversations.
  const archivedIds = new Set()
  try {
    const archived = registry?.archivedSessionIds
    if (Array.isArray(archived)) for (const id of archived) archivedIds.add(String(id))
  } catch {
    // optional projection
  }

  const sessions = new Map()
  for (const summary of summaries) {
    if (summary === null || typeof summary !== 'object') continue
    if (typeof summary.sessionId !== 'string' || summary.sessionId.length === 0) continue
    if (summary.origin === 'subagent') continue
    sessions.set(summary.sessionId, {
      sessionId: summary.sessionId,
      cwd: typeof summary.cwd === 'string' ? summary.cwd : undefined,
      updatedAt: Number.isFinite(summary.updatedAt) ? summary.updatedAt : 0,
      running: summary.running === true,
      blank: summary.blank === true,
      archived: archivedIds.has(summary.sessionId),
      title: undefined,
    })
  }

  // The live session title service is cheap for live sessions; use it first.
  const titleService = readService(ctx, 'sessionTitle')
  const sessionsService = readService(ctx, 'sessions')
  if (titleService !== undefined && sessionsService?.get !== undefined) {
    for (const record of sessions.values()) {
      try {
        const live = sessionsService.get(record.sessionId)
        if (live !== undefined) {
          const title = titleService.get?.(live)?.title
          if (typeof title === 'string' && title.length > 0) record.title = title
        }
      } catch {
        // ignore one malformed session
      }
    }
  }

  const query = readService(ctx, 'sessionQuery')
  const missingTitle = [...sessions.values()].filter(record => record.title === undefined).map(record => record.sessionId)
  if (typeof query?.readTitleSnapshots === 'function' && missingTitle.length > 0) {
    try {
      const results = await query.readTitleSnapshots(missingTitle, signal)
      if (Array.isArray(results)) {
        for (const result of results) {
          if (result?.status !== 'fulfilled') continue
          const title = result.value?.title?.title
          if (typeof title === 'string' && title.length > 0) {
            const record = sessions.get(result.sessionId)
            if (record !== undefined) record.title = title
          }
        }
      }
    } catch {
      // titles are a display nicety; never fail the index for them
    }
  }

  const workspaces = []
  const byPath = new Map()
  for (const workspace of registered) {
    if (workspace === null || typeof workspace !== 'object') continue
    if (typeof workspace.path !== 'string' || workspace.path.length === 0) continue
    const key = canonicalPath(workspace.path)
    if (byPath.has(key)) continue
    const members = []
    const seen = new Set()
    let registryIds = []
    try {
      registryIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    } catch {
      registryIds = []
    }
    for (const sessionId of registryIds) {
      if (typeof sessionId !== 'string' || seen.has(sessionId)) continue
      seen.add(sessionId)
      const record = sessions.get(sessionId)
      if (record !== undefined) {
        members.push(record)
      } else {
        members.push({
          sessionId,
          cwd: workspace.path,
          updatedAt: 0,
          running: false,
          blank: false,
          archived: archivedIds.has(sessionId),
          title: undefined,
          unknown: true,
        })
      }
    }
    for (const record of sessions.values()) {
      if (record.sessionId === undefined || seen.has(record.sessionId)) continue
      if (record.cwd === undefined) continue
      if (canonicalPath(record.cwd) !== key) continue
      seen.add(record.sessionId)
      members.push(record)
    }
    members.sort(byUpdatedDesc)
    const entry = {
      workspaceId: typeof workspace.id === 'string' ? workspace.id : undefined,
      path: workspace.path,
      canonicalPath: key,
      title: typeof workspace.title === 'string' && workspace.title.trim().length > 0
        ? workspace.title.trim()
        : basename(workspace.path),
      exists: safeExists(exists, workspace.path),
      sessions: members,
    }
    workspaces.push(entry)
    byPath.set(key, entry)
  }

  const attached = new Set()
  for (const workspace of workspaces) for (const record of workspace.sessions) attached.add(record.sessionId)
  const orphans = [...sessions.values()].filter(record => !attached.has(record.sessionId) && record.cwd !== undefined)

  return { workspaces, sessions, byPath, orphans, generatedAt: now() }
}

function safeExists(exists, path) {
  try {
    return exists(path) === true
  } catch {
    return false
  }
}

/** Find the registered workspace owning a directory, if any. */
export function workspaceForCwd(index, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  return index?.byPath?.get(canonicalPath(cwd))
}

/** Session title fallback used by tools and delivery text. */
export function titleOf(session) {
  return typeof session?.title === 'string' && session.title.trim().length > 0 ? session.title.trim() : undefined
}

/** A conversation worth listing: engaged, not archived, and known to the live registry. */
export function isListableSession(record) {
  return record !== null && record !== undefined
    && record.blank !== true
    && record.archived !== true
    && record.unknown !== true
}

/**
 * Pick a wake target: preferably an idle, engaged, recently active session.
 * Blank and archived sessions are not addressable conversations.
 */
export function pickWakeSession(workspace, excludeSessionId = undefined) {
  const candidates = (workspace?.sessions ?? [])
    .filter(record => record?.unknown !== true)
    .filter(isListableSession)
    .filter(record => typeof excludeSessionId !== 'string' || record.sessionId !== excludeSessionId)
  if (candidates.length === 0) return undefined
  return [...candidates].sort((left, right) => {
    const leftRunning = left.running === true ? 1 : 0
    const rightRunning = right.running === true ? 1 : 0
    if (leftRunning !== rightRunning) return leftRunning - rightRunning
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  })[0]
}

function normalizePrefix(to) {
  const text = String(to ?? '').trim().replace(/^["'`]|["'`]$/g, '')
  const lower = text.toLowerCase()
  if (lower.startsWith('workspace:')) return { kind: 'workspace', value: text.slice('workspace:'.length).trim() }
  if (lower.startsWith('session:')) return { kind: 'session', value: text.slice('session:'.length).trim() }
  if (lower.startsWith('group:')) return { kind: 'group', value: text.slice('group:'.length).trim() }
  return { kind: 'auto', value: text }
}

function sessionLookup(index, wanted) {
  const direct = index.sessions.get(wanted)
  if (direct !== undefined) return direct
  // Session ids are UUID-ish; tolerate case differences from copied text.
  const lowered = wanted.toLowerCase()
  for (const record of index.sessions.values()) {
    if (record.sessionId.toLowerCase() === lowered) return record
  }
  return undefined
}

function workspaceLookup(index, wanted) {
  const directKey = safeCanonical(wanted)
  if (directKey !== undefined && index.byPath.has(directKey)) return index.byPath.get(directKey)
  const lowered = wanted.toLowerCase()
  const exact = index.workspaces.filter(workspace => workspace.title.toLowerCase() === lowered)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    throw new TargetError('ambiguous', `有 ${exact.length} 个工作区都叫「${wanted}」，请改用完整路径或 workspace: 前缀。`, exact.map(workspace => workspace.path))
  }
  const prefixed = index.workspaces.filter(workspace => workspace.title.toLowerCase().startsWith(lowered))
  if (prefixed.length === 1) return prefixed[0]
  if (prefixed.length > 1) {
    throw new TargetError('ambiguous', `「${wanted}」匹配到多个工作区，请给出更完整的名称或路径。`, prefixed.map(workspace => workspace.path))
  }
  return undefined
}

function safeCanonical(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    return canonicalPath(expandHome(value))
  } catch {
    return undefined
  }
}

function resolvePathCandidate(index, wanted, fromCwd, exists) {
  let absolute
  try {
    absolute = resolve(expandHome(wanted))
    if (!isAbsolute(wanted) && typeof fromCwd === 'string' && fromCwd.length > 0) {
      absolute = resolve(fromCwd, expandHome(wanted))
    }
  } catch {
    return undefined
  }
  const key = canonicalPath(absolute)
  if (index.byPath.has(key)) return index.byPath.get(key)
  if (safeExists(exists, absolute)) {
    return {
      workspaceId: undefined,
      path: absolute,
      canonicalPath: key,
      title: basename(absolute),
      exists: true,
      sessions: [...index.sessions.values()].filter(record => record.cwd !== undefined && canonicalPath(record.cwd) === key),
    }
  }
  return undefined
}

function candidatesFor(index, groups = []) {
  const result = []
  for (const workspace of index.workspaces.slice(0, 12)) result.push(`workspace:${workspace.path}（${workspace.title}）`)
  for (const record of [...index.sessions.values()].slice(0, 12)) {
    result.push(`session:${record.sessionId}${record.title === undefined ? '' : `（${record.title}）`}`)
  }
  for (const group of groups.slice(0, 12)) result.push(`group:${group.name}（${group.id}）`)
  return result
}

function groupLookup(groups, wanted) {
  const text = String(wanted ?? '').trim()
  if (text.length === 0) return undefined
  const lowered = text.toLowerCase()
  const byId = groups.find(group => group.id === text)
  if (byId !== undefined) return byId
  const exact = groups.filter(group => group.name.toLowerCase() === lowered)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    throw new TargetError('ambiguous', `有 ${exact.length} 个群组都叫「${text}」，请改用 group:<id>。`, exact.map(group => `group:${group.id}`))
  }
  const prefixed = groups.filter(group => group.name.toLowerCase().startsWith(lowered))
  if (prefixed.length === 1) return prefixed[0]
  if (prefixed.length > 1) {
    throw new TargetError('ambiguous', `「${text}」匹配到多个群组，请改用更完整的名字或 group:<id>。`, prefixed.map(group => `group:${group.id}`))
  }
  return undefined
}

/**
 * Resolve one `to` expression into a session, workspace, or group target.
 *
 * Accepted forms: an exact session id, a workspace path, a workspace title
 * (exact, then unique prefix), a session title (exact, then unique prefix),
 * a group id/name (exact, then unique prefix), and the explicit
 * `workspace:` / `session:` / `group:` prefixes.
 */
export function resolveTarget(index, { to, toSessionId, fromCwd, exists = existsSync, groups = [] } = {}) {
  if (typeof to !== 'string' || to.trim().length === 0) {
    throw new TargetError('invalid', '收件方 `to` 不能为空。可填工作区路径、标题、会话 id、群组名，或加 workspace:/session:/group: 前缀。')
  }
  const prefixed = normalizePrefix(to)
  if (prefixed.value.length === 0) throw new TargetError('invalid', '`to` 前缀后面没有内容。')

  if (typeof toSessionId === 'string' && toSessionId.trim().length > 0) {
    const session = sessionLookup(index, toSessionId.trim())
    if (session === undefined) {
      throw new TargetError('session-not-found', `找不到会话 ${toSessionId}。`, candidatesFor(index, groups))
    }
    return { kind: 'session', session, workspace: workspaceForCwd(index, session.cwd) }
  }

  if (prefixed.kind === 'session') {
    const session = sessionLookup(index, prefixed.value)
    if (session === undefined) {
      throw new TargetError('session-not-found', `找不到会话 ${prefixed.value}。`, candidatesFor(index, groups))
    }
    return { kind: 'session', session, workspace: workspaceForCwd(index, session.cwd) }
  }

  if (prefixed.kind === 'group') {
    const group = groupLookup(groups, prefixed.value)
    if (group === undefined) {
      throw new TargetError('group-not-found', `找不到群组「${prefixed.value}」。`, candidatesFor(index, groups))
    }
    return { kind: 'group', group }
  }

  if (prefixed.kind === 'workspace') {
    const workspace = resolvePathCandidate(index, prefixed.value, fromCwd, exists)
      ?? workspaceLookup(index, prefixed.value)
      ?? workspaceLookup(index, basename(prefixed.value))
    if (workspace === undefined) {
      throw new TargetError('workspace-not-found', `找不到工作区「${prefixed.value}」。`, candidatesFor(index, groups))
    }
    return { kind: 'workspace', workspace }
  }

  const directSession = sessionLookup(index, prefixed.value)
  if (directSession !== undefined) {
    return { kind: 'session', session: directSession, workspace: workspaceForCwd(index, directSession.cwd) }
  }

  const directGroup = groupLookup(groups, prefixed.value)
  if (directGroup !== undefined) return { kind: 'group', group: directGroup }

  if (isPathLike(prefixed.value)) {
    const workspace = resolvePathCandidate(index, prefixed.value, fromCwd, exists)
    if (workspace !== undefined) return { kind: 'workspace', workspace }
  }

  const workspace = workspaceLookup(index, prefixed.value)
  if (workspace !== undefined) return { kind: 'workspace', workspace }

  const lowered = prefixed.value.toLowerCase()
  const sessionExact = [...index.sessions.values()].filter(record => (record.title ?? '').toLowerCase() === lowered)
  if (sessionExact.length === 1) return { kind: 'session', session: sessionExact[0], workspace: workspaceForCwd(index, sessionExact[0].cwd) }
  if (sessionExact.length > 1) {
    throw new TargetError('ambiguous', `有 ${sessionExact.length} 个会话都叫「${prefixed.value}」，请改用会话 id。`, sessionExact.map(record => `session:${record.sessionId}`))
  }
  const sessionPrefixed = [...index.sessions.values()].filter(record => (record.title ?? '').toLowerCase().startsWith(lowered))
  if (sessionPrefixed.length === 1) return { kind: 'session', session: sessionPrefixed[0], workspace: workspaceForCwd(index, sessionPrefixed[0].cwd) }
  if (sessionPrefixed.length > 1) {
    throw new TargetError('ambiguous', `「${prefixed.value}」匹配到多个会话，请改用会话 id。`, sessionPrefixed.map(record => `session:${record.sessionId}`))
  }

  throw new TargetError(
    'target-not-found',
    `找不到收件方「${prefixed.value}」。可先调用 workspace_list 查看工作区、会话与群组；也可以直接给工作区路径、会话 id 或群组名。`,
    candidatesFor(index, groups),
  )
}

/** Resolve a workspace path/title/session id to a session id for delivery. */
export function wakeSessionFor(target) {
  if (target?.kind === 'session') return target.session
  if (target?.kind === 'workspace') return pickWakeSession(target.workspace)
  return undefined
}

/** Build the `{ sessionId, workspacePath }` pair used by viewer identity. */
export function viewerFor(index, { sessionId, workspacePath }) {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const session = index?.sessions?.get(sessionId)
    const cwd = session?.cwd
    return {
      sessionId,
      workspacePath: workspacePath ?? cwd,
    }
  }
  return { workspacePath }
}
