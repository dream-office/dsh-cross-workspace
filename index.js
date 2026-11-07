/**
 * Cross-workspace courier — Host half.
 *
 * Registers:
 *  - the durable mailbox store (settings + messages + attachments),
 *  - six model-facing tools (mail_*, workspace_list),
 *  - the management HTTP API used by the Web panel,
 *  - a per-agent system-prompt context that surfaces unread mail,
 *  - wake/mailbox delivery between sessions of different workspaces.
 *
 * See docs/API.md for the contract shared with the Client half and the tests.
 */
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_SETTINGS, MailStore, StoreError, canonicalPath, looksTextual, mediaTypeFor, normalizeSettings, viewerKeyFor } from './lib/store.js'
import { TargetError, buildIndex, isListableSession, pickWakeSession, resolveTarget, titleOf, viewerFor, workspaceForCwd } from './lib/resolve.js'
import { WakeLimiter, deliverMessage } from './lib/delivery.js'
import {
  buildUnreadContext,
  pickText,
  renderInboxText,
  renderMessageText,
  renderSendResult,
  renderWorkspaceList,
} from './lib/format.js'

export const name = 'dsh-cross-workspace'

export const inject = [
  'tools',
  'webServer',
  'agents',
  'sessions',
  'sessionController',
  'workspaceRegistry',
  'workingDirectory',
]

const ROUTE_PATH = '/plugins/dsh-cross-workspace/api'
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_TOOL_LIST = 100
const MAX_STATE_LIST = 300

function readService(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    return undefined
  }
  return ctx[name]
}

function sleep(ms) {
  return new Promise(done => setTimeout(done, ms))
}

function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new StoreError('request-too-large', '请求体超过 1 MiB。')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new StoreError('invalid-json', '请求体不是有效 JSON。')
  }
}

function expandAttachmentPath(value, baseDir) {
  let text = String(value ?? '').trim()
  if (text.length === 0) throw new StoreError('invalid-attachment', '附件路径不能为空。')
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1)
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    text = join(homedir(), text.slice(1).replace(/^[\\/]/, ''))
  }
  if (!isAbsolute(text)) {
    if (typeof baseDir !== 'string' || baseDir.length === 0) {
      throw new StoreError('invalid-attachment', `附件 ${text} 是相对路径，但无法确定发送方目录。`)
    }
    text = resolve(baseDir, text)
  }
  return text
}

async function isInsideRoot(root, target) {
  let realRoot
  let realTarget
  try {
    realRoot = await realpath(root)
  } catch {
    realRoot = resolve(root)
  }
  try {
    realTarget = await realpath(target)
  } catch {
    // Missing files get their own error; do not misreport them as external.
    return 'missing'
  }
  const remainder = relative(realRoot, realTarget)
  if (remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder))) return true
  return false
}

async function hasHardLink(target) {
  try {
    const info = await lstat(await realpath(target))
    return info.isFile() && info.nlink > 1
  } catch {
    return false
  }
}

/**
 * Attachments are copied into the plugin store and may be inlined when read,
 * which would otherwise let an agent read any host-readable file outside its
 * own filesystem sandbox. Keep sources inside the sender's workspace unless the
 * profile explicitly allows external paths. Hard links to outside files are
 * rejected too because path-based checks cannot tell where the inode lives.
 */
async function assertAttachmentSourcesAllowed(settings, root, sources) {
  if (sources.length === 0) return
  if (settings.allowExternalAttachments === true) return
  if (typeof root !== 'string' || root.length === 0) {
    throw new StoreError('attachment-root-unknown',
      '无法确定发送方工作区，出于安全考虑拒绝发送附件。可在插件配置/设置中开启 allowExternalAttachments 后再试。')
  }
  for (const source of sources) {
    const inside = await isInsideRoot(root, source.path)
    if (inside === 'missing') {
      throw new StoreError('file-not-found', `附件不存在或无法访问：${source.path}。`)
    }
    if (inside !== true) {
      throw new StoreError('attachment-outside-workspace',
        `附件 ${source.path} 不在当前工作区 ${root} 内。为避免绕过文件权限，默认只能发送工作区内的文件；确实需要时可在设置中开启 allowExternalAttachments。`)
    }
    if (await hasHardLink(source.path)) {
      throw new StoreError('attachment-hardlink',
        `附件 ${source.path} 是硬链接，无法确认其真实来源；默认拒绝。请复制成工作区内的普通文件后再发送，或在设置中开启 allowExternalAttachments。`)
    }
  }
}

function isTrustedRequestFactory(ctx) {
  return (req) => {
    const connection = readService(ctx, 'connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      try {
        // Canonical peer admission: only an undefined rejection admits the
        // request. A non-undefined answer (for example 401/403) must stay a
        // rejection even when the Origin header looks same-origin.
        return connection.requestRejection(req) === undefined
      } catch {
        return false
      }
    }
    const host = req.headers?.host
    const origin = req.headers?.origin
    if (typeof host !== 'string') return false
    return origin === `http://${host}` || origin === `https://${host}`
  }
}

function jsonViewMessage(message, viewerKey = undefined) {
  const read = typeof viewerKey === 'string' && Array.isArray(message.readBy) && message.readBy.includes(viewerKey)
  const { deletedGroupMemberIds: _deletedGroupMemberIds, ...toView } = message.to
  return {
    id: message.id,
    threadId: message.threadId,
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    hop: message.hop,
    createdAt: message.createdAt,
    from: { ...message.from },
    to: toView,
    subject: message.subject,
    body: message.body,
    ...(message.data === undefined ? {} : { data: message.data }),
    files: (message.files ?? []).map(file => ({
      name: file.name,
      bytes: file.bytes,
      path: file.path,
      ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
    })),
    tags: [...(message.tags ?? [])],
    read,
    ...(message.editedAt === undefined ? {} : { editedAt: message.editedAt }),
    delivery: { ...message.delivery },
  }
}

function toolMessageView(message, viewerKey) {
  return jsonViewMessage(message, viewerKey)
}

