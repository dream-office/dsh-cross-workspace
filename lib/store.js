/**
 * Durable mailbox store for the cross-workspace courier.
 *
 * This module deliberately imports nothing from the Harness: it is plain Node
 * code so the unit tests can drive it with a temporary directory. The Host
 * entry (`index.js`) owns all Harness-specific wiring.
 */
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

export const STORE_VERSION = 2

/**
 * Ordered on-disk migrations. Keep every entry pure and additive:
 * `STORE_MIGRATIONS[n]` upgrades a document from version `n` to `n + 1`.
 * v1 → v2 is additive (editedAt/deletedGroupMemberIds/allowWorkspaceBroadcast
 * are filled by normalization), so it only stamps the new version.
 */
export const STORE_MIGRATIONS = Object.freeze({
  1: data => data,
})

export function migrateStoreDocument(data) {
  if (data === null || typeof data !== 'object') {
    throw new StoreError('store-invalid', 'store.json 不是对象。')
  }
  let version = data.version
  if (version === undefined || version === null) version = 1
  if (!Number.isInteger(version) || version < 1) {
    throw new StoreError('store-version-invalid', `store.json 的 version 非法：${String(data.version)}`)
  }
  if (version > STORE_VERSION) {
    throw new StoreError('store-version-too-new',
      `store.json 版本 ${version} 高于当前插件支持的 ${STORE_VERSION}；请升级插件，或从备份恢复旧 store.json。`)
  }
  let document = data
  let migrated = false
  while (version < STORE_VERSION) {
    const migrate = STORE_MIGRATIONS[version]
    if (typeof migrate !== 'function') {
      throw new StoreError('store-migration-missing', `缺少 store v${version} → v${version + 1} 的迁移。`)
    }
    document = { ...migrate(document), version: version + 1 }
    version += 1
    migrated = true
  }
  return { data: document, version, migrated }
}

export const DEFAULT_SETTINGS = Object.freeze({
  defaultDelivery: 'wake',
  allowWake: true,
  allowWorkspaceBroadcast: false,
  promptContext: true,
  promptLocale: 'zh',
  retentionDays: 30,
  maxMessages: 800,
  maxHops: 6,
  wakesPerMinute: 20,
  targetWakeCooldownSeconds: 3,
  waitForIdleSeconds: 120,
  maxBodyBytes: 32768,
  maxSubjectChars: 200,
  maxDataBytes: 65536,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalFileBytes: 20 * 1024 * 1024,
  maxFiles: 8,
  inlineTextBytes: 32768,
  maxGroupMembers: 32,
  // Attachments are copied into the mailbox and can be inlined when read. Keep
  // the source inside the sending session's workspace by default so an agent
  // cannot bypass its own filesystem sandbox through this plugin.
  allowExternalAttachments: false,
})

const SETTING_NUMBERS = Object.freeze({
  retentionDays: { min: 0, max: 3650 },
  maxMessages: { min: 0, max: 100000 },
  maxHops: { min: 0, max: 64 },
  wakesPerMinute: { min: 0, max: 600 },
  targetWakeCooldownSeconds: { min: 0, max: 3600 },
  waitForIdleSeconds: { min: 0, max: 600 },
  maxBodyBytes: { min: 256, max: 1024 * 1024 },
  maxSubjectChars: { min: 1, max: 4096 },
  maxDataBytes: { min: 256, max: 4 * 1024 * 1024 },
  maxFileBytes: { min: 1024, max: 512 * 1024 * 1024 },
  maxTotalFileBytes: { min: 1024, max: 1024 * 1024 * 1024 },
  maxFiles: { min: 0, max: 64 },
  inlineTextBytes: { min: 0, max: 1024 * 1024 },
  maxGroupMembers: { min: 1, max: 200 },
})

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'py', 'rb', 'php', 'java', 'kt', 'go', 'rs',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'sh', 'bash', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'xml',
  'html', 'htm', 'css', 'scss', 'less', 'log', 'env', 'gitignore', 'editorconfig', 'svg', 'tex', 'r',
])

export class StoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

/** Identity key used for read tracking. */
export function viewerKeyFor({ sessionId, workspacePath } = {}) {
  if (typeof sessionId === 'string' && sessionId.length > 0) return `s:${sessionId}`
  if (typeof workspacePath === 'string' && workspacePath.length > 0) return `w:${canonicalPath(workspacePath)}`
  return 'w:<unknown>'
}

/** Normalize an absolute path into a comparison key (Windows is case-insensitive). */
export function canonicalPath(input) {
  const absolute = resolve(String(input))
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function mediaTypeFor(name) {
  const extension = String(name).toLowerCase().split('.').pop() ?? ''
  if (extension === 'json' || extension === 'jsonl') return 'application/json'
  if (extension === 'csv') return 'text/csv'
  if (extension === 'svg') return 'image/svg+xml'
  if (['png'].includes(extension)) return 'image/png'
  if (['jpg', 'jpeg'].includes(extension)) return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'pdf') return 'application/pdf'
  if (TEXT_EXTENSIONS.has(extension)) return 'text/plain'
  return 'application/octet-stream'
}

