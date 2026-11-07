/**
 * Unit tests for lib/store.js — the durable mailbox store.
 *
 * Everything runs inside a fresh mkdtemp directory; no production files are
 * touched. The clock is fixed so ids, prunes and corrupt-file names are stable.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  DEFAULT_SETTINGS,
  MailStore,
  STORE_MIGRATIONS,
  STORE_VERSION,
  StoreError,
  canonicalPath,
  migrateStoreDocument,
  viewerKeyFor,
} from '../lib/store.js'

const FIXED = 1_780_000_000_000
const DAY = 24 * 60 * 60 * 1000

let root
let clock
let activeStore

function makeClock(start = FIXED) {
  let value = start
  return {
    now: () => value,
    set(next) {
      value = next
    },
    advance(ms) {
      value += ms
    },
  }
}

async function newStore({ dirName = 'store', logger, allowWorkspaceBroadcast = true } = {}) {
  const dir = join(root, dirName)
  const store = new MailStore({
    dir,
    now: clock.now,
    ...(logger === undefined ? {} : { logger }),
  })
  await store.load()
  // Legacy store tests exercise workspace broadcasts; production defaults this
  // off for privacy (see DEFAULT_SETTINGS and the dedicated privacy tests).
  store.settings.allowWorkspaceBroadcast = allowWorkspaceBroadcast
  activeStore = store
  return { dir, store }
}

/** Valid sender/receiver pair; spread overrides on top. */
function input(overrides = {}) {
  return {
    from: { sessionId: 's-sender' },
    to: { workspacePath: join(root, 'ws-a') },
    body: 'body',
    ...overrides,
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'StoreError')
    assert.equal(error.code, code)
    return true
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-xw-store-'))
  clock = makeClock()
  activeStore = undefined
})

afterEach(async () => {
  try {
    await activeStore?.flush()
  } catch {
    // best effort before the directory disappears
  }
  await rm(root, { recursive: true, force: true })
})

describe('MailStore lifecycle', () => {
  it('load() creates an empty store with default settings', async () => {
    const { dir, store } = await newStore({ allowWorkspaceBroadcast: false })

    assert.deepEqual(store.getSettings(), DEFAULT_SETTINGS)
    assert.deepEqual(store.listMessages(), [])
    assert.equal(store.seq, 0)
    assert.equal(store.dir, dir)
    assert.equal(existsSync(join(dir, 'attachments')), true)
    assert.equal(existsSync(join(dir, 'store.json')), false)

    // A second load of the same (still empty) directory behaves identically.
    const again = new MailStore({ dir, now: clock.now })
    await again.load()
    assert.deepEqual(again.listMessages(), [])
    assert.deepEqual(again.getSettings(), DEFAULT_SETTINGS)
  })

  it('addMessage() writes the contract shape and reloads identically', async () => {
    const { dir, store } = await newStore({ allowWorkspaceBroadcast: false })
    const firstAt = clock.now()

    const first = await store.addMessage(input({ subject: 'First', body: 'one' }))
    clock.advance(1000)
    const second = await store.addMessage(input({
      to: { sessionId: 's-target', workspacePath: join(root, 'ws-a') },
      subject: 'Second',
      body: 'two',
      tags: ['alpha', 'beta'],
    }))

    assert.match(first.id, /^m-[0-9a-z]+-[0-9a-f]{6}$/)
    assert.equal(first.threadId, first.id)
    assert.equal(first.hop, 0)
    assert.equal(first.createdAt, firstAt)
    assert.deepEqual(first.readBy, [])
    assert.equal(first.from.sessionId, 's-sender')
    assert.equal(second.hop, 0)
    assert.equal(second.replyTo, undefined)

    const raw = await readFile(join(dir, 'store.json'), 'utf8')
    const disk = JSON.parse(raw)
    assert.deepEqual(Object.keys(disk).sort(), ['groups', 'messages', 'seq', 'settings', 'version'])
    assert.equal(disk.version, STORE_VERSION)
    assert.deepEqual(disk.groups, [])
    assert.equal(disk.messages.length, 2)
    assert.deepEqual(disk.settings, DEFAULT_SETTINGS)

    const storedFirst = disk.messages.find(message => message.id === first.id)
    assert.equal(storedFirst.subject, 'First')
    assert.equal(storedFirst.body, 'one')
    assert.equal(storedFirst.createdAt, firstAt)
    assert.deepEqual(storedFirst.readBy, [])
    assert.deepEqual(storedFirst.files, [])
    assert.deepEqual(storedFirst.tags, [])
    assert.equal(storedFirst.delivery.mode, 'none')
    assert.equal(storedFirst.delivery.requested, 'mailbox')
    assert.equal(storedFirst.delivery.delivered, false)

    // No temporary files linger next to the atomic rename target.
    const leftovers = (await readdir(dir)).filter(name => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])

    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.deepEqual(reloaded.listMessages(), store.listMessages())
    assert.deepEqual(reloaded.getSettings(), store.getSettings())
    // Newest first, both in memory and after reload.
    assert.deepEqual(reloaded.listMessages().map(message => message.id), [second.id, first.id])
  })

  it('store.json seq is an auto-increment counter (API.md §2)', async () => {
    const { dir, store } = await newStore()
    await store.addMessage(input({ body: 'one' }))
    await store.addMessage(input({ body: 'two' }))

    const disk = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'))
    // Regression: addMessage() must bump and persist the auto-increment seq
    // (an earlier version defined _nextSeq() but never called it).
    assert.equal(disk.seq, 2)

    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.seq, 2)
  })

  it('preserves queued delivery mode and per-member queued results', async () => {
    // API.md §3: delivery.mode and delivery.members[].mode may be 'queued'.
    const { dir, store } = await newStore()
    const message = await store.addMessage(input({
      delivery: {
        requested: 'wake',
        mode: 'queued',
        delivered: false,
        targetSessionId: 's-queued',
        note: 'queued behind a running turn',
        members: [
          { sessionId: 's-queued', mode: 'queued' },
          { sessionId: 's-idle', mode: 'wake' },
        ],
      },
    }))

    assert.equal(message.delivery.mode, 'queued')
    assert.deepEqual(message.delivery.members.map(member => member.mode), ['queued', 'wake'])
    assert.equal(message.delivery.delivered, false)

    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    const persisted = reloaded.getMessage(message.id)
    assert.equal(persisted.delivery.mode, 'queued')
    assert.deepEqual(persisted.delivery.members.map(member => member.mode), ['queued', 'wake'])
  })
})

