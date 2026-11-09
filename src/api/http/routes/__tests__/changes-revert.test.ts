import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { ChangeStore, type FileChange, type RevertBatchResult } from '../../../../storage/changes/index.js'
import { canonicalFilePathSync, hashFileContent, readFileVersionSync, withFileLocks } from '../../../../shared/file-version.js'
import { changeRoutes } from '../changes.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { commitWriteChange, readOldSnapshot } from '../../../../tools/file/change-recorder.js'
import type { AgentContext } from '../../../../core/agent-context/index.js'
import { captureCreatedDirectories, missingParentDirectories } from '../../../../storage/changes/directories.js'

/** Real filesystem + SQLite + HTTP: verify effects, versions, scopes and concurrency. */
let db: LocalSqliteProcessClient
let app: FastifyInstance
let store: ChangeStore
let fixture: string
const tenant = 'd2-tenant'
const session = 'd2-session'

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aether-d2-revert-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'changes.db'))
  // Exercise the production transaction/connection lifecycle. libsql's raw
  // :memory: client opens a new empty database after an interactive transaction.
  db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'changes.db')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  store = new ChangeStore()
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { tenantId: request.headers['x-tenant'] ?? tenant } })
  })
  await app.register(changeRoutes)
})

afterEach(async () => {
  await app.close()
  const closed = await db.closeWithReceipt()
  expect(closed.healthy, closed.errors.join('; ')).toBe(true)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(fixture).startsWith('aether-d2-revert-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function mutate(file: string, content: string | null, sessionId = session, tenantId = tenant): Promise<FileChange> {
  return withFileLocks([file], async ([canonical]) => {
    const before = readFileVersionSync(canonical)
    if (content === null) fs.unlinkSync(canonical)
    else { fs.mkdirSync(path.dirname(canonical), { recursive: true }); fs.writeFileSync(canonical, content) }
    return store.record(tenantId, { sessionId, path: canonical, kind: content === null ? 'delete' : 'write',
      oldContent: before.content?.toString('utf8') ?? null, newContent: content,
      oldHash: before.hash, newHash: hashFileContent(content) })
  })
}

async function batch(body: Record<string, unknown> = {}, tenantId = tenant): Promise<RevertBatchResult> {
  const response = await app.inject({ method: 'POST', url: '/changes/revert-batch', headers: { 'x-tenant': tenantId }, payload: { sessionId: session, ...body } })
  expect(response.statusCode).toBe(200)
  const envelope = response.json()
  expect(envelope.code).toBe(200)
  return envelope.data as RevertBatchResult
}

describe('D2 guarded batch revert', () => {
  it('reverts an independent mkdir and later file writes in the same turn without deleting older directories', async () => {
    const prior = path.join(fixture, 'existing'); fs.mkdirSync(prior)
    const run = await rootRunStore.create(tenant, session, 'fixture', [fixture], {})
    const directory = path.join(prior, 'delivery')
    const probe = path.join(directory, '.probe'), absent = missingParentDirectories(probe)
    fs.mkdirSync(directory)
    await store.recordCreatedDirectories(tenant, { sessionId: session, turnId: run.turnId }, captureCreatedDirectories(probe, absent))
    const file = path.join(directory, 'nested', 'report.txt')
    const snapshot = await readOldSnapshot(file)
    fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'report')
    await commitWriteChange({ tenantId: tenant, sessionId: session, turnId: run.turnId, logger: { warn: vi.fn() } } as unknown as AgentContext, file, file, snapshot)
    const preview = await store.previewRevert(tenant, { sessionId: session, fromTurnId: run.turnId, scope: 'all' })
    expect(preview.changes).toHaveLength(2)
    expect(preview.changes.filter(item => item.entryType === 'directory')).toEqual([expect.objectContaining({ path: directory })])
    const result = await batch({ fromTurnId: run.turnId, scope: 'all' })
    expect(result).toMatchObject({ total: 2, reverted: 2, conflicts: 0, unavailable: 0 })
    expect(result.removedDirectories).toEqual([path.dirname(file), directory])
    expect(fs.existsSync(directory)).toBe(false)
    expect(fs.existsSync(prior)).toBe(true)
    expect(await batch({ fromTurnId: run.turnId, scope: 'all' })).toMatchObject({ total: 2, reverted: 0, conflicts: 0 })
  })

  it('protects other writers inside independently created directories and retries safely', async () => {
    const directory = path.join(fixture, 'shared-folder'), probe = path.join(directory, '.probe')
    const absent = missingParentDirectories(probe); fs.mkdirSync(directory)
    const receipts = await store.recordCreatedDirectories(tenant, { sessionId: session }, captureCreatedDirectories(probe, absent))
    const userFile = path.join(directory, 'user.txt'); fs.writeFileSync(userFile, 'user')
    const result = await batch({ scope: 'all' })
    expect(result).toMatchObject({ reverted: 0, conflicts: 1 })
    expect(result.results[0]).toMatchObject({ entryType: 'directory', id: receipts[0].id })
    expect(fs.readFileSync(userFile, 'utf8')).toBe('user')
    fs.unlinkSync(userFile)
    expect(await batch({ scope: 'all' })).toMatchObject({ reverted: 1, removedDirectories: [directory] })
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('rejects another session directory ID without disclosing its path', async () => {
    const directory = path.join(fixture, 'private-folder'), probe = path.join(directory, '.probe')
    const absent = missingParentDirectories(probe); fs.mkdirSync(directory)
    const [receipt] = await store.recordCreatedDirectories(tenant, { sessionId: 'private-session' }, captureCreatedDirectories(probe, absent))
    const result = await batch({ ids: [receipt.id] })
    expect(result.results[0]).toEqual({ id: receipt.id, path: '', status: 'unavailable', message: '改动不存在或不属于当前会话' })
    expect(fs.existsSync(directory)).toBe(true)
  })

  it('preserves a replaced directory or junction when reverting a standalone mkdir receipt', async () => {
    const directory = path.join(fixture, 'owned-folder'), probe = path.join(directory, '.probe')
    const absent = missingParentDirectories(probe); fs.mkdirSync(directory)
    const [receipt] = await store.recordCreatedDirectories(tenant, { sessionId: session }, captureCreatedDirectories(probe, absent))
    const moved = directory + '-moved'; fs.renameSync(directory, moved); fs.mkdirSync(directory)
    expect(await batch({ ids: [receipt.id] })).toMatchObject({ reverted: 0, conflicts: 1, removedDirectories: [] })
    fs.rmdirSync(directory)
    const target = path.join(fixture, 'unrelated'); fs.mkdirSync(target)
    fs.symlinkSync(target, directory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await batch({ ids: [receipt.id] })).toMatchObject({ reverted: 0, conflicts: 1, removedDirectories: [] })
    expect(fs.existsSync(moved)).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.lstatSync(directory).isSymbolicLink()).toBe(true)
  })
  it('previews the authoritative turn scope and only includes command observations that were reviewed', async () => {
    const earlier = await rootRunStore.create(tenant, session, 'fixture', [fixture], {})
    await rootRunStore.update(tenant, earlier.runId, { status: 'succeeded' })
    const current = await rootRunStore.create(tenant, session, 'fixture', [fixture], {})
    const observed = async (name: string, turnId: string) => {
      const file = path.join(fixture, name)
      fs.writeFileSync(file, name)
      return store.record(tenant, { sessionId: session, turnId, path: file, kind: 'write', oldContent: null,
        newContent: name, source: 'command-observation', requiresExplicitRevert: true })
    }
    const prior = await observed('prior.txt', earlier.turnId)
    const first = await observed('command.txt', current.turnId)
    const preview = (await app.inject({ method: 'POST', url: '/changes/revert-preview', payload: {
      sessionId: session, fromTurnId: current.turnId, scope: 'all',
    } })).json()
    expect(preview.data).toMatchObject({ total: 1, changes: [{ id: first.id, requiresExplicitRevert: true }] })
    expect(preview.data.changes[0]).not.toHaveProperty('newContent')
    const raced = await observed('after-preview.txt', current.turnId)
    const result = await batch({ fromTurnId: current.turnId, scope: 'all', reviewedCommandChangeIds: [first.id, prior.id] })
    expect(result).toMatchObject({ total: 2, reverted: 1, unavailable: 1 })
    expect(result.results.find(item => item.id === raced.id)?.status).toBe('unavailable')
    expect(fs.existsSync(first.path)).toBe(false)
    expect(fs.existsSync(prior.path)).toBe(true)
    expect(fs.existsSync(raced.path)).toBe(true)
    expect(await batch({ fromTurnId: current.turnId, scope: 'all', reviewedCommandChangeIds: [raced.id] })).toMatchObject({ reverted: 1, unavailable: 0 })
  })

  it('never resurrects a temporary command log before its creation has been reviewed', async () => {
    const file = path.join(fixture, '.ae-smoke.log')
    fs.writeFileSync(file, 'command output')
    const created = await store.record(tenant, { sessionId: session, path: file, kind: 'write', oldContent: null,
      newContent: 'command output', source: 'command-observation', requiresExplicitRevert: true })
    const deleted = await mutate(file, null)
    const unreviewed = await batch({ scope: 'all' })
    expect(unreviewed).toMatchObject({ reverted: 0, unavailable: 2 })
    expect(fs.existsSync(file)).toBe(false)
    const reviewed = await batch({ scope: 'all', reviewedCommandChangeIds: [created.id] })
    expect(reviewed).toMatchObject({ reverted: 2, unavailable: 0, conflicts: 0 })
    expect(reviewed.results.map(item => item.id)).toEqual([deleted.id, created.id])
    expect(fs.existsSync(file)).toBe(false)
    expect(await batch({ scope: 'all' })).toMatchObject({ reverted: 0, unavailable: 0 })
  })

  it('finishes the already partial command-log rollback after review without replaying reverted records', async () => {
    const file = path.join(fixture, '.ae-smoke.log')
    fs.writeFileSync(file, 'command output')
    const created = await store.record(tenant, { sessionId: session, path: file, kind: 'write', oldContent: null,
      newContent: 'command output', source: 'command-observation', requiresExplicitRevert: true })
    const deleted = await mutate(file, null)
    expect(await batch({ ids: [deleted.id] })).toMatchObject({ reverted: 1 })
    expect(fs.readFileSync(file, 'utf8')).toBe('command output')
    const response = await batch({ scope: 'all', reviewedCommandChangeIds: [created.id] })
    expect(response).toMatchObject({ reverted: 1, unavailable: 0, conflicts: 0 })
    expect(response.results.find(item => item.id === deleted.id)?.status).toBe('already_reverted')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('removes only proven newly created empty directories and preserves preexisting empty folders', async () => {
    const existing = path.join(fixture, 'existing')
    fs.mkdirSync(existing)
    const recordWrite = async (file: string) => {
      const snapshot = await readOldSnapshot(file)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'generated')
      return commitWriteChange({ tenantId: tenant, sessionId: session, logger: { warn: vi.fn() } } as unknown as AgentContext, file, file, snapshot)
    }
    await recordWrite(path.join(existing, 'file.txt'))
    const deep = path.join(fixture, 'new', 'nested')
    const first = await recordWrite(path.join(deep, 'a.txt'))
    const second = await recordWrite(path.join(deep, 'b.txt'))
    const partial = await batch({ ids: [String(first.id)] })
    expect(partial.removedDirectories).toEqual([])
    expect(fs.existsSync(deep)).toBe(true)
    await batch({ ids: [String(second.id)] })
    expect(fs.existsSync(deep)).toBe(true)
    const finished = await batch({ scope: 'all' })
    expect(finished.removedDirectories).toEqual([deep, path.dirname(deep)])
    expect(fs.existsSync(deep)).toBe(false)
    expect(fs.existsSync(existing)).toBe(true)
    expect(fs.readdirSync(existing)).toEqual([])
  })

  it('preserves user contents in created folders and removes them on a later safe retry', async () => {
    const directory = path.join(fixture, 'new-folder'), file = path.join(directory, 'generated.txt')
    const before = await readOldSnapshot(file)
    fs.mkdirSync(directory); fs.writeFileSync(file, 'generated')
    const change = await commitWriteChange({ tenantId: tenant, sessionId: session, logger: { warn: vi.fn() } } as unknown as AgentContext, file, file, before)
    const userFile = path.join(directory, 'user.txt'); fs.writeFileSync(userFile, 'keep')
    expect((await batch({ ids: [change.id] })).removedDirectories).toEqual([])
    expect(fs.readFileSync(userFile, 'utf8')).toBe('keep')
    fs.unlinkSync(userFile)
    expect((await batch({ ids: [change.id] })).removedDirectories).toEqual([directory])
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('reports retained implicit directories as incomplete for whole-turn rollback and clears them on retry', async () => {
    const root = await rootRunStore.create(tenant, session, 'fixture', [fixture], {})
    const directory = path.join(fixture, 'delivery'), file = path.join(directory, 'report.txt')
    const before = await readOldSnapshot(file)
    fs.mkdirSync(directory); fs.writeFileSync(file, 'report')
    await commitWriteChange({ tenantId: tenant, sessionId: session, turnId: root.turnId, logger: { warn: vi.fn() } } as unknown as AgentContext, file, file, before)
    const userFile = path.join(directory, 'user.txt'); fs.writeFileSync(userFile, 'keep me')
    const partial = await batch({ fromTurnId: root.turnId, scope: 'all' })
    expect(partial).toMatchObject({ reverted: 1, conflicts: 1, removedDirectories: [] })
    expect(partial.results.find(item => item.entryType === 'directory')).toMatchObject({ path: directory, status: 'conflict' })
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(userFile, 'utf8')).toBe('keep me')
    fs.unlinkSync(userFile)
    const retry = await batch({ fromTurnId: root.turnId, scope: 'all' })
    expect(retry).toMatchObject({ reverted: 0, conflicts: 0, removedDirectories: [directory] })
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('does not remove a recreated directory with the same name', async () => {
    const directory = path.join(fixture, 'replaced'), file = path.join(directory, 'file.txt')
    const before = await readOldSnapshot(file)
    fs.mkdirSync(directory); fs.writeFileSync(file, 'generated')
    const change = await commitWriteChange({ tenantId: tenant, sessionId: session, logger: { warn: vi.fn() } } as unknown as AgentContext, file, file, before)
    fs.renameSync(directory, directory + '-original')
    fs.mkdirSync(directory); fs.writeFileSync(file, 'generated')
    expect((await batch({ ids: [change.id] })).removedDirectories).toEqual([])
    expect(fs.existsSync(directory)).toBe(true)
    expect(fs.readFileSync(path.join(directory + '-original', 'file.txt'), 'utf8')).toBe('generated')
    expect(await batch({ scope: 'all' })).toMatchObject({ conflicts: 1, removedDirectories: [] })
  })

  it('reports a missing byte snapshot for its own file and still reverts independent paths', async () => {
    const lostFile = path.join(fixture, 'a-lost.bin')
    const bytes = Buffer.from([0, 255, 1])
    fs.writeFileSync(lostFile, bytes)
    const missing = await store.record(tenant, { sessionId: session, path: lostFile, kind: 'write', oldContent: null, newContent: null,
      oldHash: 'missing', newHash: hashFileContent(bytes), truncated: true, newSnapshotRef: 'lost.bin' })
    const independent = await mutate(path.join(fixture, 'z-independent.txt'), 'generated')
    const result = await batch()
    expect(result).toMatchObject({ total: 2, reverted: 1, unavailable: 1, failed: 0 })
    expect(result.results.find(item => item.id === missing.id)?.status).toBe('unavailable')
    expect(fs.readFileSync(lostFile)).toEqual(bytes)
    expect(fs.existsSync(independent.path)).toBe(false)
  })

  it('reverts A→B→C by stable sequence even when all timestamps match and input IDs are shuffled', async () => {
    const file = path.join(fixture, 'same-time.txt')
    fs.writeFileSync(file, 'A\r\n中文')
    vi.spyOn(Date, 'now').mockReturnValue(42)
    const b = await mutate(file, 'B\r\n中文')
    const c = await mutate(file, 'C\r\n中文')
    expect(b.createdAt).toBe(c.createdAt)
    expect(c.seq).toBeGreaterThan(b.seq)
    const response = await batch({ ids: [b.id, c.id] })
    expect(response).toMatchObject({ total: 2, reverted: 2, conflicts: 0, failed: 0, unavailable: 0 })
    expect(response.results.map(item => item.id)).toEqual([c.id, b.id])
    expect(fs.readFileSync(file, 'utf8')).toBe('A\r\n中文')
  })

  it('preserves manual changes, blocks the rest of that file chain, and completes other files', async () => {
    const file = path.join(fixture, 'manual.txt')
    fs.writeFileSync(file, 'A')
    const b = await mutate(file, 'B')
    const c = await mutate(file, 'C')
    fs.writeFileSync(file, 'B') // Looks like an older version, but is a manual edit after C.
    const cleanFile = path.join(fixture, 'clean.txt')
    const clean = await mutate(cleanFile, 'generated')
    const response = await batch()
    expect(response).toMatchObject({ total: 3, reverted: 1, conflicts: 2 })
    expect(response.results.find(item => item.id === c.id)).toMatchObject({ status: 'conflict', expectedHash: hashFileContent('C'), actualHash: hashFileContent('B') })
    expect(response.results.find(item => item.id === b.id)?.status).toBe('conflict')
    expect(fs.readFileSync(file, 'utf8')).toBe('B')
    expect(fs.existsSync(cleanFile)).toBe(false)
    expect((await store.getById(clean.id, tenant))?.status).toBe('reverted')
    expect((await store.getById(c.id, tenant))?.status).toBe('pending')
  })

  it('lists and reverts the complete server scope beyond 200 operations', async () => {
    const file = path.join(fixture, 'long-chain.txt')
    for (let index = 0; index < 205; index++) await mutate(file, `version ${index}`)
    const list = (await app.inject(`/changes?sessionId=${session}`)).json().data as FileChange[]
    expect(list).toHaveLength(205)
    expect(list[0].seq).toBeGreaterThan(list[204].seq)
    const response = await batch()
    expect(response).toMatchObject({ total: 205, reverted: 205, conflicts: 0, unavailable: 0, failed: 0 })
    expect(fs.existsSync(file)).toBe(false)
    expect((await batch()).total).toBe(0)
  })

  it('repeated explicit requests are idempotent even after a later manual edit', async () => {
    const file = path.join(fixture, 'repeat.txt')
    fs.writeFileSync(file, 'original')
    const change = await mutate(file, 'generated')
    expect((await batch({ ids: [change.id] })).reverted).toBe(1)
    fs.writeFileSync(file, 'manual after revert')
    const again = await batch({ ids: [change.id, change.id] })
    expect(again).toMatchObject({ total: 1, reverted: 0, conflicts: 0 })
    expect(again.results[0].status).toBe('already_reverted')
    expect(fs.readFileSync(file, 'utf8')).toBe('manual after revert')
  })

  it('concurrent overlapping batches with opposite path order do not deadlock or apply a snapshot twice', async () => {
    const a = await mutate(path.join(fixture, 'a.txt'), 'a')
    const b = await mutate(path.join(fixture, 'b.txt'), 'b')
    const responses = await Promise.all([batch({ ids: [a.id, b.id] }), batch({ ids: [b.id, a.id] })])
    expect(responses.reduce((sum, response) => sum + response.reverted, 0)).toBe(2)
    expect(responses.flatMap(response => response.results).filter(item => item.status === 'already_reverted')).toHaveLength(2)
    expect(responses.every(response => response.conflicts + response.failed + response.unavailable === 0)).toBe(true)
    expect(fs.existsSync(a.path)).toBe(false)
    expect(fs.existsSync(b.path)).toBe(false)
  })

  it('uses the same lock as writers and rechecks the later version after waiting', async () => {
    const file = path.join(fixture, 'writer.txt')
    fs.writeFileSync(file, 'A')
    const first = await mutate(file, 'B')
    let release!: () => void
    let locked!: () => void
    const acquired = new Promise<void>(done => { locked = done })
    const gate = new Promise<void>(done => { release = done })
    const writer = withFileLocks([file], async ([canonical]) => {
      locked()
      await gate
      fs.writeFileSync(canonical, 'C')
      return store.record(tenant, { sessionId: session, path: canonical, kind: 'write', oldContent: 'B', newContent: 'C' })
    })
    await acquired
    const reverting = batch({ ids: [first.id] })
    release()
    await writer
    expect((await reverting).results[0].status).toBe('conflict')
    expect(fs.readFileSync(file, 'utf8')).toBe('C')
  })

  it('does not skip a later same-hash operation even across tenant/session boundaries', async () => {
    const file = path.join(fixture, 'same-hash.txt')
    fs.writeFileSync(file, 'A')
    const first = await mutate(file, 'B')
    const later = await mutate(file, 'B', 'secret-other-session', 'secret-other-tenant')
    const response = await batch({ ids: [first.id] })
    expect(response.results[0]).toMatchObject({ status: 'conflict', actualHash: first.newHash, expectedHash: first.newHash })
    expect(JSON.stringify(response)).not.toContain('secret-other')
    expect(fs.readFileSync(file, 'utf8')).toBe('B')
    await store.revertBatch('secret-other-tenant', { sessionId: 'secret-other-session', ids: [later.id] })
    expect((await batch({ ids: [first.id] })).reverted).toBe(1)
    expect(fs.readFileSync(file, 'utf8')).toBe('A')
  })

  it('does not revert an old record through an A→B→A→B hash cycle', async () => {
    const file = path.join(fixture, 'cycle.txt')
    fs.writeFileSync(file, 'A')
    const first = await mutate(file, 'B')
    await mutate(file, 'A')
    await mutate(file, 'B')
    expect((await batch({ ids: [first.id] })).conflicts).toBe(1)
    expect(fs.readFileSync(file, 'utf8')).toBe('B')
    expect((await batch()).reverted).toBe(3)
    expect(fs.readFileSync(file, 'utf8')).toBe('A')
  })

  it('distinguishes a missing file from an existing empty file for create/delete restoration', async () => {
    const file = path.join(fixture, 'empty.txt')
    const created = await mutate(file, '')
    const deleted = await mutate(file, null)
    expect(created.oldHash).toBe('missing')
    expect(created.newHash).toBe(hashFileContent(Buffer.alloc(0)))
    expect(deleted.newHash).toBe('missing')
    await batch({ ids: [deleted.id] })
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file).length).toBe(0)
    await batch({ ids: [created.id] })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('kept records are excluded by default, all/time scope includes them, and keep cannot resurrect reverted records', async () => {
    const file = path.join(fixture, 'scope.txt')
    fs.writeFileSync(file, 'A')
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(200)
    const first = await mutate(file, 'B')
    const second = await mutate(file, 'C')
    await app.inject({ method: 'POST', url: `/changes/${second.id}/keep` })
    expect((await batch()).conflicts).toBe(1)
    expect((await batch({ scope: 'all', createdAfter: 100 })).reverted).toBe(1)
    expect(fs.readFileSync(file, 'utf8')).toBe('B')
    expect((await app.inject({ method: 'POST', url: `/changes/${second.id}/keep` })).json().code).toBe(40901)
    expect((await app.inject({ method: 'POST', url: '/changes/keep-many', payload: { sessionId: session, ids: [second.id] } })).json().code).toBe(40901)
    expect((await store.getById(second.id, tenant))?.status).toBe('reverted')
    expect((await batch({ ids: [first.id] })).reverted).toBe(1)
  })

  it('explicit IDs cannot touch a different session or tenant and do not disclose their paths', async () => {
    const wrongSession = await mutate(path.join(fixture, 'other-session.txt'), 'private', 'other-session')
    const wrongTenant = await mutate(path.join(fixture, 'other-tenant.txt'), 'private', session, 'other-tenant')
    const response = await batch({ ids: [wrongSession.id, wrongTenant.id, 'unknown-id'] })
    expect(response).toMatchObject({ total: 3, unavailable: 3, reverted: 0 })
    expect(response.results.every(item => item.path === '')).toBe(true)
    expect(fs.readFileSync(wrongSession.path, 'utf8')).toBe('private')
    expect(fs.readFileSync(wrongTenant.path, 'utf8')).toBe('private')
  })

  it('reports unavailable snapshots and blocks older operations of the same file', async () => {
    const file = path.join(fixture, 'unavailable.bin')
    const first = await mutate(file, 'A')
    fs.writeFileSync(file, Buffer.from([255, 0, 1]))
    const last = await store.record(tenant, { sessionId: session, path: file, kind: 'write', oldContent: 'A', newContent: null,
      oldHash: hashFileContent('A'), newHash: hashFileContent(fs.readFileSync(file)), truncated: true })
    const response = await batch()
    expect(response.results.find(item => item.id === last.id)?.status).toBe('unavailable')
    expect(response.results.find(item => item.id === first.id)?.status).toBe('conflict')
    expect(fs.readFileSync(file)).toEqual(Buffer.from([255, 0, 1]))
  })

  it('rejects a canonical path retargeted to another directory even when bytes match', async () => {
    const original = path.join(fixture, 'original')
    const alternate = path.join(fixture, 'alternate')
    fs.mkdirSync(original)
    fs.mkdirSync(alternate)
    const file = path.join(original, 'file.txt')
    const change = await mutate(file, 'B')
    fs.writeFileSync(path.join(alternate, 'file.txt'), 'B')
    fs.renameSync(original, path.join(fixture, 'moved-original'))
    fs.symlinkSync(alternate, original, process.platform === 'win32' ? 'junction' : 'dir')
    const response = await batch({ ids: [change.id] })
    expect(response.results[0].status).toBe('conflict')
    expect(fs.readFileSync(path.join(alternate, 'file.txt'), 'utf8')).toBe('B')
    expect(fs.readFileSync(path.join(fixture, 'moved-original/file.txt'), 'utf8')).toBe('B')
  })

  it('the old single endpoint returns FileChange on success and an explicit conflict failure', async () => {
    const file = path.join(fixture, 'single.txt')
    const change = await mutate(file, 'generated')
    fs.writeFileSync(file, 'manual')
    expect((await app.inject({ method: 'POST', url: `/changes/${change.id}/revert` })).json().code).toBe(40901)
    expect(fs.readFileSync(file, 'utf8')).toBe('manual')
    fs.writeFileSync(file, 'generated')
    const response = (await app.inject({ method: 'POST', url: `/changes/${change.id}/revert` })).json()
    expect(response.code).toBe(200)
    expect(response.data).toMatchObject({ id: change.id, seq: change.seq, status: 'reverted' })
    expect(fs.existsSync(file)).toBe(false)
  })

  it.each([{ sessionId: '' }, { sessionId: session, ids: [] }, { sessionId: session, scope: 'unknown' }, { sessionId: session, createdAfter: 'bad' }])('rejects invalid batch input %j before side effects', async payload => {
    const file = path.join(fixture, 'invalid.txt')
    await mutate(file, 'untouched')
    const response = await app.inject({ method: 'POST', url: '/changes/revert-batch', payload })
    expect(response.statusCode).toBe(400)
    expect(fs.readFileSync(file, 'utf8')).toBe('untouched')
  })

  it('normalizes existing and absent file aliases onto the same canonical identity', async () => {
    const target = path.join(fixture, 'target')
    const alias = path.join(fixture, 'alias')
    fs.mkdirSync(target)
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(canonicalFilePathSync(path.join(alias, 'new/file.txt'))).toBe(canonicalFilePathSync(path.join(target, 'new/file.txt')))
    const change = await mutate(path.join(alias, 'new/file.txt'), 'B')
    expect(change.path).toBe(canonicalFilePathSync(path.join(target, 'new/file.txt')))
    expect((await batch()).reverted).toBe(1)
    expect(fs.existsSync(path.join(target, 'new/file.txt'))).toBe(false)
  })

  it('reports when bytes were restored but saving the status failed, without retrying destructive writes', async () => {
    const file = path.join(fixture, 'status-failure.txt')
    fs.writeFileSync(file, 'A')
    const change = await mutate(file, 'B')
    const original = store.markStatus.bind(store)
    const marking = vi.spyOn(store, 'markStatus').mockRejectedValueOnce(new Error('database unavailable'))
    const response = await store.revertBatch(tenant, { sessionId: session, ids: [change.id] })
    expect(response.results[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('文件已恢复，但改动状态保存失败') })
    expect(fs.readFileSync(file, 'utf8')).toBe('A')
    marking.mockImplementation(original)
    const again = await store.revertBatch(tenant, { sessionId: session, ids: [change.id] })
    expect(again.results[0].status).toBe('conflict')
    expect(fs.readFileSync(file, 'utf8')).toBe('A')
  })

  it('rejects a dangling directory junction and never creates its missing target', async () => {
    const target = path.join(fixture, 'target')
    const alias = path.join(fixture, 'dangling')
    fs.mkdirSync(target)
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    fs.rmdirSync(target)
    await expect(withFileLocks([path.join(alias, 'file.txt')], async ([canonical]) => {
      fs.mkdirSync(path.dirname(canonical), { recursive: true })
      fs.writeFileSync(canonical, 'must not write')
    })).rejects.toThrow(/symbolic link/)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('revalidates the path target after waiting for a lock', async () => {
    const target = path.join(fixture, 'target')
    const alternate = path.join(fixture, 'alternate')
    const alias = path.join(fixture, 'alias')
    fs.mkdirSync(target)
    fs.mkdirSync(alternate)
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    let release!: () => void
    let locked!: () => void
    const acquired = new Promise<void>(done => { locked = done })
    const gate = new Promise<void>(done => { release = done })
    const first = withFileLocks([path.join(target, 'file.txt')], async () => { locked(); await gate })
    await acquired
    let called = false
    const second = withFileLocks([path.join(alias, 'file.txt')], async () => { called = true })
    fs.unlinkSync(alias)
    fs.symlinkSync(alternate, alias, process.platform === 'win32' ? 'junction' : 'dir')
    release()
    await first
    await expect(second).rejects.toThrow('target changed')
    expect(called).toBe(false)
  })

  it('keeps legacy records visible but unavailable instead of guessing their byte versions', async () => {
    await db.execute(`CREATE TABLE file_changes (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, path TEXT NOT NULL,
      kind TEXT NOT NULL, old_content TEXT, new_content TEXT, truncated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
    )`)
    const file = path.join(fixture, 'legacy.txt')
    fs.writeFileSync(file, 'B')
    await db.execute({ sql: `INSERT INTO file_changes VALUES (?, ?, ?, ?, 'write', 'A', 'B', 0, 'pending', 1)`,
      args: ['legacy', tenant, session, file] })
    const rows = await store.list(tenant, session)
    expect(rows[0]).toMatchObject({ id: 'legacy', seq: 1, oldHash: null, newHash: null })
    expect((await batch()).results[0].status).toBe('unavailable')
    expect(fs.readFileSync(file, 'utf8')).toBe('B')
    const current = await mutate(path.join(fixture, 'new.txt'), 'new')
    expect(current.seq).toBeGreaterThan(rows[0].seq)
    expect((await batch({ ids: [current.id] })).reverted).toBe(1)
  })

  it('reverts from a stable root turn sequence even when turns and changes share timestamps', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const first = await rootRunStore.create(tenant, session, 'fixture', [fixture], { message: '继续' })
    await rootRunStore.update(tenant, first.runId, { status: 'succeeded' })
    const second = await rootRunStore.create(tenant, session, 'fixture', [fixture], { message: '继续' })
    await rootRunStore.update(tenant, second.runId, { status: 'succeeded' })
    const third = await rootRunStore.create(tenant, session, 'fixture', [fixture], { message: '继续' })
    await rootRunStore.update(tenant, third.runId, { status: 'succeeded' })
    const file = path.join(fixture, 'turns.txt')
    const changes: FileChange[] = []
    for (const [index, run] of [first, second, third].entries()) {
      fs.writeFileSync(file, String(index + 1))
      changes.push(await store.record(tenant, { sessionId: session, turnId: run.turnId, runId: run.runId,
        path: file, kind: 'write', oldContent: index === 0 ? null : String(index), newContent: String(index + 1) }))
    }
    await store.markStatus(changes[2].id, tenant, 'kept')
    const response = await batch({ fromTurnId: second.turnId, scope: 'all' })
    expect(response).toMatchObject({ total: 2, reverted: 2, conflicts: 0 })
    expect(response.results.map(result => result.id)).toEqual([changes[2].id, changes[1].id])
    expect(fs.readFileSync(file, 'utf8')).toBe('1')
    expect((await store.getById(changes[0].id, tenant))?.status).toBe('pending')
    const unknown = await app.inject({ method: 'POST', url: '/changes/revert-batch', payload: { sessionId: session, fromTurnId: 'unknown', scope: 'all' } })
    expect(unknown.statusCode).toBe(400)
    const mixed = await app.inject({ method: 'POST', url: '/changes/revert-batch', payload: { sessionId: session, fromTurnId: first.turnId, createdAfter: 0 } })
    expect(mixed.statusCode).toBe(400)
    expect(fs.readFileSync(file, 'utf8')).toBe('1')
  })

  it('attributes child file mutations to the root session, turn and root run for precise revert', async () => {
    const rootRun = await rootRunStore.create(tenant, session, 'fixture', [fixture], {})
    const file = path.join(fixture, 'child.txt')
    const before = await readOldSnapshot(file)
    fs.writeFileSync(file, 'child output')
    const ctx = { tenantId: tenant, sessionId: 'child-session', rootSessionId: session, rootRunId: rootRun.runId,
      turnId: rootRun.turnId, conversationId: 'child-conversation', runId: 'child-run', logger: { warn: vi.fn() } } as unknown as AgentContext
    const recorded = await commitWriteChange(ctx, 'child.txt', file, before)
    expect(recorded).toMatchObject({ sessionId: session, turnId: rootRun.turnId, runId: rootRun.runId })
    expect(await store.list(tenant, 'child-session')).toEqual([])
    expect((await batch({ fromTurnId: rootRun.turnId, scope: 'all' })).reverted).toBe(1)
    expect(fs.existsSync(file)).toBe(false)
  })
})