export function looksTextual(name, mediaType = mediaTypeFor(name)) {
  return mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType === 'image/svg+xml'
}

function sanitizeFileName(input) {
  const raw = String(input ?? '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '_').trim()
  const safe = raw.length > 0 ? raw : 'attachment'
  const clipped = safe.length > 120 ? safe.slice(-120) : safe
  return clipped === '.' || clipped === '..' ? 'attachment' : clipped
}

function uniqueFileName(directory, name) {
  if (!existsSync(join(directory, name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${stem}-${index}${extension}`
    if (!existsSync(join(directory, candidate))) return candidate
  }
  return `${stem}-${randomBytes(4).toString('hex')}${extension}`
}

function messageId(now) {
  return `m-${now.toString(36)}-${randomBytes(3).toString('hex')}`
}

export function groupIdFor(now) {
  return `g-${now.toString(36)}-${randomBytes(3).toString('hex')}`
}

function normalizeGroup(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  const name = String(raw.name ?? '').trim()
  if (name.length === 0) return undefined
  const sessionIds = Array.isArray(raw.sessionIds)
    ? [...new Set(raw.sessionIds.filter(id => typeof id === 'string' && id.length > 0))]
    : []
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : 0
  return {
    id: raw.id,
    name: Array.from(name).length > 60 ? Array.from(name).slice(0, 60).join('') : name,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    sessionIds,
  }
}

function cloneGroup(group) {
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    sessionIds: [...group.sessionIds],
  }
}

function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/** Validate and normalize a settings patch. Unknown keys are rejected. */
export function normalizeSettings(patch, base = DEFAULT_SETTINGS) {
  const next = { ...base }
  if (patch === undefined || patch === null) return next
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    throw new StoreError('invalid-settings', '设置必须是一个对象。')
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'defaultDelivery') {
      if (value !== 'wake' && value !== 'mailbox') throw new StoreError('invalid-settings', 'defaultDelivery 只能是 wake 或 mailbox。')
      next.defaultDelivery = value
      continue
    }
    if (key === 'promptLocale') {
      if (value !== 'zh' && value !== 'en') throw new StoreError('invalid-settings', 'promptLocale 只能是 zh 或 en。')
      next.promptLocale = value
      continue
    }
    if (key === 'allowWake' || key === 'promptContext' || key === 'allowExternalAttachments' || key === 'allowWorkspaceBroadcast') {
      if (typeof value !== 'boolean') throw new StoreError('invalid-settings', `${key} 必须是布尔值。`)
      next[key] = value
      continue
    }
    const bounds = SETTING_NUMBERS[key]
    if (bounds !== undefined) {
      const number = Number(value)
      if (!Number.isFinite(number) || number < bounds.min || number > bounds.max) {
        throw new StoreError('invalid-settings', `${key} 必须是 ${bounds.min}..${bounds.max} 之间的数字。`)
      }
      next[key] = Math.round(number)
      continue
    }
    throw new StoreError('invalid-settings', `未知设置项：${key}`)
  }
  return next
}

function normalizeMessage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (typeof raw.id !== 'string' || typeof raw.threadId !== 'string') return undefined
  if (typeof raw.createdAt !== 'number') return undefined
  if (raw.from === null || typeof raw.from !== 'object') return undefined
  if (raw.to === null || typeof raw.to !== 'object') return undefined
  return {
    id: raw.id,
    threadId: raw.threadId,
    ...(typeof raw.replyTo === 'string' ? { replyTo: raw.replyTo } : {}),
    hop: Number.isFinite(raw.hop) ? Math.max(0, Math.trunc(raw.hop)) : 0,
    createdAt: raw.createdAt,
    from: {
      sessionId: String(raw.from.sessionId ?? ''),
      ...(typeof raw.from.workspacePath === 'string' ? { workspacePath: raw.from.workspacePath } : {}),
      ...(typeof raw.from.workspaceTitle === 'string' ? { workspaceTitle: raw.from.workspaceTitle } : {}),
      ...(typeof raw.from.sessionTitle === 'string' ? { sessionTitle: raw.from.sessionTitle } : {}),
      ...(typeof raw.from.cwd === 'string' ? { cwd: raw.from.cwd } : {}),
    },
    to: {
      ...(typeof raw.to.sessionId === 'string' ? { sessionId: raw.to.sessionId } : {}),
      ...(typeof raw.to.sessionTitle === 'string' ? { sessionTitle: raw.to.sessionTitle } : {}),
      ...(typeof raw.to.workspacePath === 'string' ? { workspacePath: raw.to.workspacePath } : {}),
      ...(typeof raw.to.workspaceTitle === 'string' ? { workspaceTitle: raw.to.workspaceTitle } : {}),
      ...(typeof raw.to.groupId === 'string' ? { groupId: raw.to.groupId } : {}),
      ...(typeof raw.to.groupName === 'string' ? { groupName: raw.to.groupName } : {}),
      ...(Array.isArray(raw.to.memberSessionIds)
        ? { memberSessionIds: raw.to.memberSessionIds.filter(id => typeof id === 'string' && id.length > 0) }
        : {}),
      ...(Array.isArray(raw.to.deletedGroupMemberIds)
        ? { deletedGroupMemberIds: raw.to.deletedGroupMemberIds.filter(id => typeof id === 'string' && id.length > 0) }
        : {}),
    },
    subject: String(raw.subject ?? ''),
    body: String(raw.body ?? ''),
    ...(raw.data !== undefined ? { data: cloneJson(raw.data) } : {}),
    files: Array.isArray(raw.files)
      ? raw.files
          .filter(file => file !== null && typeof file === 'object' && typeof file.path === 'string')
          .map(file => ({
            name: String(file.name ?? basename(file.path)),
            bytes: Number.isFinite(file.bytes) ? Math.max(0, Math.trunc(file.bytes)) : 0,
            path: String(file.path),
            ...(typeof file.mediaType === 'string' ? { mediaType: file.mediaType } : {}),
          }))
      : [],
    tags: Array.isArray(raw.tags) ? raw.tags.filter(tag => typeof tag === 'string').slice(0, 16) : [],
    readBy: Array.isArray(raw.readBy) ? raw.readBy.filter(key => typeof key === 'string') : [],
    ...(Number.isFinite(raw.editedAt) ? { editedAt: raw.editedAt } : {}),
    delivery: normalizeDelivery(raw.delivery),
  }
}

function normalizeDelivery(raw) {
  const delivery = raw !== null && typeof raw === 'object' ? raw : {}
  const requested = delivery.requested === 'wake' ? 'wake' : 'mailbox'
  const mode = delivery.mode === 'wake'
    ? 'wake'
    : delivery.mode === 'queued'
      ? 'queued'
      : delivery.mode === 'mailbox' ? 'mailbox' : 'none'
  return {
    requested,
    mode,
    delivered: mode === 'wake' && delivery.delivered === true,
    ...(Number.isFinite(delivery.at) ? { at: delivery.at } : {}),
    ...(typeof delivery.targetSessionId === 'string' ? { targetSessionId: delivery.targetSessionId } : {}),
    ...(typeof delivery.error === 'string' ? { error: delivery.error } : {}),
    ...(typeof delivery.note === 'string' ? { note: delivery.note } : {}),
    ...(Array.isArray(delivery.members)
      ? {
          members: delivery.members
            .filter(member => member !== null && typeof member === 'object' && typeof member.sessionId === 'string')
            .map(member => ({
              sessionId: member.sessionId,
              mode: member.mode === 'wake'
                ? 'wake'
                : member.mode === 'queued'
                  ? 'queued'
                  : member.mode === 'mailbox' ? 'mailbox' : 'none',
              ...(typeof member.note === 'string' ? { note: member.note } : {}),
              ...(typeof member.error === 'string' ? { error: member.error } : {}),
            })),
        }
      : {}),
  }
}

export class MailStore {
  constructor({ dir, logger = console, now = Date.now } = {}) {
    if (typeof dir !== 'string' || dir.length === 0) throw new StoreError('invalid-store', 'MailStore 需要一个目录。')
    this.dir = resolve(dir)
    this.storePath = join(this.dir, 'store.json')
    this.attachmentsDir = join(this.dir, 'attachments')
    this.logger = logger
    this.now = now
    this.settings = { ...DEFAULT_SETTINGS }
    this.messages = []
    this.groups = []
    this.seq = 0
    this.storeVersion = STORE_VERSION
    this._writeChain = Promise.resolve()
    this._scheduled = null
    this._dirty = false
    this._loaded = false
  }

  async load() {
    await mkdir(this.dir, { recursive: true })
    await mkdir(this.attachmentsDir, { recursive: true })
    let raw
    try {
      raw = await readFile(this.storePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._loaded = true
        return this
      }
      throw error
    }
    let data
    try {
      data = JSON.parse(raw)
    } catch (error) {
      const corrupt = join(this.dir, `store.corrupt-${this.now()}.json`)
      await rename(this.storePath, corrupt).catch(() => {})
      this.logger?.warn?.(`[cross-workspace] store.json 无法解析，已移到 ${corrupt}：${error instanceof Error ? error.message : String(error)}`)
      this._loaded = true
      return this
    }
    let migration
    try {
      migration = migrateStoreDocument(data)
    } catch (error) {
      this.logger?.warn?.(`[cross-workspace] ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    data = migration.data
    if (data !== null && typeof data === 'object') {
      try {
        this.settings = normalizeSettings(data.settings, DEFAULT_SETTINGS)
      } catch {
        this.settings = { ...DEFAULT_SETTINGS }
      }
      if (Array.isArray(data.messages)) {
        this.messages = data.messages.map(normalizeMessage).filter(Boolean)
        this.messages.sort((left, right) => right.createdAt - left.createdAt)
      }
      if (Array.isArray(data.groups)) {
        this.groups = data.groups.map(normalizeGroup).filter(Boolean)
        this.groups.sort((left, right) => right.updatedAt - left.updatedAt)
      }
      this.seq = Number.isFinite(data.seq) ? Math.max(0, Math.trunc(data.seq)) : this.messages.length
    }
    this.storeVersion = STORE_VERSION
    this._loaded = true
    const pruned = await this.prune({ persist: false })
    if (migration.migrated || pruned.removed > 0) await this._persist()
    return this
  }

  assertLoaded() {
    if (!this._loaded) throw new StoreError('not-loaded', 'MailStore 尚未 load()。')
  }

  getSettings() {
    return cloneJson(this.settings)
  }

  /** Stable machine-readable store metadata for diagnostics/upgrade UI. */
  getStoreInfo() {
    this.assertLoaded()
    return {
      schemaVersion: this.storeVersion,
      supportedVersion: STORE_VERSION,
      storeDir: this.dir,
      messages: this.messages.length,
      groups: this.groups.length,
    }
  }

  async updateSettings(patch) {
    this.assertLoaded()
    this.settings = normalizeSettings(patch, this.settings)
    await this._persist()
    return this.getSettings()
  }

  listMessages() {
    this.assertLoaded()
    return this.messages.map(message => cloneJson(message))
  }

  getMessage(id) {
    this.assertLoaded()
    const message = this.messages.find(item => item.id === id)
    return message === undefined ? undefined : cloneJson(message)
  }

  listGroups() {
    this.assertLoaded()
    return this.groups.map(cloneGroup)
  }

  getGroup(id) {
    this.assertLoaded()
    const group = this._findGroup(id)
    return group === undefined ? undefined : cloneGroup(group)
  }

  getGroupByName(name) {
    this.assertLoaded()
    const wanted = String(name ?? '').trim().toLowerCase()
    if (wanted.length === 0) return undefined
    const group = this.groups.find(item => item.name.toLowerCase() === wanted)
    return group === undefined ? undefined : cloneGroup(group)
  }

  _findGroup(id) {
    return this.groups.find(group => group.id === id)
  }

  _assertGroupName(name, exceptId = undefined) {
    const trimmed = String(name ?? '').trim()
    const chars = Array.from(trimmed)
    if (chars.length === 0) throw new StoreError('invalid-group-name', '群组名不能为空。')
    if (chars.length > 60) throw new StoreError('invalid-group-name', '群组名不能超过 60 个字符。')
    const lowered = trimmed.toLowerCase()
    const duplicate = this.groups.find(group => group.id !== exceptId && group.name.toLowerCase() === lowered)
    if (duplicate !== undefined) throw new StoreError('group-name-taken', `群组名「${trimmed}」已被使用。`)
    return trimmed
  }

  _normalizeMemberIds(sessionIds, { required = false } = {}) {
    if (sessionIds === undefined || sessionIds === null) {
      if (required) throw new StoreError('invalid-group-members', '群组成员列表缺失。')
      return undefined
    }
    if (!Array.isArray(sessionIds)) throw new StoreError('invalid-group-members', '群组成员必须是数组。')
    const members = [...new Set(sessionIds.filter(id => typeof id === 'string' && id.length > 0))]
    if (members.length > this.settings.maxGroupMembers) {
      throw new StoreError('group-too-large', `群组最多 ${this.settings.maxGroupMembers} 个成员。`)
    }
    return members
  }

  async createGroup({ name, sessionIds } = {}) {
    this.assertLoaded()
    const normalizedName = this._assertGroupName(name)
    const members = this._normalizeMemberIds(sessionIds, { required: true })
    const now = this.now()
    const group = {
      id: groupIdFor(now),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
      sessionIds: members,
    }
    this.groups.unshift(group)
    this._sortGroups()
    await this._persist()
    return cloneGroup(group)
  }

  async updateGroup(id, patch = {}) {
    this.assertLoaded()
    const group = this._findGroup(id)
    if (group === undefined) throw new StoreError('group-not-found', `群组 ${id} 不存在。`)
    if (patch === null || typeof patch !== 'object') throw new StoreError('invalid-group', '群组更新必须是对象。')
    let members = group.sessionIds
    const replace = this._normalizeMemberIds(patch.sessionIds)
    const add = this._normalizeMemberIds(patch.addSessionIds)
    const remove = this._normalizeMemberIds(patch.removeSessionIds)
    if (replace !== undefined && (add !== undefined || remove !== undefined)) {
      throw new StoreError('invalid-group-members', 'sessionIds 与 add/removeSessionIds 不能同时使用。')
    }
    if (replace !== undefined) members = replace
    else if (add !== undefined || remove !== undefined) {
      const next = new Set(members)
      for (const sessionId of add ?? []) next.add(sessionId)
      for (const sessionId of remove ?? []) next.delete(sessionId)
      members = [...next]
      if (members.length > this.settings.maxGroupMembers) {
        throw new StoreError('group-too-large', `群组最多 ${this.settings.maxGroupMembers} 个成员。`)
      }
    }
    if (patch.name !== undefined) group.name = this._assertGroupName(patch.name, group.id)
    group.sessionIds = members
    group.updatedAt = this.now()
    this._sortGroups()
    await this._persist()
    return cloneGroup(group)
  }

  async deleteGroup(id) {
    this.assertLoaded()
    const index = this.groups.findIndex(group => group.id === id)
    if (index < 0) throw new StoreError('group-not-found', `群组 ${id} 不存在。`)
    const group = this.groups[index]
    const membersAtDeletion = [...new Set((group.sessionIds ?? []).filter(sessionId => typeof sessionId === 'string' && sessionId.length > 0))]
    // Freeze who could see this group's history at deletion time. Without this,
    // a member removed before deletion would regain access through the old
    // snapshot after the group itself is gone.
    for (const message of this.messages) {
      if (message.to?.groupId === id) message.to.deletedGroupMemberIds = membersAtDeletion.slice()
    }
    this.groups.splice(index, 1)
    await this._persist()
    return true
  }

  _sortGroups() {
    this.groups.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /** Return the live (non-cloned) record; callers must not mutate it. */
  _find(id) {
    return this.messages.find(message => message.id === id)
  }

  _nextSeq() {
    this.seq += 1
    return this.seq
  }

  /**
   * Store one message. `input.attachmentSources` is an array of
   * `{ path, name? }` local files copied into the store; `input.files` is
   * already-stored metadata (normally left empty by callers).
   */
  async addMessage(input) {
    this.assertLoaded()
    if (input === null || typeof input !== 'object') throw new StoreError('invalid-message', '消息必须是对象。')
    const from = input.from ?? {}
    if (typeof from.sessionId !== 'string' || from.sessionId.length === 0) {
      throw new StoreError('invalid-message', '发件会话未知。')
    }
    const to = input.to ?? {}
    const toGroupId = typeof to.groupId === 'string' && to.groupId.length > 0 ? to.groupId : undefined
    const toSessionId = typeof to.sessionId === 'string' && to.sessionId.length > 0 ? to.sessionId : undefined
    const toWorkspacePath = typeof to.workspacePath === 'string' && to.workspacePath.length > 0 ? to.workspacePath : undefined
    if (toGroupId === undefined && toSessionId === undefined && toWorkspacePath === undefined) {
      throw new StoreError('invalid-message', '收件方需要会话、工作区或群组。')
    }
    if (toGroupId !== undefined && (toSessionId !== undefined || toWorkspacePath !== undefined)) {
      throw new StoreError('invalid-message', '群组消息不能同时指定会话或工作区。')
    }
    let group
    if (toGroupId !== undefined) {
      group = this._findGroup(toGroupId)
      if (group === undefined) throw new StoreError('group-not-found', `群组 ${toGroupId} 不存在。`)
    }
    const subject = String(input.subject ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (Array.from(subject).length > this.settings.maxSubjectChars) {
      throw new StoreError('subject-too-long', `主题不能超过 ${this.settings.maxSubjectChars} 个字符。`)
    }
    const body = String(input.body ?? '')
    if (byteLength(body) > this.settings.maxBodyBytes) {
      throw new StoreError('body-too-long', `正文不能超过 ${this.settings.maxBodyBytes} 字节。`)
    }
    if (
      body.trim().length === 0
      && input.data === undefined
      && (input.files ?? []).length === 0
      && (input.attachmentSources ?? []).length === 0
    ) {
      throw new StoreError('empty-message', '正文、数据、附件至少要有一项。')
    }
    if (input.data !== undefined) {
      let serialized
      try {
        serialized = JSON.stringify(input.data)
      } catch {
        throw new StoreError('invalid-data', '数据必须是合法 JSON。')
      }
      if (byteLength(serialized) > this.settings.maxDataBytes) {
        throw new StoreError('data-too-large', `数据不能超过 ${this.settings.maxDataBytes} 字节。`)
      }
    }
    const files = Array.isArray(input.files) ? input.files : []
    const sources = Array.isArray(input.attachmentSources) ? input.attachmentSources : []
    if (sources.length > this.settings.maxFiles) throw new StoreError('too-many-files', `最多 ${this.settings.maxFiles} 个附件。`)
    let sourceBytes = 0
    for (const source of sources) {
      if (source === null || typeof source !== 'object' || typeof source.path !== 'string') {
        throw new StoreError('invalid-attachment', '附件需要 path。')
      }
      let info
      try {
        info = await stat(source.path)
      } catch {
        throw new StoreError('file-not-found', `附件不存在：${source.path}`)
      }
      if (!info.isFile()) throw new StoreError('file-not-found', `附件不是文件：${source.path}`)
      if (info.size > this.settings.maxFileBytes) {
        throw new StoreError('file-too-large', `附件 ${source.path} 超过单文件上限 ${this.settings.maxFileBytes} 字节。`)
      }
      sourceBytes += info.size
    }
    const totalBytes = files.reduce((sum, file) => sum + (Number(file?.bytes) || 0), 0) + sourceBytes
    if (totalBytes > this.settings.maxTotalFileBytes) {
      throw new StoreError('attachments-too-large', `附件合计不能超过 ${this.settings.maxTotalFileBytes} 字节。`)
    }
    let parent
    if (typeof input.replyTo === 'string' && input.replyTo.length > 0) {
      parent = this._find(input.replyTo)
      if (parent === undefined) throw new StoreError('reply-target-not-found', `被回复的消息 ${input.replyTo} 不存在。`)
    }
    const now = this.now()
    const id = messageId(now)
    this._nextSeq()
    const storedFiles = []
    try {
      for (const source of sources) {
        storedFiles.push(await this.saveAttachment(source.path, { messageId: id, displayName: source.name }))
      }
    } catch (error) {
      await rm(join(this.attachmentsDir, id), { recursive: true, force: true }).catch(() => {})
      throw error
    }
    const allFiles = [
      ...files.map(file => ({
        name: String(file?.name ?? basename(String(file?.path ?? 'attachment'))),
        bytes: Math.max(0, Math.trunc(Number(file?.bytes) || 0)),
        path: String(file?.path ?? ''),
        mediaType: typeof file?.mediaType === 'string' ? file.mediaType : mediaTypeFor(file?.name ?? file?.path ?? ''),
      })),
      ...storedFiles,
    ]
    if (allFiles.length > this.settings.maxFiles) {
      await rm(join(this.attachmentsDir, id), { recursive: true, force: true }).catch(() => {})
      throw new StoreError('too-many-files', `最多 ${this.settings.maxFiles} 个附件。`)
    }
    const message = {
      id,
      threadId: parent?.threadId ?? id,
      ...(parent === undefined ? {} : { replyTo: parent.id }),
      hop: parent === undefined ? 0 : parent.hop + 1,
      createdAt: now,
      from: {
        sessionId: from.sessionId,
        ...(typeof from.workspacePath === 'string' ? { workspacePath: from.workspacePath } : {}),
        ...(typeof from.workspaceTitle === 'string' ? { workspaceTitle: from.workspaceTitle } : {}),
        ...(typeof from.sessionTitle === 'string' ? { sessionTitle: from.sessionTitle } : {}),
        ...(typeof from.cwd === 'string' ? { cwd: from.cwd } : {}),
      },
      to: {
        ...(toSessionId === undefined ? {} : { sessionId: toSessionId }),
        ...(typeof to.sessionTitle === 'string' ? { sessionTitle: to.sessionTitle } : {}),
        ...(toWorkspacePath === undefined ? {} : { workspacePath: toWorkspacePath }),
        ...(typeof to.workspaceTitle === 'string' ? { workspaceTitle: to.workspaceTitle } : {}),
        ...(group === undefined ? {} : {
          groupId: group.id,
          groupName: group.name,
          memberSessionIds: Array.isArray(to.memberSessionIds)
            ? [...new Set(to.memberSessionIds.filter(id => typeof id === 'string' && id.length > 0))]
            : [],
        }),
      },
      subject,
      body,
      ...(input.data === undefined ? {} : { data: cloneJson(input.data) }),
      files: allFiles,
      tags: Array.isArray(input.tags) ? input.tags.filter(tag => typeof tag === 'string').slice(0, 16) : [],
      readBy: [],
      delivery: normalizeDelivery(input.delivery),
    }
    this.messages.unshift(message)
    await this._trimToMax()
    await this._persist()
    return cloneJson(message)
  }

  async updateMessage(id, mutator) {
    this.assertLoaded()
    const message = this._find(id)
    if (message === undefined) throw new StoreError('message-not-found', `消息 ${id} 不存在。`)
    if (typeof mutator === 'function') {
      const replacement = await mutator(cloneJson(message))
      if (replacement !== undefined) {
        this.messages[this.messages.indexOf(message)] = normalizeMessage(replacement)
      }
    }
    await this._persist()
    return this.getMessage(id)
  }

  /** Copy one source file into the store and return attachment metadata. */
  async saveAttachment(sourcePath, { messageId: targetMessageId, displayName } = {}) {
    this.assertLoaded()
    let info
    try {
      info = await stat(sourcePath)
    } catch (error) {
      throw new StoreError('file-not-found', `附件不存在：${sourcePath}（${error instanceof Error ? error.message : String(error)}）`)
    }
    if (!info.isFile()) throw new StoreError('file-not-found', `附件不是文件：${sourcePath}`)
    if (info.size > this.settings.maxFileBytes) {
      throw new StoreError('file-too-large', `附件 ${sourcePath} 超过单文件上限 ${this.settings.maxFileBytes} 字节。`)
    }
    const ownedName = sanitizeFileName(displayName ?? basename(sourcePath))
    const directory = join(this.attachmentsDir, targetMessageId)
    await mkdir(directory, { recursive: true })
    const name = uniqueFileName(directory, ownedName)
    const target = join(directory, name)
    await copyFile(sourcePath, target)
    return { name, bytes: info.size, path: target, mediaType: mediaTypeFor(name) }
  }

  markRead(id, viewerKey, read = true) {
    this.assertLoaded()
    const message = this._find(id)
    if (message === undefined) throw new StoreError('message-not-found', `消息 ${id} 不存在。`)
    const set = new Set(message.readBy)
    if (read) set.add(viewerKey)
    else set.delete(viewerKey)
    message.readBy = [...set]
    this._schedulePersist()
    return this.getMessage(id)
  }

  /** Owner-level edit of subject/body/data; recipients, files and read state stay intact. */
  async editMessage(id, patch = {}) {
    this.assertLoaded()
    const message = this._find(id)
    if (message === undefined) throw new StoreError('message-not-found', `消息 ${id} 不存在。`)
    const has = key => Object.prototype.hasOwnProperty.call(patch, key)
    if (!has('subject') && !has('body') && !has('data')) {
      throw new StoreError('invalid-edit', '编辑消息至少需要 subject、body 或 data 之一。')
    }
    if (has('subject')) {
      const subject = String(patch.subject ?? '').trim()
      if (Array.from(subject).length > this.settings.maxSubjectChars) {
        throw new StoreError('subject-too-long', `主题不能超过 ${this.settings.maxSubjectChars} 个字符。`)
      }
      message.subject = subject
    }
    if (has('body')) {
      const body = String(patch.body ?? '')
      if (byteLength(body) > this.settings.maxBodyBytes) {
        throw new StoreError('body-too-long', `正文不能超过 ${this.settings.maxBodyBytes} 字节。`)
      }
      message.body = body
    }
    if (has('data')) {
      if (patch.data === undefined) delete message.data
      else {
        const serialized = JSON.stringify(patch.data)
        if (byteLength(serialized) > this.settings.maxDataBytes) {
          throw new StoreError('data-too-large', `数据不能超过 ${this.settings.maxDataBytes} 字节。`)
        }
        message.data = cloneJson(patch.data)
      }
    }
    message.editedAt = this.now()
    await this._persist()
    return this.getMessage(id)
  }

  isRead(message, viewerKey) {
    return Array.isArray(message?.readBy) && message.readBy.includes(viewerKey)
  }

  /**
   * Mark every stored message read for all of its intended recipients.
   * Management-level convenience: one owner, local plugin. Returns the number
   * of messages whose readBy set changed.
   */
  markAllRead({ workspaceSessions } = {}) {
    this.assertLoaded()
    let marked = 0
    for (const message of this.messages) {
      const keys = new Set(Array.isArray(message.readBy) ? message.readBy : [])
      const before = keys.size
      if (typeof message.to?.sessionId === 'string') {
        keys.add(`s:${message.to.sessionId}`)
      } else if (typeof message.to?.groupId === 'string') {
        // Prefer the send-time snapshot; legacy records without one fall back
        // to the current group members (same fallback as management unread).
        const group = this.getGroup(message.to.groupId)
        const memberIds = Array.isArray(message.to.memberSessionIds) && message.to.memberSessionIds.length > 0
          ? message.to.memberSessionIds
          : (Array.isArray(group?.sessionIds) ? group.sessionIds : [])
        for (const sessionId of memberIds) {
          if (typeof sessionId === 'string') keys.add(`s:${sessionId}`)
        }
      } else if (typeof message.to?.workspacePath === 'string') {
        const pathKey = canonicalPath(message.to.workspacePath)
        keys.add(`w:${pathKey}`)
        const sessionIds = workspaceSessions instanceof Map ? workspaceSessions.get(pathKey) : undefined
        if (Array.isArray(sessionIds)) {
          for (const sessionId of sessionIds) {
            if (typeof sessionId === 'string') keys.add(`s:${sessionId}`)
          }
        }
      }
      if (keys.size !== before) {
        message.readBy = [...keys]
        marked += 1
      }
    }
    if (marked > 0) this._schedulePersist()
    return marked
  }

  /** Messages visible to one viewer, newest first. `all` ignores visibility. */
  visibleFor(viewer, filter = 'inbox') {
    this.assertLoaded()
    if (filter === 'all') return this.listMessages()
    return this.messages.filter(message => this._visible(message, viewer)).map(message => cloneJson(message))
  }

  _visible(message, viewer) {
    const viewerSession = viewer?.sessionId
    if (typeof message.to.groupId === 'string') {
      if (typeof viewerSession !== 'string') return false
      const snapshot = Array.isArray(message.to.memberSessionIds) ? message.to.memberSessionIds : []
      const group = this.getGroup(message.to.groupId)
      if (snapshot.length === 0) {
        // Legacy records have no snapshot; they follow the current group (or
        // the frozen members at deletion) so badges and visibility agree.
        if (group !== undefined) return group.sessionIds.includes(viewerSession)
        const atDeletion = Array.isArray(message.to.deletedGroupMemberIds) ? message.to.deletedGroupMemberIds : []
        return atDeletion.includes(viewerSession)
      }
      if (!snapshot.includes(viewerSession)) return false
      if (group !== undefined) return group.sessionIds.includes(viewerSession)
      const atDeletion = Array.isArray(message.to.deletedGroupMemberIds)
        ? message.to.deletedGroupMemberIds
        : snapshot
      return atDeletion.includes(viewerSession)
    }
    const targetSession = message.to.sessionId
    const viewerWorkspace = viewer?.workspacePath === undefined ? undefined : canonicalPath(viewer.workspacePath)
    if (typeof targetSession === 'string') {
      return typeof viewerSession === 'string' && targetSession === viewerSession
    }
    if (typeof message.to.workspacePath === 'string') {
      if (this.getSettings().allowWorkspaceBroadcast !== true) return false
      if (viewerWorkspace === undefined) return false
      return canonicalPath(message.to.workspacePath) === viewerWorkspace
    }
    return false
  }

  unreadCountFor(viewer) {
    this.assertLoaded()
    const key = viewerKeyFor(viewer)
    return this.messages.filter(message => this._visible(message, viewer) && !this.isRead(message, key)).length
  }

  /** Clone only the unread messages visible to one viewer, newest first. */
  unreadMessagesFor(viewer) {
    this.assertLoaded()
    const key = viewerKeyFor(viewer)
    return this.messages
      .filter(message => this._visible(message, viewer) && !this.isRead(message, key))
      .map(message => cloneJson(message))
  }

  /**
   * Workspace-level unread count for management views: a message counts while
   * no session of that workspace has read it. Broadcasts to the workspace and
   * messages targeted at one of its sessions both count.
   */
  unreadCountForWorkspace(workspacePath, sessionIds = []) {
    this.assertLoaded()
    const pathKey = canonicalPath(workspacePath)
    const sessionSet = new Set(sessionIds)
    const keys = new Set([...sessionSet].map(id => `s:${id}`))
    return this.messages.filter((message) => {
      if (typeof message.to.sessionId === 'string') {
        if (!sessionSet.has(message.to.sessionId)) return false
        return !message.readBy.includes(`s:${message.to.sessionId}`)
      }
      if (typeof message.to.workspacePath !== 'string') return false
      if (this.getSettings().allowWorkspaceBroadcast !== true) return false
      if (canonicalPath(message.to.workspacePath) !== pathKey) return false
      if (message.readBy.includes(`w:${pathKey}`)) return false
      if (message.readBy.length === 0) return true
      return !message.readBy.some(key => keys.has(key))
    }).length
  }

  async deleteMessage(id) {
    this.assertLoaded()
    const index = this.messages.findIndex(message => message.id === id)
    if (index < 0) throw new StoreError('message-not-found', `消息 ${id} 不存在。`)
    this.messages.splice(index, 1)
    await rm(join(this.attachmentsDir, id), { recursive: true, force: true }).catch(() => {})
    await this._persist()
  }

  async clear(scope = 'read') {
    this.assertLoaded()
    if (scope !== 'read' && scope !== 'all') throw new StoreError('invalid-scope', 'clear 只接受 read 或 all。')
    const before = this.messages.length
    const kept = []
    for (const message of this.messages) {
      const remove = scope === 'all' || message.readBy.length > 0
      if (remove) await rm(join(this.attachmentsDir, message.id), { recursive: true, force: true }).catch(() => {})
      else kept.push(message)
    }
    this.messages = kept
    await this._persist()
    return { removed: before - kept.length }
  }

  async prune({ persist = true } = {}) {
    this.assertLoaded()
    const cutoff = this.settings.retentionDays > 0
      ? this.now() - this.settings.retentionDays * 24 * 60 * 60 * 1000
      : undefined
    const kept = []
    const removedIds = []
    for (const message of this.messages) {
      const expired = cutoff !== undefined && message.createdAt < cutoff
      if (expired) {
        removedIds.push(message.id)
        await rm(join(this.attachmentsDir, message.id), { recursive: true, force: true }).catch(() => {})
      } else {
        kept.push(message)
      }
    }
    const limit = this.settings.maxMessages
    while (limit > 0 && kept.length > limit) {
      const message = kept.pop()
      removedIds.push(message.id)
      await rm(join(this.attachmentsDir, message.id), { recursive: true, force: true }).catch(() => {})
    }
    this.messages = kept
    if (persist && removedIds.length > 0) await this._persist()
    return { removed: removedIds.length, kept: kept.length }
  }

  async _trimToMax() {
    const limit = this.settings.maxMessages
    if (limit <= 0) return
    const removed = []
    while (this.messages.length > limit) removed.push(this.messages.pop())
    for (const message of removed) {
      await rm(join(this.attachmentsDir, message.id), { recursive: true, force: true }).catch(() => {})
    }
  }

  _schedulePersist() {
    this._dirty = true
    if (this._scheduled !== null) return
    const run = async () => {
      while (this._dirty) {
        this._dirty = false
        try {
          await this._writeNow()
        } catch (error) {
          this.logger?.error?.('[cross-workspace] 写入 store.json 失败', error)
          break
        }
      }
    }
    const scheduled = this._writeChain.then(run)
    this._writeChain = scheduled.catch(() => {})
    this._scheduled = scheduled.finally(() => {
      this._scheduled = null
      if (this._dirty) this._schedulePersist()
    })
  }

  async _persist() {
    const task = this._writeChain.then(() => this._writeNow())
    this._writeChain = task.catch(() => {})
    return task
  }

  async _writeNow() {
    const payload = {
      version: STORE_VERSION,
      seq: this.seq,
      settings: this.settings,
      groups: this.groups,
      messages: this.messages,
    }
    const temporary = join(this.dir, `.store-${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
    await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8')
    await rename(temporary, this.storePath)
  }

  async flush() {
    await this._writeChain
    if (this._scheduled !== null) await this._scheduled
  }
}

export { sanitizeFileName, uniqueFileName, messageId, byteLength, TEXT_EXTENSIONS, sep }