describe('visibility and per-viewer read state', () => {
  it('splits workspace broadcasts from session-targeted mail and tracks reads per viewer', async () => {
    const { dir, store } = await newStore()
    await store.updateSettings({ allowWorkspaceBroadcast: true })
    const wsA = join(root, 'ws-a')
    const wsB = join(root, 'ws-b')

    const broadcast = await store.addMessage(input({ subject: 'Broadcast', body: 'to alpha' }))
    const direct = await store.addMessage(input({
      to: { sessionId: 's-2', workspacePath: wsA },
      subject: 'Direct',
      body: 'to s-2',
    }))

    // Workspace broadcast: visible to the workspace viewer and to sessions in it.
    assert.deepEqual(store.visibleFor({ workspacePath: wsA }).map(message => message.id), [broadcast.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-1', workspacePath: wsA }).map(message => message.id), [broadcast.id])
    // Session-targeted mail: only that session sees it, even inside the same workspace.
    assert.deepEqual(store.visibleFor({ sessionId: 's-2', workspacePath: wsA }).map(message => message.id), [direct.id, broadcast.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-1', workspacePath: wsA }).map(message => message.id), [broadcast.id])
    // Another workspace sees nothing.
    assert.deepEqual(store.visibleFor({ workspacePath: wsB }), [])
    // 'all' ignores visibility (management view).
    assert.equal(store.visibleFor({ workspacePath: wsB }, 'all').length, 2)

    assert.equal(store.unreadCountFor({ workspacePath: wsA }), 1)
    assert.equal(store.unreadCountFor({ sessionId: 's-1', workspacePath: wsA }), 1)
    assert.equal(store.unreadCountFor({ sessionId: 's-2', workspacePath: wsA }), 2)
    assert.equal(store.unreadMessagesFor({ sessionId: 's-2', workspacePath: wsA }).length, 2)

    // Reads are per viewer: s-1 reading the broadcast does not mark it for s-2
    // or for the workspace-level viewer.
    store.markRead(broadcast.id, 's:s-1')
    assert.equal(store.unreadCountFor({ sessionId: 's-1', workspacePath: wsA }), 0)
    assert.equal(store.unreadCountFor({ sessionId: 's-2', workspacePath: wsA }), 2)

    store.markRead(broadcast.id, viewerKeyFor({ workspacePath: wsA }))
    assert.equal(store.unreadCountFor({ workspacePath: wsA }), 0)
    assert.equal(store.unreadCountFor({ sessionId: 's-2', workspacePath: wsA }), 2)

    await store.flush()
    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.unreadCountFor({ workspacePath: wsA }), 0)
    assert.equal(reloaded.unreadCountFor({ sessionId: 's-1', workspacePath: wsA }), 0)
    assert.equal(reloaded.unreadCountFor({ sessionId: 's-2', workspacePath: wsA }), 2)

    // Returned messages are clones; mutating them must not touch the store.
    const unread = store.unreadMessagesFor({ sessionId: 's-2', workspacePath: wsA })
    unread[0].subject = 'mutated'
    assert.notEqual(store.listMessages()[0].subject, 'mutated')
  })

  it('unreadCountForWorkspace() reports the management-level workspace backlog', async () => {
    const { dir, store } = await newStore()
    await store.updateSettings({ allowWorkspaceBroadcast: true })
    const wsA = join(root, 'ws-a')
    const wsB = join(root, 'ws-b')
    const sessionsA = ['s-a1', 's-a2']

    const broadcast = await store.addMessage(input({ to: { workspacePath: wsA }, subject: 'Broadcast' }))
    const directA1 = await store.addMessage(input({
      to: { sessionId: 's-a1', workspacePath: wsA },
      subject: 'Direct A1',
    }))
    await store.addMessage(input({ to: { sessionId: 's-a2', workspacePath: wsA }, subject: 'Direct A2' }))
    await store.addMessage(input({ to: { workspacePath: wsB }, subject: 'Other workspace' }))

    assert.equal(store.unreadCountForWorkspace(wsA, sessionsA), 3)
    // Without known session ids only broadcasts count for the workspace.
    assert.equal(store.unreadCountForWorkspace(wsA, []), 1)

    // Any session of the workspace reading the broadcast clears it.
    store.markRead(broadcast.id, 's:s-a1')
    assert.equal(store.unreadCountForWorkspace(wsA, sessionsA), 2)
    // A targeted message is only cleared by its own target session.
    store.markRead(directA1.id, 's:s-a2')
    assert.equal(store.unreadCountForWorkspace(wsA, sessionsA), 2)
    store.markRead(directA1.id, 's:s-a1')
    assert.equal(store.unreadCountForWorkspace(wsA, sessionsA), 1)
    // Mail targeted at a session outside the workspace is not workspace mail.
    await store.addMessage(input({ to: { sessionId: 's-elsewhere', workspacePath: wsA }, subject: 'Ghost' }))
    assert.equal(store.unreadCountForWorkspace(wsA, sessionsA), 1)

    await store.flush()
    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.unreadCountForWorkspace(wsA, sessionsA), 1)
  })

  it('hides workspace broadcasts until allowWorkspaceBroadcast is enabled', async () => {
    const { store } = await newStore({ allowWorkspaceBroadcast: false })
    const wsA = join(root, 'ws-a')
    const broadcast = await store.addMessage(input({ to: { workspacePath: wsA }, body: 'guarded broadcast' }))

    // New default: broadcasts are hidden from every viewer by default.
    assert.equal(store.getSettings().allowWorkspaceBroadcast, false)
    assert.deepEqual(store.visibleFor({ workspacePath: wsA }), [])
    assert.deepEqual(store.visibleFor({ sessionId: 's-1', workspacePath: wsA }), [])
    assert.equal(store.unreadCountFor({ sessionId: 's-1', workspacePath: wsA }), 0)
    assert.equal(store.unreadCountForWorkspace(wsA, ['s-1']), 0)

    await store.updateSettings({ allowWorkspaceBroadcast: true })
    assert.deepEqual(store.visibleFor({ workspacePath: wsA }).map(item => item.id), [broadcast.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-1', workspacePath: wsA }).map(item => item.id), [broadcast.id])
    assert.equal(store.unreadCountForWorkspace(wsA, ['s-1']), 1)

    await store.updateSettings({ allowWorkspaceBroadcast: false })
    assert.deepEqual(store.visibleFor({ workspacePath: wsA }), [])
    assert.equal(store.unreadCountForWorkspace(wsA, ['s-1']), 0)
  })

  it('persists read state through flush, including coalesced markRead calls', async () => {
    const { dir, store } = await newStore()

    // Direct durability: markRead -> flush -> a fresh store sees the read.
    const first = await store.addMessage(input({ subject: 'Durable' }))
    store.markRead(first.id, 's:reader')
    assert.equal(store.isRead(store.getMessage(first.id), 's:reader'), true)
    await store.flush()

    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.isRead(reloaded.getMessage(first.id), 's:reader'), true)

    // Coalescing stress: several synchronous mutations while a write is in
    // flight must all survive a single flush (the dirty loop must re-run).
    const second = await store.addMessage(input({ body: 'coalesced' }))
    const pendingSettings = store.updateSettings({ retentionDays: 7 })
    store.markRead(second.id, 's:a')
    store.markRead(second.id, 's:b')
    store.markRead(second.id, 's:a', false)
    await pendingSettings
    await store.flush()

    const again = new MailStore({ dir, now: clock.now })
    await again.load()
    const record = again.getMessage(second.id)
    assert.equal(again.isRead(record, 's:b'), true)
    assert.equal(again.isRead(record, 's:a'), false)
    assert.equal(again.getSettings().retentionDays, 7)
  })
})

describe('threads and replies', () => {
  it('carries threadId/replyTo and increments hop along the thread', async () => {
    const { store } = await newStore()
    const rootMessage = await store.addMessage(input({ subject: 'Root' }))
    const firstReply = await store.addMessage(input({
      from: { sessionId: 's-peer' },
      to: { sessionId: 's-sender' },
      body: 'reply one',
      replyTo: rootMessage.id,
    }))
    assert.equal(firstReply.threadId, rootMessage.id)
    assert.equal(firstReply.replyTo, rootMessage.id)
    assert.equal(firstReply.hop, 1)

    const secondReply = await store.addMessage(input({
      body: 'reply two',
      replyTo: firstReply.id,
    }))
    assert.equal(secondReply.threadId, rootMessage.id)
    assert.equal(secondReply.replyTo, firstReply.id)
    assert.equal(secondReply.hop, 2)

    await expectCode(
      store.addMessage(input({ body: 'orphan', replyTo: 'm-does-not-exist' })),
      'reply-target-not-found',
    )
  })
})

describe('attachments', () => {
  it('copies attachmentSources into the store and survives source deletion', async () => {
    const { store } = await newStore()
    const sources = join(root, 'sources')
    await mkdir(sources)
    const sourcePath = join(sources, 'notes.txt')
    await writeFile(sourcePath, 'attachment content')

    const message = await store.addMessage(input({
      body: 'attached',
      attachmentSources: [{ path: sourcePath, name: 'notes.txt' }],
    }))

    assert.equal(message.files.length, 1)
    const file = message.files[0]
    assert.equal(file.name, 'notes.txt')
    assert.equal(file.bytes, Buffer.byteLength('attachment content'))
    assert.equal(file.mediaType, 'text/plain')
    assert.equal(file.path, join(store.attachmentsDir, message.id, 'notes.txt'))
    assert.ok(file.path.startsWith(store.attachmentsDir))
    assert.equal(await readFile(file.path, 'utf8'), 'attachment content')

    await rm(sourcePath)
    assert.equal(await readFile(file.path, 'utf8'), 'attachment content')

    // Same display name twice inside one message is de-duplicated, keeping both.
    const firstSource = join(sources, 'a.md')
    const secondSource = join(sources, 'b.md')
    await writeFile(firstSource, 'first')
    await writeFile(secondSource, 'second')
    const duplicates = await store.addMessage(input({
      body: 'two attachments',
      attachmentSources: [
        { path: firstSource, name: 'same.txt' },
        { path: secondSource, name: 'same.txt' },
      ],
    }))
    assert.deepEqual(duplicates.files.map(item => item.name), ['same.txt', 'same-2.txt'])
    assert.equal(await readFile(duplicates.files[1].path, 'utf8'), 'second')
  })

  it('accepts a message made only of attachmentSources (no body/data)', async () => {
    const { store } = await newStore()
    const sources = join(root, 'sources')
    await mkdir(sources)
    const sourcePath = join(sources, 'only-attachment.txt')
    await writeFile(sourcePath, 'only attachment')

    const message = await store.addMessage(input({
      subject: '',
      body: '',
      attachmentSources: [{ path: sourcePath }],
    }))
    assert.equal(message.body, '')
    assert.equal(message.data, undefined)
    assert.equal(message.files.length, 1)
    assert.equal(message.files[0].name, 'only-attachment.txt')
    assert.equal(await readFile(message.files[0].path, 'utf8'), 'only attachment')

    const reloaded = new MailStore({ dir: store.dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.getMessage(message.id).files.length, 1)
  })

  it('rejects oversize, too many, over-total and missing attachments', async () => {
    const { store } = await newStore()
    const sources = join(root, 'sources')
    await mkdir(sources)
    const smallA = join(sources, 'a.txt')
    const smallB = join(sources, 'b.txt')
    const big = join(sources, 'big.bin')
    await writeFile(smallA, 'a'.repeat(600))
    await writeFile(smallB, 'b'.repeat(600))
    await writeFile(big, Buffer.alloc(2048))

    await store.updateSettings({ maxFileBytes: 1024 })
    await expectCode(
      store.addMessage(input({ body: 'too big', attachmentSources: [{ path: big }] })),
      'file-too-large',
    )

    await store.updateSettings({ maxFileBytes: 5 * 1024 * 1024, maxFiles: 1 })
    await expectCode(
      store.addMessage(input({
        body: 'too many',
        attachmentSources: [{ path: smallA }, { path: smallB }],
      })),
      'too-many-files',
    )

    await store.updateSettings({ maxFiles: 8, maxFileBytes: 5 * 1024 * 1024, maxTotalFileBytes: 1024 })
    await expectCode(
      store.addMessage(input({
        body: 'over total',
        attachmentSources: [{ path: smallA }, { path: smallB }],
      })),
      'attachments-too-large',
    )

    await expectCode(
      store.addMessage(input({ body: 'missing', attachmentSources: [{ path: join(root, 'nope.txt') }] })),
      'file-not-found',
    )
    await expectCode(
      store.addMessage(input({ body: 'bad shape', attachmentSources: [{}] })),
      'invalid-attachment',
    )
  })
})

describe('message validation', () => {
  it('counts subject length in characters, not UTF-8 bytes', async () => {
    const { store } = await newStore()

    // 70 CJK chars = 210 UTF-8 bytes, but only 70 characters: accepted.
    const seventy = await store.addMessage(input({ subject: '中'.repeat(70), body: 'ok' }))
    assert.equal(seventy.subject, '中'.repeat(70))

    // Exactly the default 200-character cap is accepted for CJK and ASCII.
    const cjkMax = await store.addMessage(input({ subject: '汉'.repeat(200), body: 'ok' }))
    assert.equal(Array.from(cjkMax.subject).length, 200)
    const asciiMax = await store.addMessage(input({ subject: 'a'.repeat(200), body: 'ok' }))
    assert.equal(asciiMax.subject.length, 200)

    // One character over the cap is rejected for both alphabets.
    await expectCode(store.addMessage(input({ subject: '汉'.repeat(201), body: 'ok' })), 'subject-too-long')
    await expectCode(store.addMessage(input({ subject: 'a'.repeat(201), body: 'ok' })), 'subject-too-long')

    // A custom character cap counts CJK characters as one each, and the
    // rejection message documents the character semantics.
    await store.updateSettings({ maxSubjectChars: 5 })
    const five = await store.addMessage(input({ subject: '中'.repeat(5), body: 'ok' }))
    assert.equal(Array.from(five.subject).length, 5)
    const error = await store.addMessage(input({ subject: '中'.repeat(6), body: 'ok' })).catch(caught => caught)
    assert.equal(error.name, 'StoreError')
    assert.equal(error.code, 'subject-too-long')
    assert.match(error.message, /字符/)
  })

  it('enforces subject/body/data limits with distinct StoreError codes', async () => {
    const { store } = await newStore()

    await store.updateSettings({ maxBodyBytes: 256 })
    await expectCode(store.addMessage(input({ body: 'x'.repeat(300) })), 'body-too-long')

    await store.updateSettings({ maxDataBytes: 256 })
    await expectCode(store.addMessage(input({ data: 'y'.repeat(300) })), 'data-too-large')
    await expectCode(store.addMessage(input({ data: 1n })), 'invalid-data')

    await store.updateSettings({ maxSubjectChars: 5 })
    await expectCode(store.addMessage(input({ subject: 'abcdef' })), 'subject-too-long')

    await expectCode(store.addMessage(input({ body: '   ' })), 'empty-message')
    await expectCode(store.addMessage({ to: { workspacePath: join(root, 'ws-a') }, body: 'x' }), 'invalid-message')
    await expectCode(store.addMessage({ from: { sessionId: 's-sender' }, body: 'x' }), 'invalid-message')
    await expectCode(store.addMessage(null), 'invalid-message')
  })
})

describe('retention and clearing', () => {
  it('prune() removes expired mail, enforces maxMessages and deletes attachments', async () => {
    const { store } = await newStore()
    await store.updateSettings({ retentionDays: 30 })
    const sources = join(root, 'sources')
    await mkdir(sources)
    const oldAttachment = join(sources, 'old.txt')
    await writeFile(oldAttachment, 'old attachment')

    clock.set(FIXED - 40 * DAY)
    const old = await store.addMessage(input({
      body: 'old',
      attachmentSources: [{ path: oldAttachment }],
    }))
    clock.set(FIXED - 10 * DAY)
    const recent = await store.addMessage(input({ body: 'recent' }))
    clock.set(FIXED)

    const pruned = await store.prune()
    assert.deepEqual(pruned, { removed: 1, kept: 1 })
    assert.deepEqual(store.listMessages().map(message => message.id), [recent.id])
    assert.equal(store.getMessage(old.id), undefined)
    assert.equal(existsSync(join(store.attachmentsDir, old.id)), false)

    await store.flush()
    const reloaded = new MailStore({ dir: store.dir, now: clock.now })
    await reloaded.load()
    assert.deepEqual(reloaded.listMessages().map(message => message.id), [recent.id])

    // retentionDays === 0 keeps mail regardless of age.
    await reloaded.updateSettings({ retentionDays: 0 })
    clock.set(FIXED + 365 * DAY)
    assert.deepEqual(await reloaded.prune(), { removed: 0, kept: 1 })
    clock.set(FIXED)
    await reloaded.clear('all')

    // maxMessages is enforced both by prune() and by addMessage().
    await reloaded.updateSettings({ retentionDays: 0, maxMessages: 0 })
    const one = await reloaded.addMessage(input({ body: 'one' }))
    clock.advance(1000)
    const two = await reloaded.addMessage(input({ body: 'two' }))
    clock.advance(1000)
    const three = await reloaded.addMessage(input({ body: 'three' }))
    assert.equal(reloaded.listMessages().length, 3)

    await reloaded.updateSettings({ maxMessages: 2 })
    assert.deepEqual(await reloaded.prune(), { removed: 1, kept: 2 })
    assert.equal(reloaded.getMessage(one.id), undefined)
    assert.deepEqual(reloaded.listMessages().map(message => message.id), [three.id, two.id])

    clock.advance(1000)
    const four = await reloaded.addMessage(input({ body: 'four' }))
    assert.deepEqual(reloaded.listMessages().map(message => message.id), [four.id, three.id])
    assert.equal(reloaded.getMessage(two.id), undefined)
  })

  it('clear() distinguishes read-only from full clears', async () => {
    const { dir, store } = await newStore()
    const sources = join(root, 'sources')
    await mkdir(sources)
    const attachment = join(sources, 'keep.txt')
    await writeFile(attachment, 'body')

    const readMessage = await store.addMessage(input({
      body: 'read me',
      attachmentSources: [{ path: attachment }],
    }))
    const keptMessage = await store.addMessage(input({ body: 'keep me' }))
    const another = await store.addMessage(input({ body: 'keep me too' }))
    store.markRead(readMessage.id, 's:reader')
    await store.flush()

    assert.deepEqual(await store.clear('read'), { removed: 1 })
    assert.equal(store.getMessage(readMessage.id), undefined)
    assert.equal(existsSync(join(store.attachmentsDir, readMessage.id)), false)
    assert.deepEqual(store.listMessages().map(message => message.id), [another.id, keptMessage.id])

    assert.deepEqual(await store.clear('all'), { removed: 2 })
    assert.deepEqual(store.listMessages(), [])
    assert.equal(existsSync(join(store.attachmentsDir, keptMessage.id)), false)

    await store.flush()
    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.deepEqual(reloaded.listMessages(), [])

    await expectCode(store.clear('bogus'), 'invalid-scope')
  })
})

describe('corruption recovery and settings', () => {
  it('quarantines an unparseable store.json and continues with an empty store', async () => {
    const dir = join(root, 'store')
    await mkdir(dir, { recursive: true })
    const garbage = '{ this is definitely not json'
    await writeFile(join(dir, 'store.json'), garbage, 'utf8')
    const warnings = []
    const logger = { warn: message => warnings.push(String(message)), error: () => {}, info: () => {} }

    const store = new MailStore({ dir, now: clock.now, logger })
    await store.load()

    assert.deepEqual(store.listMessages(), [])
    assert.deepEqual(store.getSettings(), DEFAULT_SETTINGS)
    const corruptPath = join(dir, `store.corrupt-${FIXED}.json`)
    assert.equal(existsSync(corruptPath), true)
    assert.equal(await readFile(corruptPath, 'utf8'), garbage)
    assert.equal(existsSync(join(dir, 'store.json')), false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /store\.json/)
    assert.equal(existsSync(join(dir, 'attachments')), true)

    // The recovered store remains writable.
    await store.addMessage(input())
    assert.equal(store.listMessages().length, 1)

    // A structurally valid file with bad settings falls back to defaults but
    // keeps seq/messages.
    const other = join(root, 'other-store')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'store.json'), JSON.stringify({
      version: 1,
      seq: 7,
      settings: { defaultDelivery: 'teleport' },
      messages: [],
    }))
    const fallback = new MailStore({ dir: other, now: clock.now })
    await fallback.load()
    assert.deepEqual(fallback.getSettings(), DEFAULT_SETTINGS)
    assert.equal(fallback.seq, 7)
  })

  it('updateSettings() validates, merges and persists patches', async () => {
    const { dir, store } = await newStore({ allowWorkspaceBroadcast: false })

    const updated = await store.updateSettings({ defaultDelivery: 'mailbox', allowWake: false, retentionDays: 7 })
    assert.equal(updated.defaultDelivery, 'mailbox')
    assert.equal(updated.allowWake, false)
    assert.equal(updated.retentionDays, 7)
    // New in review-1: external attachments are opt-in and default off.
    assert.equal(updated.allowExternalAttachments, false)
    // Group member cap default is 32.
    assert.equal(updated.maxGroupMembers, DEFAULT_SETTINGS.maxGroupMembers)
    assert.equal(updated.maxGroupMembers, 32)
    // Running wake targets wait before queueing (new in v0.3.0).
    assert.equal(updated.waitForIdleSeconds, DEFAULT_SETTINGS.waitForIdleSeconds)
    assert.equal(updated.waitForIdleSeconds, 120)
    // Workspace broadcasts are opt-in and default off (privacy hardening).
    assert.equal(updated.allowWorkspaceBroadcast, DEFAULT_SETTINGS.allowWorkspaceBroadcast)
    assert.equal(updated.allowWorkspaceBroadcast, false)
    // Merge, not replace.
    assert.equal(updated.maxMessages, DEFAULT_SETTINGS.maxMessages)
    assert.equal(updated.maxHops, DEFAULT_SETTINGS.maxHops)

    const disk = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'))
    assert.deepEqual(disk.settings, updated)

    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.deepEqual(reloaded.getSettings(), updated)

    const copy = reloaded.getSettings()
    copy.retentionDays = 999
    assert.equal(reloaded.getSettings().retentionDays, 7)

    const invalidPatches = [
      { defaultDelivery: 'push' },
      { promptLocale: 'fr' },
      { allowWake: 'yes' },
      { promptContext: 1 },
      { allowExternalAttachments: 'yes' },
      { allowExternalAttachments: 1 },
      { allowWorkspaceBroadcast: 'yes' },
      { allowWorkspaceBroadcast: 1 },
      { retentionDays: -1 },
      { retentionDays: 999999 },
      { maxMessages: 100001 },
      { wakesPerMinute: 601 },
      { targetWakeCooldownSeconds: 3601 },
      { maxBodyBytes: 255 },
      { maxFiles: 65 },
      { inlineTextBytes: -1 },
      { maxGroupMembers: 0 },
      { maxGroupMembers: 201 },
      { maxGroupMembers: 'many' },
      { waitForIdleSeconds: -1 },
      { waitForIdleSeconds: 601 },
      { waitForIdleSeconds: 'soon' },
      { unknownKey: 1 },
    ]
    for (const patch of invalidPatches) {
      await expectCode(store.updateSettings(patch), 'invalid-settings')
      assert.equal(store.getSettings().defaultDelivery, 'mailbox')
    }
    await expectCode(store.updateSettings('nope'), 'invalid-settings')
    await expectCode(store.updateSettings([]), 'invalid-settings')

    const withExternal = await store.updateSettings({ allowExternalAttachments: true })
    assert.equal(withExternal.allowExternalAttachments, true)
    const withBroadcast = await store.updateSettings({ allowWorkspaceBroadcast: true })
    assert.equal(withBroadcast.allowWorkspaceBroadcast, true)

    const boundary = await store.updateSettings({ retentionDays: 0, maxMessages: 0 })
    assert.equal(boundary.retentionDays, 0)
    assert.equal(boundary.maxMessages, 0)
    // waitForIdleSeconds bounds are inclusive: 0 (queue immediately) and 600.
    const zeroWait = await store.updateSettings({ waitForIdleSeconds: 0 })
    assert.equal(zeroWait.waitForIdleSeconds, 0)
    const maxWait = await store.updateSettings({ waitForIdleSeconds: 600 })
    assert.equal(maxWait.waitForIdleSeconds, 600)
    // Previously persisted values survive a rejected patch.
    assert.equal(maxWait.allowWake, false)
    assert.equal(maxWait.allowExternalAttachments, true)
  })

  it('viewerKeyFor() and canonicalPath() normalize identity', () => {
    assert.equal(viewerKeyFor({ sessionId: 's-1', workspacePath: 'C:\\somewhere' }), 's:s-1')
    assert.equal(viewerKeyFor({ workspacePath: join(root, 'ws-a') }), `w:${canonicalPath(join(root, 'ws-a'))}`)
    assert.equal(viewerKeyFor({}), 'w:<unknown>')
    assert.equal(viewerKeyFor(), 'w:<unknown>')
    if (process.platform === 'win32') {
      assert.equal(canonicalPath('C:\\Temp\\Mixed'), 'c:\\temp\\mixed')
    } else {
      assert.equal(canonicalPath('/tmp/Mixed'), '/tmp/Mixed')
    }
  })
})

describe('manual groups', () => {
  function groupMessage(group, overrides = {}) {
    return input({
      to: { groupId: group.id, memberSessionIds: ['s-1', 's-2'] },
      body: 'group body',
      ...overrides,
    })
  }

  it('creates, lists, looks up and persists groups', async () => {
    const { dir, store } = await newStore()

    const created = await store.createGroup({ name: '  Team Alpha  ', sessionIds: ['s-1', 's-2', 's-1'] })
    assert.match(created.id, /^g-[0-9a-z]+-[0-9a-f]{6}$/)
    assert.equal(created.name, 'Team Alpha')
    assert.deepEqual(created.sessionIds, ['s-1', 's-2'])
    assert.equal(created.createdAt, FIXED)
    assert.equal(created.updatedAt, FIXED)
    assert.deepEqual(store.listGroups(), [created])
    assert.deepEqual(store.getGroup(created.id), created)
    assert.deepEqual(store.getGroupByName('team alpha'), created)
    assert.deepEqual(store.getGroupByName('  TEAM ALPHA  '), created)
    assert.equal(store.getGroup('g-missing'), undefined)
    assert.equal(store.getGroupByName('nope'), undefined)

    clock.advance(1000)
    const second = await store.createGroup({ name: 'Beta Team', sessionIds: ['s-3'] })
    assert.deepEqual(store.listGroups().map(group => group.id), [second.id, created.id])

    clock.advance(1000)
    await store.updateGroup(created.id, { addSessionIds: ['s-4'] })
    assert.deepEqual(store.listGroups().map(group => group.id), [created.id, second.id])
    assert.equal(store.getGroup(created.id).updatedAt, FIXED + 2000)

    const disk = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'))
    assert.equal(Array.isArray(disk.groups), true)
    assert.equal(disk.groups.length, 2)

    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.deepEqual(reloaded.listGroups(), store.listGroups())
    assert.equal(reloaded.getGroupByName('team alpha').sessionIds.length, 3)
  })

  it('validates group names, member lists and the member cap', async () => {
    const { store } = await newStore()

    await expectCode(store.createGroup({ name: '', sessionIds: ['s-1'] }), 'invalid-group-name')
    await expectCode(store.createGroup({ name: '   ', sessionIds: ['s-1'] }), 'invalid-group-name')
    await expectCode(store.createGroup({ name: 'x'.repeat(61), sessionIds: ['s-1'] }), 'invalid-group-name')
    const longName = await store.createGroup({ name: 'x'.repeat(60), sessionIds: ['s-1'] })
    assert.equal(Array.from(longName.name).length, 60)
    await expectCode(store.createGroup({ name: 'No Members At All' }), 'invalid-group-members')
    await expectCode(store.createGroup({ name: 'Bad Members', sessionIds: 's-1' }), 'invalid-group-members')

    const team = await store.createGroup({ name: 'Team', sessionIds: ['s-1'] })
    assert.deepEqual(team.sessionIds, ['s-1'])
    await expectCode(store.createGroup({ name: '  team  ', sessionIds: ['s-2'] }), 'group-name-taken')

    await store.updateSettings({ maxGroupMembers: 2 })
    await expectCode(
      store.createGroup({ name: 'Too Big', sessionIds: ['s-1', 's-2', 's-3'] }),
      'group-too-large',
    )
    const two = await store.createGroup({ name: 'Two', sessionIds: ['s-1', 's-2'] })
    await expectCode(store.updateGroup(two.id, { addSessionIds: ['s-3'] }), 'group-too-large')

    await expectCode(store.updateGroup('g-missing', { name: 'x' }), 'group-not-found')
    await expectCode(store.deleteGroup('g-missing'), 'group-not-found')
    await expectCode(store.updateSettings({ maxGroupMembers: 0 }), 'invalid-settings')
    await expectCode(store.updateSettings({ maxGroupMembers: 201 }), 'invalid-settings')

    // An explicitly empty group is allowed; sending to it is the caller's job.
    const empty = await store.createGroup({ name: 'Empty', sessionIds: [] })
    assert.deepEqual(empty.sessionIds, [])
  })

  it('updates names and members with replace/add/remove mutual exclusion', async () => {
    const { store } = await newStore()
    const group = await store.createGroup({ name: 'Team', sessionIds: ['s-1', 's-2'] })
    const other = await store.createGroup({ name: 'Other', sessionIds: [] })

    clock.advance(1000)
    const replaced = await store.updateGroup(group.id, { sessionIds: ['s-2', 's-3', 's-3'] })
    assert.deepEqual(replaced.sessionIds, ['s-2', 's-3'])
    assert.equal(replaced.updatedAt, FIXED + 1000)

    clock.advance(1000)
    const added = await store.updateGroup(group.id, { addSessionIds: ['s-1', 's-2'] })
    assert.deepEqual(added.sessionIds, ['s-2', 's-3', 's-1'])

    clock.advance(1000)
    const removed = await store.updateGroup(group.id, { removeSessionIds: ['s-2', 's-4'] })
    assert.deepEqual(removed.sessionIds, ['s-3', 's-1'])

    const renamed = await store.updateGroup(group.id, { name: 'Renamed' })
    assert.equal(renamed.name, 'Renamed')
    // Renaming to its own (case-different) name is allowed...
    const recased = await store.updateGroup(group.id, { name: 'RENAMED' })
    assert.equal(recased.name, 'RENAMED')
    // ...but another group's name is taken case-insensitively.
    await expectCode(store.updateGroup(group.id, { name: 'other' }), 'group-name-taken')
    await expectCode(store.updateGroup(other.id, { name: 'renamed' }), 'group-name-taken')

    await expectCode(
      store.updateGroup(group.id, { sessionIds: ['s-1'], addSessionIds: ['s-2'] }),
      'invalid-group-members',
    )
    await expectCode(
      store.updateGroup(group.id, { sessionIds: ['s-1'], removeSessionIds: ['s-2'] }),
      'invalid-group-members',
    )
    // A failed update leaves the group untouched.
    assert.deepEqual(store.getGroup(group.id).sessionIds, ['s-3', 's-1'])
  })

  it('deletes the group but keeps its messages', async () => {
    const { store } = await newStore()
    const group = await store.createGroup({ name: 'Doomed', sessionIds: ['s-1', 's-2'] })
    const message = await store.addMessage(groupMessage(group, { subject: 'Before deletion' }))

    assert.equal(await store.deleteGroup(group.id), true)
    assert.equal(store.getGroup(group.id), undefined)
    assert.deepEqual(store.listGroups(), [])

    const stillThere = store.getMessage(message.id)
    assert.ok(stillThere)
    assert.equal(stillThere.to.groupId, group.id)
    assert.equal(stillThere.to.groupName, 'Doomed')
    assert.deepEqual(store.visibleFor({ sessionId: 's-1' }).map(item => item.id), [message.id])

    await expectCode(store.addMessage(groupMessage(group)), 'group-not-found')
    await expectCode(store.deleteGroup(group.id), 'group-not-found')
  })

  it('validates group messages and stores the member snapshot as given', async () => {
    const { store } = await newStore()
    const group = await store.createGroup({ name: 'Team', sessionIds: ['s-1', 's-2'] })

    await expectCode(store.addMessage(input({ to: { groupId: 'g-missing' } })), 'group-not-found')
    await expectCode(
      store.addMessage(input({ to: { groupId: group.id, sessionId: 's-9' } })),
      'invalid-message',
    )
    await expectCode(
      store.addMessage(input({ to: { groupId: group.id, workspacePath: join(root, 'ws-a') } })),
      'invalid-message',
    )

    const message = await store.addMessage(input({
      to: {
        groupId: group.id,
        groupName: 'caller-supplied-name-is-ignored',
        memberSessionIds: ['s-2', 's-1', 's-2'],
      },
      body: 'snapshot',
    }))
    assert.equal(message.to.groupId, group.id)
    assert.equal(message.to.groupName, 'Team')
    assert.deepEqual(message.to.memberSessionIds, ['s-2', 's-1'])
    assert.equal(message.to.sessionId, undefined)
    assert.equal(message.to.workspacePath, undefined)

    // Store stores whatever snapshot it is given, including the sender; the
    // caller (index.js) is responsible for excluding the sender.
    const withSender = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-sender'] },
      body: 'sender in snapshot',
    }))
    assert.deepEqual(withSender.to.memberSessionIds, ['s-sender'])

    const noSnapshot = await store.addMessage(input({ to: { groupId: group.id }, body: 'none' }))
    assert.deepEqual(noSnapshot.to.memberSessionIds, [])
  })

  it('shows group mail only to the snapshot members, with per-session read state', async () => {
    const { store } = await newStore()
    const group = await store.createGroup({ name: 'Team', sessionIds: ['s-1', 's-2'] })
    const message = await store.addMessage(groupMessage(group))

    assert.deepEqual(store.visibleFor({ sessionId: 's-1' }).map(item => item.id), [message.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-2' }).map(item => item.id), [message.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-3' }), [])
    assert.deepEqual(store.visibleFor({ workspacePath: join(root, 'ws-a') }), [])

    assert.equal(store.unreadCountFor({ sessionId: 's-1' }), 1)
    assert.equal(store.unreadCountFor({ sessionId: 's-2' }), 1)
    assert.equal(store.unreadCountFor({ sessionId: 's-3' }), 0)

    store.markRead(message.id, 's:s-1')
    assert.equal(store.unreadCountFor({ sessionId: 's-1' }), 0)
    assert.equal(store.unreadCountFor({ sessionId: 's-2' }), 1)
    assert.deepEqual(store.unreadMessagesFor({ sessionId: 's-2' }).map(item => item.id), [message.id])

    // Group messages never contribute to workspace-level unread counts.
    assert.equal(store.unreadCountForWorkspace(join(root, 'ws-a'), ['s-1', 's-2']), 0)
    assert.equal(store.unreadCountForWorkspace(join(root, 'ws-b'), ['s-1', 's-2']), 0)

    // Members added after the send cannot see the old message snapshot.
    await store.updateGroup(group.id, { addSessionIds: ['s-3'] })
    assert.deepEqual(store.visibleFor({ sessionId: 's-3' }), [])
    const newer = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-1', 's-2', 's-3'] },
      body: 'newer snapshot',
    }))
    assert.deepEqual(store.visibleFor({ sessionId: 's-3' }).map(item => item.id), [newer.id])
  })
})

