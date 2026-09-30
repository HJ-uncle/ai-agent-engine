import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { ChangeStore, type FileChange, type NetFileChange } from '../../../../storage/changes/index.js'
import { hashFileContent, readFileVersionSync, withFileLocks } from '../../../../shared/file-version.js'
import { changeRoutes } from '../changes.js'

let db: Client
let app: FastifyInstance
let store: ChangeStore
let fixture: string
const tenant = 'net-tenant'
const session = 'net-session'

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-changes-net-'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  store = new ChangeStore()
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId: tenant } }) })
  await app.register(changeRoutes)
})

afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
  if (path.dirname(fixture) !== os.tmpdir() || !path.basename(fixture).startsWith('aether-changes-net-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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

async function net(query = ''): Promise<NetFileChange[]> {
  const response = await app.inject(`/changes?sessionId=${session}&view=net${query}`)
  expect(response.statusCode).toBe(200)
  expect(response.json().code).toBe(200)
  return response.json().data
}

async function keep(ids: string[], sessionId: string | undefined = session) {
  return (await app.inject({ method: 'POST', url: '/changes/keep-many', payload: { sessionId, ids } })).json()
}

describe('pending changes represent final byte differences', () => {
  it('hides create→delete without deleting or accepting the original operation log', async () => {
    const file = path.join(fixture, 'temporary.mjs')
    const created = await mutate(file, 'temporary\n')
    const deleted = await mutate(file, null)
    expect(await net()).toEqual([])
    const raw = (await app.inject(`/changes?sessionId=${session}&status=pending`)).json().data as FileChange[]
    expect(raw.map(change => change.id)).toEqual([deleted.id, created.id])
    expect(raw.every(change => change.status === 'pending')).toBe(true)
  })

  it.each(['same bytes\r\n中文\n', ''])('hides delete→recreate only when bytes and existence match (%j)', async original => {
    const file = path.join(fixture, 'restore.txt')
    fs.writeFileSync(file, original)
    await mutate(file, null)
    await mutate(file, original)
    expect(await net()).toEqual([])
  })

  it('reports delete→different recreation as one modification from the original baseline', async () => {
    const file = path.join(fixture, 'replace.txt')
    fs.writeFileSync(file, 'original\n')
    const deleted = await mutate(file, null)
    const created = await mutate(file, 'different\n')
    expect(await net()).toEqual([expect.objectContaining({ id: created.id, changeIds: [deleted.id, created.id],
      kind: 'write', isNew: false, oldContent: 'original\n', newContent: 'different\n' })])
  })

  it('merges repeated edits by insertion sequence and hides exact restoration', async () => {
    const file = path.join(fixture, 'edits.txt')
    fs.writeFileSync(file, 'A')
    vi.spyOn(Date, 'now').mockReturnValue(1)
    const b = await mutate(file, 'B')
    const c = await mutate(file, 'C')
    expect(await net()).toEqual([expect.objectContaining({ changeIds: [b.id, c.id], oldContent: 'A', newContent: 'C', isNew: false })])
    await mutate(file, 'A')
    expect(await net()).toEqual([])
  })

  it('does not cancel equal line counts with different content, line endings or missing vs empty state', async () => {
    const lines = path.join(fixture, 'lines.txt')
    fs.writeFileSync(lines, 'old\n')
    await mutate(lines, 'new\n')
    const eol = path.join(fixture, 'eol.txt')
    fs.writeFileSync(eol, 'same\r\n')
    await mutate(eol, 'same\n')
    const empty = await mutate(path.join(fixture, 'empty.txt'), '')
    const rows = await net()
    expect(rows).toHaveLength(3)
    expect(rows.find(change => change.id === empty.id)).toMatchObject({ isNew: true, oldHash: 'missing', newHash: hashFileContent('') })
  })

  it('keeps a cancelled chain visible when the live file was manually replaced', async () => {
    const file = path.join(fixture, 'manual.txt')
    const first = await mutate(file, 'generated')
    const second = await mutate(file, null)
    fs.writeFileSync(file, 'manual after delete')
    expect(await net()).toEqual([expect.objectContaining({ changeIds: [first.id, second.id], projectionIssue: 'disk-diverged' })])
    const result = await store.revertBatch(tenant, { sessionId: session })
    expect(result).toMatchObject({ reverted: 0, conflicts: 2 })
    expect(fs.readFileSync(file, 'utf8')).toBe('manual after delete')
  })

  it('never merges across unrecorded manual edits, even when the outer versions cancel', async () => {
    const file = path.join(fixture, 'manual-gap.txt')
    fs.writeFileSync(file, 'A')
    const first = await mutate(file, 'B')
    fs.writeFileSync(file, 'manual gap')
    const second = await mutate(file, 'A')
    const rows = await net()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ changeIds: [second.id], oldContent: 'manual gap', newContent: 'A', projectionIssue: 'discontinuous-history' })
    expect(rows[1]).toMatchObject({ changeIds: [first.id], projectionIssue: 'later-change' })
    expect(await store.revertBatch(tenant, { sessionId: session })).toMatchObject({ reverted: 1, conflicts: 1 })
    expect(fs.readFileSync(file, 'utf8')).toBe('manual gap')
  })

  it('treats kept operations as an acceptance boundary', async () => {
    const file = path.join(fixture, 'accepted.txt')
    fs.writeFileSync(file, 'A')
    const first = await mutate(file, 'B')
    const accepted = await mutate(file, 'C')
    await store.markStatus(accepted.id, tenant, 'kept')
    const last = await mutate(file, 'A')
    const rows = await net()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ changeIds: [last.id], oldContent: 'C', newContent: 'A' })
    expect(rows[1]).toMatchObject({ changeIds: [first.id], projectionIssue: 'later-change' })
  })

  it('does not combine through a reverted operation or conceal an older segment', async () => {
    const file = path.join(fixture, 'reverted-boundary.txt')
    fs.writeFileSync(file, 'A')
    const first = await mutate(file, 'B')
    const undone = await mutate(file, 'C')
    await store.revertBatch(tenant, { sessionId: session, ids: [undone.id] })
    const last = await mutate(file, 'A')
    expect((await net()).map(change => change.changeIds)).toEqual([[last.id], [first.id]])
  })

  it.each([['other-session', tenant], [session, 'other-tenant']])('does not combine through other ownership (%s/%s) or leak its metadata', async (otherSession, otherTenant) => {
    const file = path.join(fixture, 'ownership.txt')
    fs.writeFileSync(file, 'A')
    const first = await mutate(file, 'B')
    const secret = await mutate(file, 'B', otherSession, otherTenant)
    const last = await mutate(file, 'A')
    const rows = await net()
    expect(rows.map(change => change.changeIds)).toEqual([[last.id], [first.id]])
    expect(JSON.stringify(rows)).not.toContain(secret.id)
    expect(JSON.stringify(rows)).not.toContain('other-session')
    expect(JSON.stringify(rows)).not.toContain('other-tenant')
  })

  it('uses full hashes for large cancelled files while retaining unavailable nonzero snapshots', async () => {
    const file = path.join(fixture, 'large.txt')
    const first = await mutate(file, 'x'.repeat(100_001))
    expect(await net()).toEqual([expect.objectContaining({ id: first.id, truncated: true, projectionIssue: 'snapshot-unavailable' })])
    await mutate(file, null)
    expect(await net()).toEqual([])
    expect(await store.revertBatch(tenant, { sessionId: session })).toMatchObject({ reverted: 2, unavailable: 0 })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('keeps legacy unknown hashes visible and does not guess from null snapshots', async () => {
    const file = path.join(fixture, 'unknown.txt')
    const changed = await mutate(file, 'B')
    await db.execute({ sql: 'UPDATE file_changes SET old_hash=NULL,new_hash=NULL WHERE id=?', args: [changed.id] })
    expect(await net()).toEqual([expect.objectContaining({ changeIds: [changed.id], projectionIssue: 'snapshot-unavailable', isNew: false })])
  })

  it('does not lose legacy Unicode uppercase paths when normalizing a pending file identity', async () => {
    const file = path.join(fixture, 'Älpha.txt')
    const first = await mutate(file, 'generated')
    await db.execute({ sql: 'UPDATE file_changes SET path=? WHERE id=?', args: [process.platform === 'win32' ? first.path.toUpperCase() : first.path, first.id] })
    expect(await net()).toEqual([expect.objectContaining({ changeIds: [first.id], isNew: true, newContent: 'generated' })])
    await mutate(file, null)
    expect(await net()).toEqual([])
    expect(await store.revertBatch(tenant, { sessionId: session })).toMatchObject({ reverted: 2, conflicts: 0 })
  })

  it('keeps a retargeted physical path visible even when replacement bytes match', async () => {
    const directory = path.join(fixture, 'original')
    const replacement = path.join(fixture, 'replacement')
    fs.mkdirSync(directory)
    fs.mkdirSync(replacement)
    const file = path.join(directory, 'file.txt')
    await mutate(file, 'same')
    await mutate(file, null)
    fs.renameSync(directory, path.join(fixture, 'moved'))
    fs.symlinkSync(replacement, directory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await net()).toEqual([expect.objectContaining({ projectionIssue: 'path-changed' })])
  })

  it('reports unreadable filesystem state instead of making the entire pending panel fail', async () => {
    const file = path.join(fixture, 'directory-now')
    await mutate(file, 'x')
    await mutate(file, null)
    fs.mkdirSync(file)
    expect(await net()).toEqual([expect.objectContaining({ projectionIssue: 'unreadable' })])
  })

  it('projects every operation beyond 200 and keeps/reverts complete grouped membership', async () => {
    const file = path.join(fixture, 'long.txt')
    const ids: string[] = []
    for (let index = 0; index < 205; index++) ids.push((await mutate(file, `version ${index}`)).id)
    expect(await net()).toEqual([expect.objectContaining({ changeIds: ids, oldContent: null, newContent: 'version 204', isNew: true })])
    expect(await keep(ids)).toMatchObject({ code: 200, data: { kept: 205 } })
    expect(await net()).toEqual([])
    expect(await store.revertBatch(tenant, { sessionId: session, ids, scope: 'all' })).toMatchObject({ reverted: 205, conflicts: 0 })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('honours createdAfter scope rather than cancelling against an excluded baseline', async () => {
    const file = path.join(fixture, 'time.txt')
    vi.spyOn(Date, 'now').mockReturnValue(10)
    await mutate(file, 'x')
    vi.mocked(Date.now).mockReturnValue(20)
    const removed = await mutate(file, null)
    expect(await net()).toEqual([])
    expect(await net('&createdAfter=10')).toEqual([expect.objectContaining({ changeIds: [removed.id], oldContent: 'x', newContent: null, kind: 'delete', isNew: false })])
    expect((await app.inject(`/changes?sessionId=${session}&view=net&status=kept`)).statusCode).toBe(400)
  })

  it('recomputes the same projection after an actual process restart', () => {
    const imports = `import fs from 'node:fs'; import path from 'node:path';
      import { ChangeStore } from ${JSON.stringify(pathToFileURL(path.resolve('src/storage/changes/index.ts')).href)};
      import { closeDb } from ${JSON.stringify(pathToFileURL(path.resolve('src/storage/sqlite/db.ts')).href)};
      const store = new ChangeStore(); const root = ${JSON.stringify(fixture)};`
    const result = `const rows = await store.listNet('restart', 'restart');
      const raw = await store.list('restart', 'restart', 'pending');
      console.log(JSON.stringify({ rows, rawCount: raw.length })); closeDb();`
    const seed = `const file = path.join(root, 'persistent.txt');
      fs.writeFileSync(file, 'temporary');
      await store.record('restart', { sessionId: 'restart', path: file, kind: 'write', oldContent: null, newContent: 'temporary' });
      fs.unlinkSync(file);
      await store.record('restart', { sessionId: 'restart', path: file, kind: 'delete', oldContent: 'temporary', newContent: null });
      const visible = path.join(root, 'visible.txt'); fs.writeFileSync(visible, 'visible');
      await store.record('restart', { sessionId: 'restart', path: visible, kind: 'write', oldContent: null, newContent: 'visible' });`
    const run = (script: string) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', imports + script + result], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, env: { ...process.env, DATA_DIR: path.join(fixture, 'history.db') }
    }).trim())
    const before = run(seed)
    const after = run('')
    expect(after).toEqual(before)
    expect(after.rawCount).toBe(3)
    expect(after.rows).toEqual([expect.objectContaining({ newContent: 'visible', isNew: true })])
  })
})