function agentOfPayload(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  if (payload.agent !== null && typeof payload.agent === 'object') return payload.agent
  if (typeof payload.id === 'string') return payload
  return undefined
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const rawConfig = config !== null && typeof config === 'object' ? config : {}
  const storeDirSetting = typeof rawConfig.storeDir === 'string' && rawConfig.storeDir.trim().length > 0
    ? rawConfig.storeDir.trim()
    : undefined
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const storeDir = resolve(storeDirSetting ?? join(home, 'cross-workspace'))
  const store = new MailStore({ dir: storeDir, logger })
  try {
    store.settings = normalizeSettings(rawConfig.settings ?? {}, DEFAULT_SETTINGS)
  } catch (error) {
    logger.warn?.('[cross-workspace] config.settings 无效，改用默认设置', error)
    store.settings = { ...DEFAULT_SETTINGS }
  }
  const limiter = new WakeLimiter()
  const trusted = isTrustedRequestFactory(ctx)

  let loaded = false
  let loadError
  const ready = store.load()
    .then(() => { loaded = true })
    .catch((error) => {
      loadError = error
      logger.error?.('[cross-workspace] 无法加载信箱存储', error)
    })

  async function ensureStore() {
    await ready
    if (loadError !== undefined) {
      throw new StoreError('store-unavailable', `信箱存储无法加载：${loadError instanceof Error ? loadError.message : String(loadError)}`)
    }
    return store
  }

  // Small index cache: panel polling and tool batches should not rescan titles
  // for every call, while an explicit refresh still sees new sessions.
  let indexCache
  let indexCachePromise
  function getIndex({ maxAgeMs = 5000 } = {}) {
    const now = Date.now()
    if (indexCache !== undefined && now - indexCache.generatedAt <= maxAgeMs) return Promise.resolve(indexCache)
    if (indexCachePromise !== undefined) return indexCachePromise
    indexCachePromise = buildIndex(ctx)
      .then((index) => {
        indexCache = index
        return index
      })
      .catch((error) => {
        if (indexCache !== undefined) return indexCache
        throw error
      })
      .finally(() => { indexCachePromise = undefined })
    return indexCachePromise
  }

  function sessionCwd(sessionId, fallback) {
    try {
      const session = ctx.sessions.get?.(sessionId)
      if (session !== undefined && session !== null) {
        try {
          const directory = ctx.workingDirectory.get?.(session)
          if (typeof directory === 'string' && directory.length > 0) return directory
        } catch {
          // fall back to the header cwd
        }
        if (typeof session.header?.cwd === 'string' && session.header.cwd.length > 0) return session.header.cwd
      }
    } catch {
      // session store may not be ready
    }
    return fallback
  }

  function sessionTitleOf(sessionId) {
    try {
      const titleService = readService(ctx, 'sessionTitle')
      const session = ctx.sessions.get?.(sessionId)
      if (titleService !== undefined && session !== undefined) {
        const title = titleService.get?.(session)?.title
        if (typeof title === 'string' && title.length > 0) return title
      }
    } catch {
      // title is a display nicety
    }
    return undefined
  }

  function resolveViewer({ sessionId, workspacePath } = {}) {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const cwd = sessionCwd(sessionId)
      return { sessionId, workspacePath: cwd ?? (typeof workspacePath === 'string' ? workspacePath : undefined) }
    }
    if (typeof workspacePath === 'string' && workspacePath.length > 0) {
      return { workspacePath }
    }
    return {}
  }

  function viewerKey(viewer) {
    if (typeof viewer.sessionId === 'string' && viewer.sessionId.length > 0) return viewerKeyFor({ sessionId: viewer.sessionId })
    if (typeof viewer.workspacePath === 'string' && viewer.workspacePath.length > 0) return viewerKeyFor({ workspacePath: viewer.workspacePath })
    return viewerKeyFor({})
  }

  function unreadForWorkspace(index, workspace) {
    // Count only the conversations the UI actually lists; archived/blank/stale
    // sessions are not addressable from the panel and must not inflate badges.
    const listable = (workspace.sessions ?? []).filter(isListableSession)
    return store.unreadCountForWorkspace(
      workspace.path,
      listable.map(record => record.sessionId),
    )
  }

  function workspaceRows(index) {
    const rows = index.workspaces.map((workspace) => ({
      path: workspace.path,
      title: workspace.title,
      exists: workspace.exists,
      unread: unreadForWorkspace(index, workspace),
      sessions: workspace.sessions.filter(isListableSession).map(record => ({
        sessionId: record.sessionId,
        title: titleOf(record),
        ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
        running: record.running === true,
        updatedAt: record.updatedAt ?? 0,
        unread: store.unreadCountFor({ sessionId: record.sessionId, workspacePath: workspace.path }),
      })),
    }))
    return rows
  }

  function groupRows(index, groups, viewerObject) {
    const groupUnread = new Map()
    if (typeof viewerObject.sessionId === 'string') {
      const key = viewerKey(viewerObject)
      for (const message of store.visibleFor(viewerObject, 'inbox')) {
        if (typeof message.to?.groupId === 'string' && !store.isRead(message, key)) {
          groupUnread.set(message.to.groupId, (groupUnread.get(message.to.groupId) ?? 0) + 1)
        }
      }
    } else {
      // Management view: mark a group message read only when at least one
      // send-time snapshot member has read it (fallback current for legacy).
      const messages = store.listMessages()
      for (const group of groups) {
        let count = 0
        for (const message of messages) {
          if (message.to?.groupId !== group.id) continue
          // Group visibility is the send-time snapshot; fall back to current
          // members only for legacy records without a snapshot.
          const recipients = Array.isArray(message.to?.memberSessionIds) && message.to.memberSessionIds.length > 0
            ? message.to.memberSessionIds
            : group.sessionIds
          const memberKeys = new Set(recipients.map(id => `s:${id}`))
          if (message.readBy.length === 0 || !message.readBy.some(key => memberKeys.has(key))) count += 1
        }
        groupUnread.set(group.id, count)
      }
    }
    return groups.map((group) => ({
      id: group.id,
      name: group.name,
      memberCount: group.sessionIds.length,
      updatedAt: group.updatedAt,
      unread: groupUnread.get(group.id) ?? 0,
      members: group.sessionIds.map((sessionId) => {
        const record = index.sessions.get(sessionId)
        const workspace = workspaceForCwd(index, record?.cwd)
        return {
          sessionId,
          ...(record?.title === undefined ? {} : { title: record.title }),
          ...(workspace?.path === undefined
            ? (record?.cwd === undefined ? {} : { workspacePath: record.cwd })
            : { workspacePath: workspace.path }),
          ...(workspace?.title === undefined ? {} : { workspaceTitle: workspace.title }),
          running: record?.running === true,
          blank: record?.blank === true,
        }
      }),
    }))
  }

  async function buildState(body = {}) {
    await ensureStore()
    const index = await getIndex()
    const groups = store.listGroups()
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined
    const requestedWorkspacePath = typeof body.workspacePath === 'string' && body.workspacePath.length > 0
      ? body.workspacePath
      : undefined
    const viewer = resolveViewer({ sessionId, workspacePath: requestedWorkspacePath })
    const viewerObject = viewerFor(index, viewer)
    const key = viewerKey(viewerObject)
    const filter = body.filter === 'all' ? 'all' : 'inbox'
    const limit = clamp(body.limit ?? 100, 1, MAX_STATE_LIST)

    let messages = store.visibleFor(viewerObject, filter)
    if (filter === 'inbox' && viewerObject.sessionId === undefined && viewerObject.workspacePath === undefined) messages = []
    if (typeof body.workspacePathFilter === 'string' && body.workspacePathFilter.length > 0) {
      const wanted = canonicalPath(body.workspacePathFilter)
      messages = messages.filter((message) => {
        if (typeof message.to.workspacePath === 'string' && canonicalPath(message.to.workspacePath) === wanted) return true
        if (typeof message.to.sessionId === 'string') {
          const record = index.sessions.get(message.to.sessionId)
          if (record?.cwd !== undefined && canonicalPath(record.cwd) === wanted) return true
        }
        return false
      })
    }
    if (typeof body.groupIdFilter === 'string' && body.groupIdFilter.length > 0) {
      messages = messages.filter(message => message.to?.groupId === body.groupIdFilter)
    }
    const total = messages.length
    messages = messages.slice(0, limit)

    const meRecord = typeof viewerObject.sessionId === 'string' ? index.sessions.get(viewerObject.sessionId) : undefined
    const meWorkspace = workspaceForCwd(index, viewerObject.workspacePath)

    return {
      settings: store.getSettings(),
      storeDir,
      storeVersion: store.storeVersion,
      now: Date.now(),
      viewer: {
        key,
        ...(viewerObject.sessionId === undefined ? {} : { sessionId: viewerObject.sessionId }),
        ...(viewerObject.workspacePath === undefined ? {} : { workspacePath: viewerObject.workspacePath }),
        ...(meRecord?.title === undefined ? {} : { sessionTitle: meRecord.title }),
        ...(meWorkspace?.title === undefined ? {} : { workspaceTitle: meWorkspace.title }),
      },
      workspaces: workspaceRows(index),
      groups: groupRows(index, groups, viewerObject),
      orphans: index.orphans.filter(isListableSession).map(record => ({
        sessionId: record.sessionId,
        title: titleOf(record),
        ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
        running: record.running === true,
        updatedAt: record.updatedAt ?? 0,
      })),
      messages: messages.map(message => jsonViewMessage(message, key)),
      unreadTotal: store.unreadCountFor(viewerObject),
      returned: messages.length,
      total,
    }
  }

  function senderInfo(index, sessionId) {
    const record = index.sessions.get(sessionId)
    const cwd = record?.cwd ?? sessionCwd(sessionId)
    const workspace = workspaceForCwd(index, cwd)
    return {
      sessionId,
      cwd,
      title: titleOf(record) ?? sessionTitleOf(sessionId),
      workspacePath: workspace?.path ?? cwd,
      workspaceTitle: workspace?.title ?? (typeof cwd === 'string' && cwd.length > 0 ? basename(cwd) : undefined),
    }
  }

  async function sendMessage(input) {
    await ensureStore()
    const settings = store.getSettings()
    const index = await getIndex()
    const sessionId = input.senderSessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new StoreError('no-session', '请先选择一个会话，再从该会话发送消息。')
    }
    const sender = senderInfo(index, sessionId)
    if ((typeof input.to !== 'string' || input.to.trim().length === 0) && typeof input.groupId !== 'string') {
      throw new StoreError('invalid-target', '收件方 `to` 不能为空。可填工作区路径/标题、会话 id、群组名，或加 workspace:/session:/group: 前缀。')
    }
    const groups = store.listGroups()
    let target
    if (typeof input.groupId === 'string' && input.groupId.length > 0) {
      const group = store.getGroup(input.groupId)
      if (group === undefined) throw new StoreError('group-not-found', `群组 ${input.groupId} 不存在。`)
      target = { kind: 'group', group }
    } else {
      try {
        target = resolveTarget(index, {
          to: input.to,
          toSessionId: input.toSessionId,
          fromCwd: sender.cwd,
          groups,
        })
      } catch (error) {
        if (error instanceof TargetError) {
          const suffix = error.candidates.length > 0 ? ` 候选：${error.candidates.slice(0, 6).join('；')}` : ''
          throw new StoreError(error.code, `${error.message}${suffix}`)
        }
        throw error
      }
    }
    if (target.kind === 'session' && target.session.sessionId === sessionId) {
      throw new StoreError('self-send', '不能给自己发跨工作区消息。')
    }
    const warnings = []
    if (Array.isArray(input.memberSessionIds) && input.memberSessionIds.length > 0 && target.kind !== 'group') {
      throw new StoreError('invalid-target', '`memberSessionIds` 只用于群组目标；发给工作区/会话时请省略。')
    }
    let to
    let wakeTarget
    let deliveryTarget
    if (target.kind === 'group') {
      const group = target.group
      if (input.memberSessionIds !== undefined && !Array.isArray(input.memberSessionIds)) {
        throw new StoreError('invalid-group-members', '`memberSessionIds` 必须是字符串数组。')
      }
      if (Array.isArray(input.memberSessionIds) && input.memberSessionIds.some(id => typeof id !== 'string' || id.length === 0)) {
        throw new StoreError('invalid-group-members', '`memberSessionIds` 只能包含非空字符串会话 id。')
      }
      const allowedMembers = new Set(group.sessionIds)
      const requestedMembers = Array.isArray(input.memberSessionIds)
        ? [...new Set(input.memberSessionIds.filter(id => typeof id === 'string' && id.length > 0))]
        : []
      if (requestedMembers.length > 0) {
        const unknownMembers = requestedMembers.filter(id => !allowedMembers.has(id))
        if (unknownMembers.length > 0) {
          throw new StoreError('invalid-group-members',
            `这些会话不在群组「${group.name}」里：${unknownMembers.slice(0, 8).join('、')}。`)
        }
      }
      const recipientIds = requestedMembers.length > 0 ? requestedMembers : group.sessionIds
      const members = recipientIds.filter(id => id !== sessionId)
      if (members.length === 0) {
        throw new StoreError('empty-group', `群组「${group.name}」里除你以外没有收件成员。请先在面板里添加其他会话，或直接用 mail_send 发给工作区/会话。`)
      }
      to = {
        groupId: group.id,
        groupName: group.name,
        memberSessionIds: members,
      }
      deliveryTarget = { kind: 'group' }
      warnings.push(pickText(settings.promptLocale,
        `这是发给群组「${group.name}」的群发消息，收件人是发送时的 ${members.length} 位成员快照；后加入的成员看不到这封。`,
        `This message goes to group "${group.name}" and targets the ${members.length} member(s) present at send time; later members will not see it.`))
      if (requestedMembers.length > 0) {
        warnings.push(pickText(settings.promptLocale,
          `本次只发给选中的 ${members.length} 位成员；群组里其他成员看不到这封。`,
          `Only the ${members.length} selected member(s) receive this message; other group members will not see it.`))
      }
      if (input.wake !== true) {
        warnings.push(pickText(settings.promptLocale,
          '群组消息默认只投信箱；要立即提醒空闲成员，请显式设置 wake=true。',
          'Group messages are mailbox-only by default; pass wake=true to actively wake idle members.'))
      }
    } else if (target.kind === 'session') {
      const record = target.session
      const workspace = target.workspace ?? workspaceForCwd(index, record.cwd)
      to = {
        sessionId: record.sessionId,
        ...(titleOf(record) === undefined ? {} : { sessionTitle: titleOf(record) }),
        ...(workspace?.path === undefined ? (record.cwd === undefined ? {} : { workspacePath: record.cwd }) : { workspacePath: workspace.path }),
        ...(workspace?.title === undefined ? {} : { workspaceTitle: workspace.title }),
      }
      wakeTarget = record
      deliveryTarget = { kind: 'session', sessionId: record.sessionId }
    } else {
      if (settings.allowWorkspaceBroadcast !== true) {
        throw new StoreError('broadcast-disabled',
          '工作区广播默认关闭，以免无关对话读取消息。请发给具体会话或群组；确需广播时在插件设置里开启「允许工作区广播」。')
      }
      const workspace = target.workspace
      to = {
        workspacePath: workspace.path,
        workspaceTitle: workspace.title,
      }
      wakeTarget = pickWakeSession(workspace, sessionId)
      deliveryTarget = { kind: 'workspace', ...(wakeTarget?.sessionId === undefined ? {} : { sessionId: wakeTarget.sessionId }) }
      if (wakeTarget !== undefined) {
        warnings.push(pickText(settings.promptLocale,
          `这是发给工作区「${workspace.title}」的广播；唤醒的是最近空闲的会话 ${wakeTarget.sessionId}${titleOf(wakeTarget) === undefined ? '' : `（${titleOf(wakeTarget)}）`}，该工作区其他会话下次运行时才会看到。`,
          `Broadcast to workspace "${workspace.title}"; the most recently active idle session ${wakeTarget.sessionId}${titleOf(wakeTarget) === undefined ? '' : ` (${titleOf(wakeTarget)})`} was woken. Other sessions see it on their next run.`))
      } else {
        const onlySelf = pickWakeSession(workspace)?.sessionId === sessionId
        warnings.push(onlySelf
          ? pickText(settings.promptLocale,
            `工作区「${workspace.title}」当前只有发送方自己可唤醒；已跳过自唤醒，消息只入信箱。`,
            `Workspace "${workspace.title}" currently has only the sender as a wake target; self-wake was skipped and the message stays in the mailbox.`)
          : pickText(settings.promptLocale,
            `工作区「${workspace.title}」当前没有可唤醒的会话；消息只入信箱，等该工作区出现会话后可见。`,
            `Workspace "${workspace.title}" has no session to wake; the message stays in the mailbox for its next session.`))
      }
    }

    let files = []
    if (Array.isArray(input.files)) {
      files = input.files.map((file) => {
        if (typeof file === 'string') {
          return { path: expandAttachmentPath(file, sender.cwd) }
        }
        if (file !== null && typeof file === 'object' && typeof file.path === 'string') {
          return { path: expandAttachmentPath(file.path, sender.cwd), ...(typeof file.name === 'string' ? { name: file.name } : {}) }
        }
        throw new StoreError('invalid-attachment', '附件必须是路径字符串或 {path,name}。')
      })
    }
    await assertAttachmentSourcesAllowed(settings, sender.workspacePath ?? sender.cwd, files)

    const replyTo = typeof input.replyTo === 'string' && input.replyTo.length > 0 ? input.replyTo : undefined
    let subject = typeof input.subject === 'string' ? input.subject.trim() : ''
    if (subject.length === 0 && replyTo !== undefined) {
      const parent = store.getMessage(replyTo)
      if (parent !== undefined) subject = parent.subject.length > 0 ? `Re: ${parent.subject}` : `Re: ${parent.id}`
    }

    const requested = target.kind === 'group'
      ? (input.wake === true ? 'wake' : 'mailbox')
      : (typeof input.wake === 'boolean'
          ? (input.wake ? 'wake' : 'mailbox')
          : (settings.defaultDelivery === 'wake' ? 'wake' : 'mailbox'))

    const message = await store.addMessage({
      from: {
        sessionId,
        ...(sender.workspacePath === undefined ? {} : { workspacePath: sender.workspacePath }),
        ...(sender.workspaceTitle === undefined ? {} : { workspaceTitle: sender.workspaceTitle }),
        ...(sender.title === undefined ? {} : { sessionTitle: sender.title }),
        ...(sender.cwd === undefined ? {} : { cwd: sender.cwd }),
      },
      to,
      subject,
      body: typeof input.body === 'string' ? input.body : '',
      ...(input.data === undefined ? {} : { data: input.data }),
      attachmentSources: files,
      ...(replyTo === undefined ? {} : { replyTo }),
      tags: Array.isArray(input.tags) ? input.tags : [],
      delivery: { requested, mode: 'none', delivered: false },
    })

    const delivery = await deliverMessage(ctx, store, message, {
      requested,
      target: deliveryTarget,
      limiter,
    })
    const fresh = store.getMessage(message.id) ?? message
    return {
      message: jsonViewMessage(fresh, viewerKeyFor({ sessionId })),
      delivery,
      warnings,
    }
  }

  async function readAttachmentTexts(message) {
    const settings = store.getSettings()
    const limit = settings.inlineTextBytes
    const texts = []
    if (limit <= 0) return texts
    for (const file of message.files ?? []) {
      const mediaType = file.mediaType ?? mediaTypeFor(file.name)
      if (!looksTextual(file.name, mediaType)) continue
      let handle
      try {
        handle = await open(file.path, 'r')
        const wanted = Math.max(0, Math.min(limit, Number(file.bytes) || limit))
        const buffer = Buffer.alloc(wanted)
        const { bytesRead } = await handle.read(buffer, 0, wanted, 0)
        const raw = buffer.subarray(0, bytesRead)
        if (raw.includes(0)) continue
        const truncated = Number(file.bytes) > bytesRead
        let text = raw.toString('utf8')
        // A clipped multibyte sequence decodes to U+FFFD; drop that one marker
        // instead of showing a broken character. A complete file that legally
        // ends with U+FFFD is left untouched.
        if (truncated && text.endsWith('\uFFFD')) text = text.slice(0, -1)
        texts.push({
          path: file.path,
          text: truncated
            ? `${text}\n${pickText(settings.promptLocale, '…（预览已截断）', '…(preview truncated)')}`
            : text,
        })
      } catch {
        // missing attachment must not break reading the message
      } finally {
        if (handle !== undefined) await handle.close().catch(() => {})
      }
    }
    return texts
  }

  function markReadSafely(messageId, key, read) {
    try {
      return store.markRead(messageId, key, read)
    } catch (error) {
      if (error instanceof StoreError) throw error
      throw new StoreError('mark-failed', error instanceof Error ? error.message : String(error))
    }
  }

  // ------------------------------------------------------------------ actions

  const actions = {
    async state(body) {
      return buildState(body)
    },

    async send(body) {
      const result = await sendMessage({
        senderSessionId: typeof body.fromSessionId === 'string' ? body.fromSessionId : undefined,
        to: body.to,
        toSessionId: typeof body.toSessionId === 'string' ? body.toSessionId : (typeof body.sessionId === 'string' ? body.sessionId : undefined),
        groupId: typeof body.groupId === 'string' ? body.groupId : undefined,
        subject: body.subject,
        body: body.body,
        data: body.data,
        files: body.files,
        wake: body.wake,
        replyTo: body.replyTo,
        memberSessionIds: body.memberSessionIds,
        tags: body.tags,
      })
      return result
    },

    async read(body) {
      await ensureStore()
      if (typeof body.id !== 'string' || body.id.length === 0) throw new StoreError('invalid-id', '缺少消息 id。')
      const viewer = resolveViewer({ sessionId: body.sessionId, workspacePath: body.workspacePath })
      if (store.getMessage(body.id) === undefined) throw new StoreError('message-not-found', `消息 ${body.id} 不存在。`)
      const updated = markReadSafely(body.id, viewerKey(viewer), true)
      return { message: jsonViewMessage(updated, viewerKey(viewer)) }
    },

    async mark(body) {
      await ensureStore()
      if (typeof body.id !== 'string' || body.id.length === 0) throw new StoreError('invalid-id', '缺少消息 id。')
      if (typeof body.read !== 'boolean') throw new StoreError('invalid-read', '`read` 必须是布尔值。')
      const viewer = resolveViewer({ sessionId: body.sessionId, workspacePath: body.workspacePath })
      const updated = markReadSafely(body.id, viewerKey(viewer), body.read)
      return { message: jsonViewMessage(updated, viewerKey(viewer)) }
    },

    async markAll() {
      await ensureStore()
      const index = await getIndex()
      const workspaceSessions = new Map()
      // Group every known session (including orphans) by its cwd, so workspace
      // broadcasts are marked read for session viewers even outside registered workspaces.
      for (const record of index.sessions.values()) {
        if (typeof record.sessionId !== 'string' || typeof record.cwd !== 'string') continue
        const key = canonicalPath(record.cwd)
        if (!workspaceSessions.has(key)) workspaceSessions.set(key, [])
        workspaceSessions.get(key).push(record.sessionId)
      }
      const marked = store.markAllRead({ workspaceSessions })
      return { marked }
    },

    async edit(body) {
      await ensureStore()
      if (typeof body.id !== 'string' || body.id.length === 0) throw new StoreError('invalid-id', '缺少消息 id。')
      const patch = {}
      for (const key of ['subject', 'body', 'data']) {
        if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key]
      }
      const viewer = resolveViewer({ sessionId: body.sessionId, workspacePath: body.workspacePath })
      const updated = await store.editMessage(body.id, patch)
      return { message: jsonViewMessage(updated, viewerKey(viewer)) }
    },

    async delete(body) {
      await ensureStore()
      if (typeof body.id !== 'string' || body.id.length === 0) throw new StoreError('invalid-id', '缺少消息 id。')
      await store.deleteMessage(body.id)
      return { deleted: true }
    },

    async deliver(body) {
      await ensureStore()
      if (typeof body.id !== 'string' || body.id.length === 0) throw new StoreError('invalid-id', '缺少消息 id。')
      const message = store.getMessage(body.id)
      if (message === undefined) throw new StoreError('message-not-found', `消息 ${body.id} 不存在。`)
      const settings = store.getSettings()
      if (typeof message.to.groupId !== 'string' && typeof message.to.sessionId !== 'string'
        && typeof message.to.workspacePath === 'string' && settings.allowWorkspaceBroadcast !== true) {
        throw new StoreError('broadcast-disabled',
          '工作区广播已关闭，不能唤醒投递；请先在设置里开启「允许工作区广播」，或改为发给指定会话/群组。')
      }
      let target
      if (typeof message.to.groupId === 'string') {
        target = { kind: 'group' }
      } else {
        const index = await getIndex()
        let targetSessionId = message.to.sessionId
        if (targetSessionId === undefined && typeof message.to.workspacePath === 'string') {
          const workspace = index.byPath.get(canonicalPath(message.to.workspacePath))
          const fallbackWorkspace = workspace ?? {
            path: message.to.workspacePath,
            canonicalPath: canonicalPath(message.to.workspacePath),
            title: message.to.workspaceTitle ?? basename(message.to.workspacePath),
            sessions: [...index.sessions.values()].filter(record => record.cwd !== undefined && canonicalPath(record.cwd) === canonicalPath(message.to.workspacePath)),
          }
          targetSessionId = pickWakeSession(fallbackWorkspace)?.sessionId
        }
        target = { kind: 'session', sessionId: targetSessionId }
      }
      const delivery = await deliverMessage(ctx, store, message, {
        requested: 'wake',
        target,
        limiter,
      })
      const fresh = store.getMessage(message.id) ?? message
      return { message: jsonViewMessage(fresh), delivery }
    },

    async groupCreate(body) {
      await ensureStore()
      const group = await store.createGroup({ name: body.name, sessionIds: body.sessionIds })
      const index = await getIndex()
      const viewerObject = resolveViewer({ sessionId: body.sessionId, workspacePath: body.workspacePath })
      return { group: groupRows(index, [group], viewerObject)[0] }
    },

    async groupUpdate(body) {
      await ensureStore()
      if (typeof body.id !== 'string' || body.id.length === 0) throw new StoreError('invalid-id', '缺少群组 id。')
      const group = await store.updateGroup(body.id, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.sessionIds === undefined ? {} : { sessionIds: body.sessionIds }),
        ...(body.addSessionIds === undefined ? {} : { addSessionIds: body.addSessionIds }),
        ...(body.removeSessionIds === undefined ? {} : { removeSessionIds: body.removeSessionIds }),
      })
      const index = await getIndex()
      const viewerObject = resolveViewer({ sessionId: body.sessionId, workspacePath: body.workspacePath })
      return { group: groupRows(index, [group], viewerObject)[0] }
    },

    async groupDelete(body) {
      await ensureStore()
      if (typeof body.id !== 'string' || body.id.length === 0) throw new StoreError('invalid-id', '缺少群组 id。')
      await store.deleteGroup(body.id)
      return { deleted: true }
    },

    async settings(body) {
      await ensureStore()
      if (body.patch === undefined || body.patch === null || typeof body.patch !== 'object') {
        throw new StoreError('invalid-settings', '缺少 patch 对象。')
      }
      const settings = await store.updateSettings(body.patch)
      return { settings }
    },

    async prune() {
      await ensureStore()
      const result = await store.prune()
      return { ...result, storeDir }
    },

    async clear(body) {
      await ensureStore()
      const scope = body.scope === 'all' ? 'all' : 'read'
      const result = await store.clear(scope)
      return { removed: result.removed }
    },
  }

  // ------------------------------------------------------------------- route

  async function routeHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '只接受 POST。' } })
        return
      }
      if (!trusted(req) || req.headers['x-dsh-cross-workspace'] !== '1') {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '请求未通过同源/来源校验。' } })
        return
      }
      const contentType = req.headers['content-type']
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { ok: false, error: { code: 'unsupported-media-type', message: '请求必须是 JSON。' } })
        return
      }
      const body = await readJsonBody(req)
      const action = typeof body?.action === 'string' ? body.action : ''
      const handler = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : undefined
      if (handler === undefined) {
        sendJson(res, 400, { ok: false, error: { code: 'unknown-action', message: `未知操作：${action}` } })
        return
      }
      const value = await handler(body ?? {})
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      if (error instanceof StoreError) {
        sendJson(res, 400, { ok: false, error: { code: error.code, message: error.message } })
        return
      }
      if (error instanceof TargetError) {
        const suffix = error.candidates.length > 0 ? `\n候选：${error.candidates.slice(0, 8).join('；')}` : ''
        sendJson(res, 400, { ok: false, error: { code: error.code, message: `${error.message}${suffix}`, candidates: error.candidates } })
        return
      }
      logger.error?.('[cross-workspace] 管理 API 处理失败', error)
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: routeHandler }),
    'cross-workspace: management API route',
  )

  // ------------------------------------------------------------------- tools

  function outputOf(render) {
    return {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: render(value) }],
    }
  }

  async function toolContext(exec) {
    await ensureStore()
    const sessionId = exec?.agent?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('跨工作区信使工具需要在一个会话里调用，但当前调用没有关联会话。')
    }
    const index = await getIndex({ maxAgeMs: 0 })
    const record = index.sessions.get(sessionId)
    const cwd = record?.cwd ?? sessionCwd(sessionId)
    return {
      sessionId,
      index,
      cwd,
      record,
      viewer: { sessionId, ...(cwd === undefined ? {} : { workspacePath: cwd }) },
    }
  }

  function describeViewer(context) {
    if (context.cwd === undefined) return context.sessionId
    return `${context.sessionId}（${context.cwd}）`
  }

  function registerTool(definition) {
    ctx.effect(() => ctx.tools.register(definition), `cross-workspace: tool ${definition.name}`)
  }

  registerTool({
    name: 'mail_send',
    description: 'Send a cross-workspace message through the shared mailbox. `to` accepts a workspace path, a workspace title, a session id, a group name, or "workspace:<...>" / "session:<id>" / "group:<name>". Workspace broadcasts are disabled unless the owner enables allowWorkspaceBroadcast; prefer a specific session or group. Group sends can target all members or only `memberSessionIds` members. You may attach a JSON payload (`data`) and local files (`files`); files must stay inside this session\'s workspace unless the profile enables external attachments. `wake: true` actively wakes the target: if it is running, the plugin waits up to the configured idle timeout and then queues the message for its next turn. **Read delivery.mode before claiming delivery**: wake = confirmed start, queued = queued behind a running turn (not started), mailbox = stored but not started, none = no target. Only a reply from the recipient proves they actually received it. 中文：跨工作区发信；默认只能发给指定会话/群组（工作区广播需 owner 开启）；群组可指定成员；目标运行中会等待后排队；必须读 delivery.mode，只有对方回复才能证明收到。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Workspace path/title, session id, or group name; explicit prefixes workspace:/session:/group: are accepted. Required unless groupId is given.' },
        sessionId: { type: 'string', description: 'Optional exact session inside the target workspace.' },
        groupId: { type: 'string', description: 'Optional exact group id (alternative to to="group:<name>").' },
        subject: { type: 'string', description: 'Short subject line.' },
        body: { type: 'string', description: 'Message body (markdown/plain text).' },
        data: { description: 'Optional JSON value to transfer (object/array/string/number/boolean/null).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Local file paths to copy into the mailbox; default policy requires them to be inside this session\'s workspace (see allowExternalAttachments).' },
        wake: { type: 'boolean', description: 'true = wake the target, false = mailbox only, omitted = settings default (groups default to mailbox).' },
        memberSessionIds: { type: 'array', items: { type: 'string' }, description: 'Group only: send to this subset of group members instead of the whole group. Omit or empty = all members; ids must belong to the group; sender is always excluded.' },
        replyTo: { type: 'string', description: 'Message id to reply to (keeps the thread).' },
      },
    },
    output: outputOf((value) => renderSendResult(value, { locale: store.getSettings().promptLocale })),
    async execute(args, exec) {
      const context = await toolContext(exec)
      const result = await sendMessage({
        senderSessionId: context.sessionId,
        to: args?.to,
        toSessionId: args?.sessionId,
        groupId: typeof args?.groupId === 'string' ? args.groupId : undefined,
        subject: args?.subject,
        body: args?.body,
        data: args?.data,
        files: args?.files,
        wake: args?.wake,
        replyTo: args?.replyTo,
        memberSessionIds: args?.memberSessionIds,
      })
      return result
    },
  })

  registerTool({
    name: 'mail_inbox',
    description: 'List cross-workspace messages visible to this session, newest first. By default only unread messages are returned; messages addressed to this session count, and workspace broadcasts count only when the owner enabled allowWorkspaceBroadcast. Group messages count only when this session was in the send-time recipient snapshot AND (for a live group) still belongs to it; for a deleted group, only snapshot members frozen at deletion count. Removed members lose old group history, and newly added members cannot see messages sent before they joined. 中文：查看本会话的跨工作区来信；工作区广播需 owner 开启才可见；群组消息要求发送时在收件快照且当前仍在群里（群已删除时按删除时冻结成员），退群后旧消息不可读、新成员看不到入群前消息；默认只列未读。',
    parameters: {
      type: 'object',
      properties: {
        unreadOnly: { type: 'boolean', description: 'Only unread messages (default true).' },
        limit: { type: 'number', description: `Maximum rows (1-${MAX_TOOL_LIST}, default 20).` },
      },
    },
    output: outputOf(value => value.text),
    async execute(args, exec) {
      const context = await toolContext(exec)
      const settings = store.getSettings()
      const all = store.visibleFor(context.viewer, 'inbox')
      const unread = all.filter(message => !store.isRead(message, viewerKeyFor({ sessionId: context.sessionId })))
      const unreadOnly = args?.unreadOnly !== false
      const rows = (unreadOnly ? unread : all).slice(0, clamp(args?.limit ?? 20, 1, MAX_TOOL_LIST))
      return {
        unread: unread.length,
        visible: all.length,
        messages: rows.map(message => toolMessageView(message, viewerKeyFor({ sessionId: context.sessionId }))),
        text: renderInboxText(rows, {
          now: Date.now(),
          locale: settings.promptLocale,
          unread: unread.length,
          total: all.length,
        }),
      }
    },
  })

  registerTool({
    name: 'mail_read',
    description: 'Read one cross-workspace message by id, including its JSON data and local attachment copies; text attachments are inlined when small. Marks the message read for this session. 中文：按 id 读一封跨工作区来信，含数据与附件路径，并标记已读。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Message id (m-...).' },
        markRead: { type: 'boolean', description: 'Mark read for this session (default true).' },
      },
      required: ['id'],
    },
    output: outputOf(value => value.text),
    async execute(args, exec) {
      const context = await toolContext(exec)
      const settings = store.getSettings()
      if (typeof args?.id !== 'string' || args.id.length === 0) throw new Error('mail_read 需要 id。')
      const message = store.getMessage(args.id)
      if (message === undefined) throw new Error(`消息 ${args.id} 不存在。先用 mail_inbox 查看可用 id。`)
      const visible = store.visibleFor(context.viewer, 'inbox').some(item => item.id === message.id)
      if (!visible) throw new Error(`消息 ${args.id} 不是发给当前会话/工作区/群组的，不能读取。`)
      const fileTexts = await readAttachmentTexts(message)
      const updated = args?.markRead === false
        ? message
        : store.markRead(message.id, viewerKeyFor({ sessionId: context.sessionId }), true)
      return {
        message: toolMessageView(updated, viewerKeyFor({ sessionId: context.sessionId })),
        fileTexts,
        text: renderMessageText(updated, settings, {
          now: Date.now(),
          locale: settings.promptLocale,
          fileTexts,
        }),
      }
    },
  })

  registerTool({
    name: 'mail_reply',
    description: 'Reply to a cross-workspace message. The message id parameter is `id`; the legacy alias `messageId` is accepted. A session-targeted message replies to the session that sent the original; a group message replies to the live group (current members, optionally narrowed with `memberSessionIds`); replies to a deleted group fail. If the original sender session no longer exists, this fails instead of broadcasting the reply to its workspace. Supports JSON data and files like mail_send; running wake targets are waited for, then queued. Read `delivery.mode` (wake/queued/mailbox/none) before claiming the reply was received. 中文：回复跨工作区来信；参数用 id（兼容旧字段 messageId）；原发件会话不存在或群组已删除时直接报错，不会广播到工作区；群组回复可指定成员；运行中目标先等待后排队；以 delivery.mode 为准。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Message id being replied to.' },
        messageId: { type: 'string', description: 'Legacy alias for id; prefer id.' },
        body: { type: 'string', description: 'Reply body.' },
        data: { description: 'Optional JSON value to transfer back.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Local file paths to copy into the mailbox; default policy requires them to be inside this session\'s workspace (see allowExternalAttachments).' },
        wake: { type: 'boolean', description: 'Wake the original sender (default follows settings).' },
        memberSessionIds: { type: 'array', items: { type: 'string' }, description: 'Group replies only: reply to this subset of current group members instead of all. Omit/empty = all current members; sender excluded.' },
        subject: { type: 'string', description: 'Optional subject; defaults to "Re: <original subject>".' },
      },
    },
    output: outputOf((value) => renderSendResult(value, { locale: store.getSettings().promptLocale })),
    async execute(args, exec) {
      const context = await toolContext(exec)
      const replyId = typeof args?.id === 'string' && args.id.length > 0
        ? args.id
        : (typeof args?.messageId === 'string' && args.messageId.length > 0 ? args.messageId : '')
      if (replyId.length === 0) throw new Error('mail_reply 需要 id（兼容旧字段 messageId）。')
      const parent = store.getMessage(replyId)
      if (parent === undefined) throw new Error(`消息 ${replyId} 不存在。`)
      const visible = store.visibleFor(context.viewer, 'inbox').some(item => item.id === parent.id)
      if (!visible) throw new Error(`消息 ${replyId} 不是发给当前会话/工作区/群组的，不能回复。`)
      if (parent.from.sessionId === context.sessionId) throw new Error('不能回复自己发出的消息。')
      if (typeof parent.to.groupId === 'string') {
        const group = store.getGroup(parent.to.groupId)
        if (group === undefined) {
          throw new Error(`原群组 ${parent.to.groupId} 已删除，无法回群；请用 mail_send 另发给相关会话或新群组。`)
        }
        return sendMessage({
          senderSessionId: context.sessionId,
          to: group.name,
          groupId: group.id,
          subject: args?.subject,
          body: args?.body,
          data: args?.data,
          files: args?.files,
          wake: args?.wake,
          replyTo: parent.id,
          memberSessionIds: args?.memberSessionIds,
        })
      }
      const senderRecord = context.index.sessions.get(parent.from.sessionId)
      if (senderRecord === undefined) {
        throw new Error(`原发件会话 ${parent.from.sessionId} 已不存在，无法直接回复；请用 mail_send 明确发给具体会话或工作区，避免把私聊广播给无关对话。`)
      }
      const to = parent.from.sessionId
      const toSessionId = parent.from.sessionId
      return sendMessage({
        senderSessionId: context.sessionId,
        to,
        toSessionId,
        subject: args?.subject,
        body: args?.body,
        data: args?.data,
        files: args?.files,
        wake: args?.wake,
        replyTo: parent.id,
      })
    },
  })

  registerTool({
    name: 'mail_wait',
    description: 'Wait for NEW cross-workspace mail addressed to this session (long poll). Use it after asking another workspace a question, then read the returned messages. It does not mark anything read and returns when a message arrives, the timeout expires, or the turn is cancelled. 中文：长轮询等待本会话的新跨工作区来信（默认 60 秒，最大 300 秒）。',
    parameters: {
      type: 'object',
      properties: {
        timeoutSeconds: { type: 'number', description: 'Seconds to wait (1-300, default 60).' },
        after: { type: 'string', description: 'Only messages newer than this message id (default: now at call time).' },
      },
    },
    output: outputOf(value => value.text),
    timeoutMs: 310_000,
    async execute(args, exec) {
      const context = await toolContext(exec)
      const settings = store.getSettings()
      const start = Date.now()
      let after = start
      if (typeof args?.after === 'string' && args.after.length > 0) {
        const anchor = store.getMessage(args.after)
        if (anchor !== undefined) after = anchor.createdAt
      }
      const timeout = clamp(args?.timeoutSeconds ?? 60, 1, 300)
      const deadline = start + timeout * 1000
      const key = viewerKeyFor({ sessionId: context.sessionId })
      let messages = []
      let timedOut = true
      let aborted = false
      while (Date.now() < deadline) {
        messages = store.visibleFor(context.viewer, 'inbox')
          .filter(message => message.createdAt > after && !store.isRead(message, key))
        if (messages.length > 0) {
          timedOut = false
          break
        }
        if (exec?.signal?.aborted === true) {
          aborted = true
          timedOut = false
          break
        }
        await sleep(Math.min(400, Math.max(50, deadline - Date.now())))
      }
      const unread = store.unreadCountFor(context.viewer)
      const text = messages.length > 0
        ? renderInboxText(messages.slice(0, 30), { now: Date.now(), locale: settings.promptLocale, unread, total: unread })
        : (aborted
            ? pickText(settings.promptLocale, 'mail_wait 已被取消。', 'mail_wait was cancelled.')
            : pickText(settings.promptLocale,
              `mail_wait 等待 ${timeout} 秒超时，没有新信（未读 ${unread} 条）。可稍后再试，或用 mail_inbox 查看已有消息。`,
              `mail_wait timed out after ${timeout}s without new mail (${unread} unread). Try again later or use mail_inbox.`))
      return {
        waitedMs: Date.now() - start,
        timedOut,
        aborted,
        unread,
        messages: messages.slice(0, 30).map(message => toolMessageView(message, key)),
        text,
      }
    },
  })

  registerTool({
    name: 'workspace_list',
    description: 'List registered workspaces, their engaged sessions (id, title, running) and manual groups, so mail_send targets can be addressed precisely. Blank, archived and stale sessions are omitted; sessions outside registered workspaces remain addressable by id. Existing group membership snapshots are preserved. 中文：列出工作区、有效会话与群组（含 id、标题、是否运行中），空白/归档/失效会话不列出，用于精确寻址。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive filter over workspace titles/paths, session ids/titles and group names.' },
      },
    },
    output: outputOf(value => value.text),
    async execute(args, exec) {
      const context = await toolContext(exec)
      const settings = store.getSettings()
      let index = context.index
      // Only engaged, non-archived conversations are listable/targetable from
      // the workspace view; blanks and archived Sessions stay out of the panels.
      index = {
        ...index,
        workspaces: index.workspaces.map(workspace => ({
          ...workspace,
          sessions: workspace.sessions.filter(isListableSession),
        })),
        orphans: index.orphans.filter(isListableSession),
      }
      let groups = store.listGroups()
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
      if (query.length > 0) {
        const matching = index.workspaces
          .map(workspace => ({
            ...workspace,
            sessions: workspace.sessions.filter(record => {
              const haystack = `${workspace.title} ${workspace.path} ${record.sessionId} ${titleOf(record) ?? ''}`.toLowerCase()
              return haystack.includes(query)
            }),
          }))
          .filter(workspace => workspace.sessions.length > 0 || `${workspace.title} ${workspace.path}`.toLowerCase().includes(query))
        index = { ...index, workspaces: matching, orphans: index.orphans.filter(record => `${record.sessionId} ${titleOf(record) ?? ''} ${record.cwd ?? ''}`.toLowerCase().includes(query)) }
        groups = groups.filter(group => group.name.toLowerCase().includes(query) || group.id.toLowerCase().includes(query))
      }
      const workspaceViews = index.workspaces.map(workspace => ({
        path: workspace.path,
        title: workspace.title,
        exists: workspace.exists,
        unread: unreadForWorkspace(index, workspace),
        sessions: workspace.sessions.map(record => {
          const view = {
            sessionId: record.sessionId,
            running: record.running === true,
            updatedAt: record.updatedAt ?? 0,
            unread: store.unreadCountFor({ sessionId: record.sessionId, workspacePath: workspace.path }),
          }
          const title = titleOf(record)
          if (title !== undefined) view.title = title
          if (record.cwd !== undefined) view.cwd = record.cwd
          return view
        }),
      }))
      return {
        me: {
          sessionId: context.sessionId,
          cwd: context.cwd ?? null,
          workspacePath: workspaceForCwd(index, context.cwd)?.path ?? null,
          unread: store.unreadCountFor(context.viewer),
        },
        workspaces: workspaceViews,
        groups: groupRows(index, groups, context.viewer),
        orphans: index.orphans.map(record => {
          const view = {
            sessionId: record.sessionId,
            running: record.running === true,
          }
          const title = titleOf(record)
          if (title !== undefined) view.title = title
          if (record.cwd !== undefined) view.cwd = record.cwd
          return view
        }),
        text: renderWorkspaceList({ ...index, workspaces: workspaceViews.map(workspace => ({ ...workspace, sessions: workspace.sessions })) }, {
          locale: settings.promptLocale,
          unreadOf: workspace => unreadForWorkspace(index, index.byPath.get(canonicalPath(workspace.path)) ?? workspace),
          groups,
        }),
      }
    },
  })

  // ------------------------------------------------- per-agent prompt context

  const promptDisposers = new Map()

  function unreadTextFor(sessionId) {
    if (!loaded) return ''
    const settings = store.settings
    if (settings.promptContext !== true) return ''
    const cwd = sessionCwd(sessionId)
    const messages = store.unreadMessagesFor({ sessionId, ...(cwd === undefined ? {} : { workspacePath: cwd }) })
    if (messages.length === 0) return ''
    return buildUnreadContext(messages, { locale: settings.promptLocale, now: Date.now() })
  }

  function installPromptContext(agent) {
    const sessionId = agent?.id
    if (typeof sessionId !== 'string' || promptDisposers.has(sessionId)) return
    const agentCtx = agent.ctx
    if (agentCtx === undefined || agentCtx === null) return
    let promptService
    try {
      promptService = agentCtx.systemPrompt ?? agentCtx.get?.('systemPrompt')
    } catch {
      return
    }
    if (promptService === undefined || promptService === null || typeof promptService.context !== 'function') return
    try {
      const disposer = promptService.context({
        name: 'cross-workspace-mail',
        order: 900,
        text: () => {
          try {
            return unreadTextFor(sessionId)
          } catch {
            return ''
          }
        },
      })
      if (typeof disposer === 'function') promptDisposers.set(sessionId, disposer)
    } catch (error) {
      logger.warn?.('[cross-workspace] 注册未读摘要上下文失败', error)
    }
  }

  try {
    for (const agent of ctx.agents.list?.() ?? []) installPromptContext(agent)
  } catch {
    // no live agents yet
  }
  ctx.on('agent/created', (payload) => {
    installPromptContext(agentOfPayload(payload))
  })
  ctx.on('agent/disposed', (payload) => {
    const sessionId = agentOfPayload(payload)?.id
    if (typeof sessionId !== 'string') return
    const disposer = promptDisposers.get(sessionId)
    if (disposer !== undefined) {
      promptDisposers.delete(sessionId)
      try {
        disposer()
      } catch {
        // already disposed with the agent context
      }
    }
  })
  ctx.effect(() => () => {
    for (const disposer of promptDisposers.values()) {
      try {
        disposer()
      } catch {
        // ignore double disposal
      }
    }
    promptDisposers.clear()
    store.flush().catch(() => {})
  }, 'cross-workspace: prompt context + store flush')
}