describe('mark all read', () => {
  it('marks direct, group and broadcast messages for their recipients and is idempotent', async () => {
    const { dir, store } = await newStore()
    await store.updateSettings({ allowWorkspaceBroadcast: true })
    const wsA = join(root, 'ws-a')
    const group = await store.createGroup({ name: 'Team', sessionIds: ['s-2', 's-3'] })
    const direct = await store.addMessage(input({ to: { sessionId: 's-1' }, body: 'direct' }))
    const groupMessage = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-2', 's-3'] },
      body: 'group',
    }))
    const broadcast = await store.addMessage(input({ to: { workspacePath: wsA }, body: 'broadcast' }))
    const alreadyRead = await store.addMessage(input({ to: { sessionId: 's-4' }, body: 'already' }))
    store.markRead(alreadyRead.id, 's:s-4')
    await store.flush()

    // Sanity: all four are unread for their recipients before markAllRead.
    assert.equal(store.unreadCountFor({ sessionId: 's-1' }), 1)
    assert.equal(store.unreadCountFor({ sessionId: 's-3' }), 1)
    assert.equal(store.unreadCountFor({ workspacePath: wsA }), 1)

    // Only the messages whose readBy set grew count; already-read direct is skipped.
    assert.equal(store.markAllRead(), 3)
    assert.deepEqual(store.getMessage(direct.id).readBy, ['s:s-1'])
    assert.deepEqual(store.getMessage(groupMessage.id).readBy, ['s:s-2', 's:s-3'])
    assert.deepEqual(store.getMessage(broadcast.id).readBy, [`w:${canonicalPath(wsA)}`])
    assert.equal(store.unreadCountFor({ sessionId: 's-1' }), 0)
    assert.equal(store.unreadCountFor({ sessionId: 's-3' }), 0)
    assert.equal(store.unreadCountFor({ workspacePath: wsA }), 0)
    assert.equal(store.unreadCountForWorkspace(wsA, ['s-1', 's-2', 's-3', 's-4']), 0)

    // Idempotent in memory and after reload.
    assert.equal(store.markAllRead(), 0)
    await store.flush()
    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.isRead(reloaded.getMessage(direct.id), 's:s-1'), true)
    assert.equal(reloaded.isRead(reloaded.getMessage(groupMessage.id), 's:s-3'), true)
    assert.equal(reloaded.isRead(reloaded.getMessage(broadcast.id), `w:${canonicalPath(wsA)}`), true)
    assert.equal(reloaded.markAllRead(), 0)

    // A partially-read group message still counts until every member is marked.
    const partial = await reloaded.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-2', 's-3'] },
      body: 'partial',
    }))
    reloaded.markRead(partial.id, 's:s-2')
    assert.equal(reloaded.markAllRead(), 1)
    assert.deepEqual(new Set(reloaded.getMessage(partial.id).readBy), new Set(['s:s-2', 's:s-3']))
  })

  it('does not over-mark workspace/session keys for direct messages', async () => {
    const { store } = await newStore()
    const workspacePath = join(root, 'ws-b')
    const pathKey = canonicalPath(workspacePath)
    const message = await store.addMessage(input({
      to: { sessionId: 's-9', workspacePath },
      body: 'direct with workspacePath',
    }))

    // Direct messages only mark their session target — no w:<path>, and no
    // s:<other session> keys even when workspaceSessions lists them.
    const workspaceSessions = new Map([[pathKey, ['s-9', 's-10']]])
    assert.equal(store.markAllRead({ workspaceSessions }), 1)
    assert.deepEqual(store.getMessage(message.id).readBy, ['s:s-9'])
    assert.equal(store.unreadCountFor({ sessionId: 's-9', workspacePath }), 0)
    assert.equal(store.markAllRead({ workspaceSessions }), 0)
  })

  it('marks group snapshot members even after the group membership changed', async () => {
    const { store } = await newStore()
    const group = await store.createGroup({ name: 'Snapshot Team', sessionIds: ['s-2', 's-3'] })
    const message = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-2', 's-3'] },
      body: 'snapshot',
    }))
    await store.updateGroup(group.id, { removeSessionIds: ['s-2'] })

    assert.equal(store.markAllRead(), 1)
    assert.deepEqual(new Set(store.getMessage(message.id).readBy), new Set(['s:s-2', 's:s-3']))
    assert.equal(store.markAllRead(), 0)
  })

  it('returns 0 on an empty store and for messages with no intended recipients', async () => {
    const { store } = await newStore()
    assert.equal(store.markAllRead(), 0)

    const group = await store.createGroup({ name: 'Empty Team', sessionIds: [] })
    await store.addMessage(input({ to: { groupId: group.id, memberSessionIds: [] }, body: 'nobody' }))
    assert.equal(store.markAllRead(), 0)
  })

  it('clears workspace broadcasts for session viewers via workspaceSessions', async () => {
    const { dir, store } = await newStore()
    await store.updateSettings({ allowWorkspaceBroadcast: true })
    const wsA = join(root, 'ws-a')
    const pathKey = canonicalPath(wsA)
    const broadcast = await store.addMessage(input({ to: { workspacePath: wsA }, body: 'broadcast' }))

    assert.equal(store.unreadCountFor({ sessionId: 's-2', workspacePath: wsA }), 1)
    assert.equal(store.unreadCountFor({ sessionId: 's-3', workspacePath: wsA }), 1)
    assert.equal(store.unreadCountForWorkspace(wsA, ['s-2', 's-3']), 1)

    const workspaceSessions = new Map([[pathKey, ['s-2', 's-3']]])
    assert.equal(store.markAllRead({ workspaceSessions }), 1)
    const readBy = new Set(store.getMessage(broadcast.id).readBy)
    assert.equal(readBy.has(`w:${pathKey}`), true)
    assert.equal(readBy.has('s:s-2'), true)
    assert.equal(readBy.has('s:s-3'), true)
    assert.equal(store.unreadCountFor({ sessionId: 's-2', workspacePath: wsA }), 0)
    assert.equal(store.unreadCountFor({ sessionId: 's-3', workspacePath: wsA }), 0)
    assert.equal(store.unreadCountForWorkspace(wsA, ['s-2', 's-3']), 0)
    assert.equal(store.markAllRead({ workspaceSessions }), 0)

    // Without the map, the previous behaviour only adds the w: key.
    const later = await store.addMessage(input({ to: { workspacePath: wsA }, body: 'later' }))
    assert.equal(store.markAllRead(), 1)
    assert.deepEqual(new Set(store.getMessage(later.id).readBy), new Set([`w:${pathKey}`]))
    assert.equal(store.unreadCountFor({ sessionId: 's-2', workspacePath: wsA }), 1)

    // A later markAll with the map clears it; the read state persists.
    assert.equal(store.markAllRead({ workspaceSessions }), 1)
    assert.equal(store.unreadCountFor({ sessionId: 's-2', workspacePath: wsA }), 0)
    await store.flush()
    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.unreadCountFor({ sessionId: 's-2', workspacePath: wsA }), 0)
    assert.equal(reloaded.markAllRead({ workspaceSessions }), 0)
  })

  it('falls back to current group members for legacy messages without a snapshot', async () => {
    const { dir, store } = await newStore()
    const group = await store.createGroup({ name: 'Legacy Team', sessionIds: ['s-2', 's-3'] })
    // Empty snapshot array is treated like a missing one (legacy).
    const emptySnapshot = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: [] },
      body: 'empty snapshot',
    }))
    await store.flush()

    // Add true legacy records (no memberSessionIds at all) straight into
    // store.json: one for the current group, one whose group was deleted.
    const raw = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'))
    const legacyMessage = (id, groupId, groupName) => ({
      id,
      threadId: id,
      hop: 0,
      createdAt: FIXED,
      from: { sessionId: 's-1' },
      to: { groupId, groupName },
      subject: 'legacy',
      body: 'legacy group body',
      files: [],
      tags: [],
      readBy: [],
      delivery: { requested: 'mailbox', mode: 'mailbox', delivered: false },
    })
    raw.messages.push(legacyMessage('m-legacy-group', group.id, 'Legacy Team'))
    raw.messages.push(legacyMessage('m-legacy-deleted-group', 'g-deleted', 'Deleted Team'))
    await writeFile(join(dir, 'store.json'), JSON.stringify(raw))

    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.getMessage('m-legacy-group').to.memberSessionIds, undefined)
    assert.equal(reloaded.getMessage('m-legacy-deleted-group').to.memberSessionIds, undefined)

    // Current-group message falls back to current members; the deleted group
    // has no fallback recipients and stays unread.
    assert.equal(reloaded.markAllRead(), 2)
    assert.deepEqual(
      new Set(reloaded.getMessage(emptySnapshot.id).readBy),
      new Set(['s:s-2', 's:s-3']),
    )
    assert.deepEqual(
      new Set(reloaded.getMessage('m-legacy-group').readBy),
      new Set(['s:s-2', 's:s-3']),
    )
    assert.deepEqual(reloaded.getMessage('m-legacy-deleted-group').readBy, [])
    assert.equal(reloaded.markAllRead(), 0)
  })
})