describe('group decisions do not replay cancelled files or partially accept changes', () => {
  it('reverts hidden create/delete and edit/restore chains by changing statuses without filesystem writes', async () => {
    const temporary = path.join(fixture, 'temporary.txt')
    await mutate(temporary, 'generated')
    await mutate(temporary, null)
    const original = path.join(fixture, 'original.txt')
    fs.writeFileSync(original, 'A')
    await mutate(original, 'B')
    await mutate(original, 'A')
    const write = vi.spyOn(fs, 'writeFileSync')
    const unlink = vi.spyOn(fs, 'unlinkSync')
    const mkdir = vi.spyOn(fs, 'mkdirSync')
    expect(await store.revertBatch(tenant, { sessionId: session })).toMatchObject({ reverted: 4, conflicts: 0, failed: 0 })
    expect(write).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(fs.existsSync(temporary)).toBe(false)
    expect(fs.readFileSync(original, 'utf8')).toBe('A')
  })

  it('preserves historical partial revert semantics within a hidden chain', async () => {
    const file = path.join(fixture, 'partial.txt')
    const created = await mutate(file, 'generated')
    const deleted = await mutate(file, null)
    expect(await net()).toEqual([])
    expect(await store.revertBatch(tenant, { sessionId: session, ids: [deleted.id] })).toMatchObject({ reverted: 1 })
    expect(fs.readFileSync(file, 'utf8')).toBe('generated')
    expect((await net()).map(change => change.changeIds)).toEqual([[created.id]])
    expect(await store.revertBatch(tenant, { sessionId: session, ids: [created.id] })).toMatchObject({ reverted: 1 })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('rejects an entire keep request containing another session, unknown or reverted IDs', async () => {
    const first = await mutate(path.join(fixture, 'one.txt'), 'one')
    const other = await mutate(path.join(fixture, 'other.txt'), 'private', 'other-session')
    const removed = await mutate(path.join(fixture, 'removed.txt'), 'removed')
    await store.revertBatch(tenant, { sessionId: session, ids: [removed.id] })
    for (const invalid of [other.id, 'missing', removed.id]) {
      expect(await keep([first.id, invalid])).toMatchObject({ code: 40901 })
      expect((await store.getById(first.id, tenant))?.status).toBe('pending')
    }
    expect((await store.getById(other.id, tenant))?.status).toBe('pending')
    expect((await store.getById(removed.id, tenant))?.status).toBe('reverted')
    expect(await keep([first.id, first.id])).toMatchObject({ code: 200, data: { kept: 1 } })
    expect(await keep([first.id])).toMatchObject({ code: 200, data: { kept: 1 } })
  })

  it('rolls back every keep update if a later row fails', async () => {
    const file = path.join(fixture, 'atomic.txt')
    const ids: string[] = []
    for (let index = 0; index < 205; index++) ids.push((await mutate(file, String(index))).id)
    await db.execute(`CREATE TRIGGER fail_late_keep BEFORE UPDATE OF status ON file_changes WHEN NEW.status='kept' AND OLD.seq=205 BEGIN SELECT RAISE(ABORT, 'forced keep failure'); END`)
    await expect(store.keepMany(tenant, ids, session)).rejects.toThrow('forced keep failure')
    expect(await store.list(tenant, session, 'pending')).toHaveLength(205)
    expect(await store.list(tenant, session, 'kept')).toEqual([])
  })

  it('does not revert a pending selection that became kept while waiting for the file lock', async () => {
    const file = path.join(fixture, 'keep-race.txt')
    const change = await mutate(file, 'generated')
    let release!: () => void
    let acquired!: () => void
    let selected!: () => void
    const locked = new Promise<void>(done => { acquired = done })
    const gate = new Promise<void>(done => { release = done })
    const selection = new Promise<void>(done => { selected = done })
    const holder = withFileLocks([file], async () => { acquired(); await gate })
    await locked
    const list = store.list.bind(store)
    vi.spyOn(store, 'list').mockImplementationOnce(async (...args) => { const rows = await list(...args); selected(); return rows })
    const reverting = store.revertBatch(tenant, { sessionId: session })
    await selection
    await db.execute({ sql: "UPDATE file_changes SET status='kept' WHERE id=?", args: [change.id] })
    release()
    await holder
    expect(await reverting).toMatchObject({ reverted: 0, conflicts: 1 })
    expect(fs.readFileSync(file, 'utf8')).toBe('generated')
    expect((await store.getById(change.id, tenant))?.status).toBe('kept')
  })

  it('blocks older reverts behind a newer legacy Windows path with different letter case', async () => {
    const file = path.join(fixture, 'Ä-case.txt')
    fs.writeFileSync(file, 'A')
    const first = await mutate(file, 'B')
    const later = await mutate(file, 'B', 'other-session')
    await db.execute({ sql: 'UPDATE file_changes SET path=? WHERE id=?', args: [process.platform === 'win32' ? later.path.toUpperCase() : later.path, later.id] })
    expect(await store.revertBatch(tenant, { sessionId: session, ids: [first.id] })).toMatchObject({ reverted: 0, conflicts: 1 })
    expect(fs.readFileSync(file, 'utf8')).toBe('B')
    expect(await net()).toEqual([expect.objectContaining({ changeIds: [first.id], projectionIssue: 'later-change' })])
  })
})