describe('group membership privacy', () => {
  it('removes access for members taken out of a live group, but not for current members', async () => {
    const { store } = await newStore()
    const group = await store.createGroup({ name: 'Private Team', sessionIds: ['s-1', 's-2'] })
    const message = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-1', 's-2'] },
      body: 'private group history',
    }))

    assert.deepEqual(store.visibleFor({ sessionId: 's-1' }).map(item => item.id), [message.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-2' }).map(item => item.id), [message.id])

    // Removing s-2 revokes its access to the group's history even though the
    // send-time snapshot still contains it.
    await store.updateGroup(group.id, { removeSessionIds: ['s-2'] })
    assert.deepEqual(store.visibleFor({ sessionId: 's-2' }), [])
    assert.equal(store.unreadCountFor({ sessionId: 's-2' }), 0)
    assert.deepEqual(store.visibleFor({ sessionId: 's-1' }).map(item => item.id), [message.id])

    // Re-adding restores access because the snapshot still names the member.
    await store.updateGroup(group.id, { addSessionIds: ['s-2'] })
    assert.deepEqual(store.visibleFor({ sessionId: 's-2' }).map(item => item.id), [message.id])

    // A member who joined after the send cannot see the old message.
    await store.updateGroup(group.id, { addSessionIds: ['s-3'] })
    assert.deepEqual(store.visibleFor({ sessionId: 's-3' }), [])
  })

  it('keeps send-time snapshot access after the group is deleted', async () => {
    const { store } = await newStore()
    const group = await store.createGroup({ name: 'Deleted Team', sessionIds: ['s-1', 's-2'] })
    const message = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-1', 's-2'] },
      body: 'archived group history',
    }))
    await store.deleteGroup(group.id)

    // Deleted group: snapshot members keep their history.
    assert.deepEqual(store.visibleFor({ sessionId: 's-1' }).map(item => item.id), [message.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-2' }).map(item => item.id), [message.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-3' }), [])

    // Read state still works per snapshot member.
    store.markRead(message.id, 's:s-1')
    assert.equal(store.unreadCountFor({ sessionId: 's-1' }), 0)
    assert.equal(store.unreadCountFor({ sessionId: 's-2' }), 1)
  })

  it('does not restore history to a member removed before the group was deleted', async () => {
    const { dir, store } = await newStore()
    const group = await store.createGroup({ name: 'Tombstone Team', sessionIds: ['s-1', 's-2'] })
    const message = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-1', 's-2'] },
      body: 'private history',
    }))
    await store.updateGroup(group.id, { removeSessionIds: ['s-2'] })
    await store.deleteGroup(group.id)

    // Deletion freezes the then-current members on every message of the group.
    assert.deepEqual(store.getMessage(message.id).to.deletedGroupMemberIds, ['s-1'])
    assert.deepEqual(store.visibleFor({ sessionId: 's-1' }).map(item => item.id), [message.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-2' }), [])
    assert.equal(store.unreadCountFor({ sessionId: 's-2' }), 0)
    assert.deepEqual(store.visibleFor({ sessionId: 's-3' }), [])

    // The frozen member list survives a reload.
    await store.flush()
    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.deepEqual(reloaded.getMessage(message.id).to.deletedGroupMemberIds, ['s-1'])
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-1' }).map(item => item.id), [message.id])
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-2' }), [])
  })

  it('keeps history for a member re-added before the group was deleted', async () => {
    const { store } = await newStore()
    const group = await store.createGroup({ name: 'Returned Team', sessionIds: ['s-1', 's-2'] })
    const message = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-1', 's-2'] },
      body: 'history for returned member',
    }))
    await store.updateGroup(group.id, { removeSessionIds: ['s-2'] })
    await store.updateGroup(group.id, { addSessionIds: ['s-2'] })
    await store.deleteGroup(group.id)

    assert.deepEqual(new Set(store.getMessage(message.id).to.deletedGroupMemberIds), new Set(['s-1', 's-2']))
    assert.deepEqual(store.visibleFor({ sessionId: 's-1' }).map(item => item.id), [message.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-2' }).map(item => item.id), [message.id])
    assert.deepEqual(store.visibleFor({ sessionId: 's-3' }), [])
  })

  it('lets legacy live groups without a snapshot fall back to current members', async () => {
    const { dir, store } = await newStore()
    const group = await store.createGroup({ name: 'Legacy Live', sessionIds: ['s-1', 's-2'] })
    await store.flush()

    const raw = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'))
    raw.messages.push({
      id: 'm-legacy-live',
      threadId: 'm-legacy-live',
      hop: 0,
      createdAt: FIXED,
      from: { sessionId: 's-9' },
      to: { groupId: group.id, groupName: 'Legacy Live' },
      subject: 'legacy',
      body: 'no snapshot live group',
      files: [],
      tags: [],
      readBy: [],
      delivery: { requested: 'mailbox', mode: 'mailbox', delivered: false },
    })
    await writeFile(join(dir, 'store.json'), JSON.stringify(raw))

    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.getMessage('m-legacy-live').to.memberSessionIds, undefined)
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-1' }).map(item => item.id), ['m-legacy-live'])
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-2' }).map(item => item.id), ['m-legacy-live'])
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-3' }), [])

    // Current membership still governs the legacy record.
    await reloaded.updateGroup(group.id, { removeSessionIds: ['s-2'] })
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-1' }).map(item => item.id), ['m-legacy-live'])
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-2' }), [])
  })

  it('keeps legacy deleted-group history for the snapshot when the frozen field is absent', async () => {
    const { dir, store } = await newStore()
    const group = await store.createGroup({ name: 'Legacy Deleted', sessionIds: ['s-1', 's-2'] })
    const message = await store.addMessage(input({
      to: { groupId: group.id, memberSessionIds: ['s-1', 's-2'] },
      body: 'legacy deleted group history',
    }))
    await store.flush()

    // Simulate a record deleted by an older version: group gone, no frozen field.
    const raw = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'))
    raw.groups = raw.groups.filter(item => item.id !== group.id)
    const stored = raw.messages.find(item => item.id === message.id)
    delete stored.to.deletedGroupMemberIds
    await writeFile(join(dir, 'store.json'), JSON.stringify(raw))

    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    assert.equal(reloaded.getMessage(message.id).to.deletedGroupMemberIds, undefined)
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-1' }).map(item => item.id), [message.id])
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-2' }).map(item => item.id), [message.id])
    assert.deepEqual(reloaded.visibleFor({ sessionId: 's-3' }), [])
  })
})

describe('edit messages', () => {
  async function seeded() {
    const { dir, store } = await newStore()
    const message = await store.addMessage(input({
      from: { sessionId: 's-1', workspacePath: join(root, 'ws-a') },
      to: { sessionId: 's-2', workspacePath: join(root, 'ws-a') },
      subject: 'Original',
      body: 'original body',
      data: { n: 1 },
      files: [],
    }))
    return { dir, store, message }
  }

  it('edits subject/body/data, stamps editedAt and preserves recipients, files, read state and delivery', async () => {
    const { dir, store, message } = await seeded()
    store.markRead(message.id, 's:s-2')
    const before = store.getMessage(message.id)

    const updated = await store.editMessage(message.id, {
      subject: '  Edited subject  ',
      body: 'edited body',
      data: { n: 2, tag: 'x' },
    })
    assert.equal(updated.subject, 'Edited subject') // trimmed
    assert.equal(updated.body, 'edited body')
    assert.deepEqual(updated.data, { n: 2, tag: 'x' })
    assert.equal(updated.editedAt, FIXED)
    assert.equal(updated.id, message.id)
    assert.equal(updated.createdAt, message.createdAt)
    assert.deepEqual(updated.from, before.from)
    assert.deepEqual(updated.to, before.to)
    assert.deepEqual(updated.files, before.files)
    assert.deepEqual(updated.readBy, ['s:s-2'])
    assert.deepEqual(updated.delivery, before.delivery)

    // Persisted, including editedAt and the untouched metadata.
    await store.flush()
    const reloaded = new MailStore({ dir, now: clock.now })
    await reloaded.load()
    const persisted = reloaded.getMessage(message.id)
    assert.equal(persisted.subject, 'Edited subject')
    assert.equal(persisted.body, 'edited body')
    assert.deepEqual(persisted.data, { n: 2, tag: 'x' })
    assert.equal(persisted.editedAt, FIXED)
    assert.deepEqual(persisted.readBy, ['s:s-2'])
    assert.deepEqual(persisted.to, before.to)
    assert.deepEqual(persisted.delivery, before.delivery)
  })

  it('supports single-field edits and removes data when the patch carries undefined', async () => {
    const { store, message } = await seeded()

    const bodyOnly = await store.editMessage(message.id, { body: 'body only' })
    assert.equal(bodyOnly.subject, 'Original')
    assert.equal(bodyOnly.body, 'body only')
    assert.deepEqual(bodyOnly.data, { n: 1 })

    const subjectOnly = await store.editMessage(message.id, { subject: 'Subject only' })
    assert.equal(subjectOnly.body, 'body only')
    assert.equal(subjectOnly.subject, 'Subject only')

    const dataOnly = await store.editMessage(message.id, { data: { n: 9 } })
    assert.deepEqual(dataOnly.data, { n: 9 })
    assert.equal(dataOnly.body, 'body only')

    const removed = await store.editMessage(message.id, { data: undefined })
    assert.equal(Object.hasOwn(removed, 'data'), false)
    assert.equal(removed.editedAt, FIXED)
  })

  it('rejects empty, invalid and unknown edits without mutating the message', async () => {
    const { store, message } = await seeded()
    const maxSubjectChars = store.getSettings().maxSubjectChars
    const maxBodyBytes = store.getSettings().maxBodyBytes
    const maxDataBytes = store.getSettings().maxDataBytes

    await expectCode(store.editMessage(message.id, {}), 'invalid-edit')
    await expectCode(store.editMessage(message.id, { foo: 1 }), 'invalid-edit')
    await expectCode(store.editMessage(message.id, { subject: 'x'.repeat(maxSubjectChars + 1) }), 'subject-too-long')
    await expectCode(store.editMessage(message.id, { body: 'x'.repeat(maxBodyBytes + 1) }), 'body-too-long')
    await expectCode(store.editMessage(message.id, { data: { blob: 'x'.repeat(maxDataBytes + 1) } }), 'data-too-large')
    await expectCode(store.editMessage('missing-message', { body: 'x' }), 'message-not-found')

    const unchanged = store.getMessage(message.id)
    assert.equal(unchanged.subject, 'Original')
    assert.equal(unchanged.body, 'original body')
    assert.deepEqual(unchanged.data, { n: 1 })
    assert.equal(unchanged.editedAt, undefined)
  })
})

describe('store schema versions and upgrades', () => {
  it('migrates a v1 store to the current schema and keeps its data', async () => {
    const { dir, store } = await newStore({ allowWorkspaceBroadcast: false })
    const message = await store.addMessage(input({
      to: { sessionId: 's-migrate', workspacePath: join(root, 'ws-a') },
      subject: 'v1 subject',
      body: 'v1 body',
      data: { v: 1 },
    }))
    await store.flush()

    const raw = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'))
    raw.version = 1
    await writeFile(join(dir, 'store.json'), JSON.stringify(raw))

    const migrated = new MailStore({ dir, now: clock.now })
    await migrated.load()
    activeStore = migrated

    assert.equal(migrated.storeVersion, STORE_VERSION)
    assert.equal(STORE_VERSION, 2)
    assert.equal(migrated.getMessage(message.id).subject, 'v1 subject')
    assert.deepEqual(migrated.getMessage(message.id).data, { v: 1 })
    assert.deepEqual(migrated.getStoreInfo(), {
      schemaVersion: 2,
      supportedVersion: 2,
      storeDir: dir,
      messages: 1,
      groups: 0,
    })
    assert.equal(JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')).version, 2)
  })

  it('treats a missing version as v1 and writes v2 after load', async () => {
    const dir = join(root, 'missing-version')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'store.json'), JSON.stringify({
      seq: 0,
      settings: {},
      messages: [],
      groups: [],
    }))

    const store = new MailStore({ dir, now: clock.now })
    await store.load()
    activeStore = store
    assert.equal(store.storeVersion, 2)
    assert.deepEqual(store.getStoreInfo().schemaVersion, 2)
    assert.equal(JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')).version, 2)
  })

  it('refuses a store written by a newer schema without touching it', async () => {
    const dir = join(root, 'future-version')
    await mkdir(dir, { recursive: true })
    const original = JSON.stringify({ version: 99, messages: [], groups: [] })
    await writeFile(join(dir, 'store.json'), original)

    const store = new MailStore({ dir, now: clock.now })
    await assert.rejects(store.load(), error => {
      assert.equal(error.name, 'StoreError')
      assert.equal(error.code, 'store-version-too-new')
      return true
    })
    assert.equal(await readFile(join(dir, 'store.json'), 'utf8'), original)
  })

  it('refuses invalid schema versions', async () => {
    const invalidVersions = [0, -1, 2.5, '2']
    for (const [index, version] of invalidVersions.entries()) {
      const dir = join(root, `invalid-version-${index}`)
      await mkdir(dir, { recursive: true })
      const original = JSON.stringify({ version, messages: [], groups: [] })
      await writeFile(join(dir, 'store.json'), original)

      const store = new MailStore({ dir, now: clock.now })
      await assert.rejects(store.load(), error => {
        assert.equal(error.name, 'StoreError')
        assert.equal(error.code, 'store-version-invalid')
        return true
      })
      // A refused version must never rewrite or rename the user's file.
      assert.equal(await readFile(join(dir, 'store.json'), 'utf8'), original)
      assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('store.corrupt-')), [])
    }
  })

  it('reports version 2 for a fresh store and exposes the migration helpers', async () => {
    const { store } = await newStore({ allowWorkspaceBroadcast: false })
    const info = store.getStoreInfo()
    assert.deepEqual(
      { schemaVersion: info.schemaVersion, supportedVersion: info.supportedVersion, messages: info.messages, groups: info.groups },
      { schemaVersion: 2, supportedVersion: 2, messages: 0, groups: 0 },
    )
    assert.equal(info.storeDir, store.dir)
    assert.equal(existsSync(join(store.dir, 'store.json')), false)

    assert.equal(STORE_VERSION, 2)
    assert.equal(typeof STORE_MIGRATIONS[1], 'function')
    const missingVersion = migrateStoreDocument({ seq: 0, groups: [], messages: [] })
    assert.equal(missingVersion.version, 2)
    assert.equal(missingVersion.migrated, true)
    const current = migrateStoreDocument({ version: 2 })
    assert.equal(current.version, 2)
    assert.equal(current.migrated, false)
    await expectCode(Promise.resolve().then(() => migrateStoreDocument({ version: 0 })), 'store-version-invalid')
    await expectCode(Promise.resolve().then(() => migrateStoreDocument({ version: 99 })), 'store-version-too-new')
  })
})
