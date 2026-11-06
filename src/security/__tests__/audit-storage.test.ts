import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalSqliteProcessClient } from '../../storage/sqlite/local-process-client.js'
import { up as originalSchema } from '../../storage/sqlite/migrations/011_add_security_and_perf.js'
import { up as payloadSchema } from '../../storage/sqlite/migrations/031_security_audit_payloads.js'
import { AuditLogStore, auditLogStore } from '../audit-log.js'
import { migrateAuditPayloadBatch } from '../audit-payloads.js'
import { decodeAuditArchive } from '../audit-archive.js'
import { securityRoutes } from '../../api/http/routes/security.js'

let directory: string, archives: string, db: LocalSqliteProcessClient, store: AuditLogStore
const longTarget = `node -e ${'const 示例 = "保留所有参数与换行";\n'.repeat(300)}`
const details = { script: '证据'.repeat(800), source: 'test' }
const daysAgo = (days: number) => Math.floor(Date.now() / 1000) - days * 86400

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-audit-storage-'))
  archives = path.join(directory, 'audit-archive')
  db = new LocalSqliteProcessClient({ url: `file:${path.join(directory, 'audit.db')}` })
  await originalSchema(db)
  await payloadSchema(db)
  store = new AuditLogStore(() => db, () => archives)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await db.closeWithReceipt()
  const resolved = path.resolve(directory)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-audit-storage-')) throw new Error('Unsafe audit fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function append(tenantId = 'a', target = longTarget, decision: 'allow' | 'deny' = 'allow', age = 0) {
  await store.append({ tenantId, sessionId: 'session', category: 'cmd', decision, target, details, reason: 'original reason' })
  const id = Number((await db.execute('SELECT max(id) AS id FROM security_audit_log')).rows[0].id)
  if (age) await db.execute({ sql: 'UPDATE security_audit_log SET created_at=? WHERE id=?', args: [daysAgo(age), id] })
  return id
}

async function count(table: 'security_audit_log' | 'security_audit_payloads' | 'security_audit_archives'): Promise<number> {
  return Number((await db.execute(`SELECT count(*) AS c FROM ${table}`)).rows[0].c)
}

describe('audit evidence storage', () => {
  it('retains every evaluation while sharing exact long UTF-8 evidence only within its tenant', async () => {
    for (let i = 0; i < 4; i++) await append()
    await append('b')
    expect(await count('security_audit_log')).toBe(5)
    expect(await count('security_audit_payloads')).toBe(4)
    const raw = (await db.execute('SELECT target,details,target_ref,details_ref FROM security_audit_log')).rows
    expect(raw.every(row => row.target === '' && row.details === null && row.target_ref && row.details_ref)).toBe(true)
    const payloads = (await db.execute('SELECT encoding,length(content) AS n,raw_bytes FROM security_audit_payloads')).rows
    expect(payloads.every(row => row.encoding === 'gzip' && Number(row.n) < Number(row.raw_bytes) / 4)).toBe(true)
    const result = await store.query({ tenantId: 'a', category: 'cmd', decision: 'allow', limit: 2, offset: 1 })
    expect(result.total).toBe(4)
    expect(result.list.map(row => row.id)).toEqual([3, 2])
    expect(result.list[0]).toMatchObject({ tenantId: 'a', target: longTarget, details, reason: 'original reason' })
  })

  it('preserves short inline fields, null/scalar details and long reasons', async () => {
    await store.append({ tenantId: 'a', category: 'network', target: 'https://example.test', decision: 'deny', details: false, reason: '原因'.repeat(600) })
    const row = (await db.execute('SELECT target,target_ref,details,details_ref,reason,reason_ref FROM security_audit_log')).rows[0]
    expect(row).toMatchObject({ target: 'https://example.test', target_ref: null, details: 'false', details_ref: null, reason: null })
    expect(row.reason_ref).toBeTypeOf('string')
    expect((await store.query({ tenantId: 'a' })).list[0]).toMatchObject({ details: false, reason: '原因'.repeat(600) })
  })

  it('rolls back payload creation when the event insert fails, without blocking the caller', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.append({ tenantId: 'a', target: longTarget, category: 'invalid' as 'cmd', decision: 'allow' })
    expect(warning).toHaveBeenCalledOnce()
    expect(await count('security_audit_log')).toBe(0)
    expect(await count('security_audit_payloads')).toBe(0)
  })

  it('fails explicitly when a referenced payload is missing or corrupted', async () => {
    await append()
    await db.execute("UPDATE security_audit_payloads SET content=x'00'")
    await expect(store.query({ tenantId: 'a' })).rejects.toThrow()
    await db.execute('DELETE FROM security_audit_payloads')
    await expect(store.query({ tenantId: 'a' })).rejects.toThrow(/Missing audit/)
  })

  it('resumes bounded legacy conversion without changing IDs, times, decisions or malformed detail text', async () => {
    for (let i = 0; i < 7; i++) await db.execute({
      sql: 'INSERT INTO security_audit_log(tenant_id,category,target,details,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)',
      args: ['legacy', 'cmd', longTarget, '{malformed legacy data', i % 2 ? 'deny' : 'allow', 'original', 1000 + i],
    })
    expect(await migrateAuditPayloadBatch(db, 3)).toBe(3)
    expect((await store.query({ tenantId: 'legacy' })).total).toBe(7)
    expect(await migrateAuditPayloadBatch(db, 3)).toBe(3)
    expect(await migrateAuditPayloadBatch(db, 3)).toBe(1)
    expect(await migrateAuditPayloadBatch(db, 3)).toBe(0)
    expect(await count('security_audit_payloads')).toBe(1)
    const beforeVersion = (await db.execute('PRAGMA schema_version')).rows[0].schema_version
    await payloadSchema(db)
    expect((await db.execute('PRAGMA schema_version')).rows[0].schema_version).toBe(beforeVersion)
    const result = await store.query({ tenantId: 'legacy' })
    expect(result.list.map(row => [row.id, row.createdAt])).toEqual(Array.from({ length: 7 }, (_, i) => [7 - i, 1006 - i]))
    expect(result.list.every(row => row.target === longTarget && row.details === '{malformed legacy data')).toBe(true)
  })

  it('rolls back an interrupted legacy conversion and resumes safely', async () => {
    await db.execute({ sql: "INSERT INTO security_audit_log(category,target,decision) VALUES('cmd',?,'allow')", args: [longTarget] })
    await db.execute("CREATE TRIGGER fail_backfill BEFORE UPDATE ON security_audit_log BEGIN SELECT RAISE(ABORT,'fixture backfill failure'); END")
    await expect(migrateAuditPayloadBatch(db)).rejects.toThrow(/fixture backfill failure/)
    expect(await count('security_audit_payloads')).toBe(0)
    expect((await db.execute('SELECT target,payload_version FROM security_audit_log')).rows[0]).toMatchObject({ target: longTarget, payload_version: 0 })
    await db.execute('DROP TRIGGER fail_backfill')
    expect(await migrateAuditPayloadBatch(db)).toBe(1)
  })

  it('bounds legacy conversion by evidence bytes while allowing a single oversized row to advance', async () => {
    for (let index = 0; index < 3; index++) await db.execute({ sql: "INSERT INTO security_audit_log(category,target,decision) VALUES('cmd',?,'allow')", args: [longTarget] })
    expect(await migrateAuditPayloadBatch(db, 250, 1024)).toBe(1)
    expect(Number((await db.execute('SELECT count(*) AS c FROM security_audit_log WHERE payload_version=0')).rows[0].c)).toBe(2)
    expect((await store.query()).list.every(row => row.target === longTarget)).toBe(true)
  })
})

describe('durable audit archive and retention', () => {
  it('archives only the requested tenant, preserves shared live payloads and provides independent evidence', async () => {
    const first = await append('a', longTarget, 'allow', 60)
    const second = await append('a', longTarget, 'deny', 60)
    await append('a')
    await append('b', longTarget, 'allow', 60)
    expect(await store.purgeOlderThan(30, { tenantId: 'a', actor: 'operator' })).toBe(2)
    expect((await store.query({ tenantId: 'a' })).list.filter(row => row.target === longTarget)).toHaveLength(1)
    expect((await store.query({ tenantId: 'b' })).total).toBe(1)
    expect(await count('security_audit_payloads')).toBe(4)
    const manifest = await store.listArchives('a')
    expect(manifest.list[0]).toMatchObject({ tenantId: 'a', eventCount: 2, firstId: first, lastId: second, actor: 'operator' })
    const compressed = (await store.readArchive('a', manifest.list[0].archiveId))!
    const decoded = decodeAuditArchive(compressed)
    expect(decoded.events.map(row => row.id)).toEqual([first, second])
    expect(decoded.events[0]).toMatchObject({ target: longTarget, detailsJson: JSON.stringify(details), reason: 'original reason' })
    expect(await store.readArchive('b', manifest.list[0].archiveId)).toBeUndefined()
    expect((await store.query({ tenantId: 'a' })).list[0]).toMatchObject({ target: 'security-audit-archive', details: { actor: 'operator', eventCount: 2 } })
  })

  it('reclaims payloads only after full evidence is durable outside SQLite', async () => {
    await append('a', longTarget, 'allow', 60)
    expect(await store.purgeOlderThan(30, { tenantId: 'a' })).toBe(1)
    expect(await count('security_audit_payloads')).toBe(0)
    const archive = (await store.listArchives('a')).list[0]
    expect(decodeAuditArchive((await store.readArchive('a', archive.archiveId))!).events[0].target).toBe(longTarget)
  })

  it('never deletes events or payloads when durable archive publication fails', async () => {
    await append('a', longTarget, 'allow', 60)
    fs.writeFileSync(archives, 'not a directory')
    await expect(store.purgeOlderThan(30, { tenantId: 'a' })).rejects.toThrow()
    expect(await count('security_audit_log')).toBe(1)
    expect(await count('security_audit_payloads')).toBe(2)
    expect(await count('security_audit_archives')).toBe(0)
  })

  it('recovers a published archive after transaction failure without losing or duplicating events', async () => {
    await append('a', longTarget, 'allow', 60)
    await db.execute("CREATE TRIGGER fail_archive BEFORE DELETE ON security_audit_log BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END")
    await expect(store.purgeOlderThan(30, { tenantId: 'a' })).rejects.toThrow(/fixture archive failure/)
    expect(await count('security_audit_log')).toBe(1)
    expect(await count('security_audit_archives')).toBe(0)
    const filesBefore = fs.readdirSync(archives, { recursive: true }).filter(file => String(file).endsWith('.gz'))
    expect(filesBefore).toHaveLength(1)
    await db.execute('DROP TRIGGER fail_archive')
    expect(await store.purgeOlderThan(30, { tenantId: 'a' })).toBe(1)
    expect(fs.readdirSync(archives, { recursive: true }).filter(file => String(file).endsWith('.gz'))).toEqual(filesBefore)
    expect(await count('security_audit_archives')).toBe(1)
    expect(await store.purgeOlderThan(30, { tenantId: 'a' })).toBe(0)
  })

  it('refuses cleanup if a previously published archive was changed', async () => {
    await append('a', longTarget, 'allow', 60)
    await db.execute("CREATE TRIGGER fail_archive BEFORE DELETE ON security_audit_log BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END")
    await expect(store.purgeOlderThan(30, { tenantId: 'a' })).rejects.toThrow()
    await db.execute('DROP TRIGGER fail_archive')
    const file = fs.readdirSync(archives, { recursive: true }).find(file => String(file).endsWith('.gz'))!
    fs.writeFileSync(path.join(archives, String(file)), 'damaged')
    await expect(store.purgeOlderThan(30, { tenantId: 'a' })).rejects.toThrow(/changed/)
    expect(await count('security_audit_log')).toBe(1)
  })

  it('repeats the durability barrier for an archive published before a sync failure', async () => {
    await append('a', longTarget, 'allow', 60)
    const originalOpen = fsPromises.open.bind(fsPromises)
    let syncAttempts = 0
    const open = vi.spyOn(fsPromises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode)
      if (flags === 'r+' && String(file).endsWith('.jsonl.gz')) {
        syncAttempts++
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('fixture sync failure'), { code: 'EIO' }))
      }
      return handle
    })
    await expect(store.purgeOlderThan(30, { tenantId: 'a' })).rejects.toThrow(/fixture sync failure/)
    await expect(store.purgeOlderThan(30, { tenantId: 'a' })).rejects.toThrow(/fixture sync failure/)
    expect(syncAttempts).toBe(2)
    expect(await count('security_audit_log')).toBe(1)
    expect(await count('security_audit_archives')).toBe(0)
    open.mockRestore()
    expect(await store.purgeOlderThan(30, { tenantId: 'a' })).toBe(1)
  })

  it('bounds expanded archive evidence before fetching repeated payload bodies', async () => {
    for (let index = 0; index < 3; index++) await append('a', longTarget, 'allow', 60)
    expect(await store.purgeOlderThan(30, { tenantId: 'a', maxBatchBytes: 1024, maxBatches: 1 })).toBe(1)
    expect((await store.listArchives('a')).list[0].eventCount).toBe(1)
    expect((await store.query({ tenantId: 'a' })).list.filter(row => row.target === longTarget)).toHaveLength(2)
    expect(await store.purgeOlderThan(30, { tenantId: 'a', maxBatchBytes: 1024 })).toBe(2)
    expect((await store.listArchives('a')).list).toHaveLength(3)
  })

  it('applies tiered online retention and supports zero expiry without discarding archives', async () => {
    const oldAllow = await append('a', 'ordinary', 'allow', 45)
    const recentDeny = await append('a', 'denied', 'deny', 45)
    const oldDeny = await append('a', 'old-denied', 'deny', 200)
    const modeChange = await append('a', 'security-mode-change', 'allow', 45)
    const disabled = await store.maintain({ allowDays: 0, importantDays: 0 })
    expect(disabled.archived).toBe(0)
    const result = await store.maintain({ allowDays: 30, importantDays: 180 }, { batchSize: 1, maxBatches: 1 })
    expect(result).toMatchObject({ archived: 1, hasBacklog: true })
    const second = await store.maintain({ allowDays: 30, importantDays: 180 })
    expect(second).toMatchObject({ archived: 1, hasBacklog: false })
    const remaining = (await store.query({ tenantId: 'a' })).list.map(row => row.id)
    expect(remaining).toEqual(expect.arrayContaining([recentDeny, modeChange]))
    expect(remaining).not.toContain(oldAllow)
    expect(remaining).not.toContain(oldDeny)
    expect((await store.listArchives('a')).total).toBe(2)
  })

  it('stops between batches and rejects invalid retention input', async () => {
    await append('a', longTarget, 'allow', 60)
    const controller = new AbortController()
    controller.abort()
    expect(await store.purgeOlderThan(30, { tenantId: 'a', signal: controller.signal })).toBe(0)
    await expect(store.purgeOlderThan(NaN, { tenantId: 'a' })).rejects.toThrow()
    await expect(store.purgeOlderThan(0, { tenantId: 'a' })).rejects.toThrow()
    await expect(store.purgeOlderThan(1, { tenantId: '' })).rejects.toThrow()
    expect(await count('security_audit_log')).toBe(1)
  })
})

describe('audit HTTP tenant boundary', () => {
  it('keeps cleanup and downloadable archives scoped to the authenticated tenant', async () => {
    vi.stubEnv('AUTH_ENABLED', 'true')
    for (const method of ['query', 'purgeOlderThan', 'listArchives', 'readArchive'] as const) {
      vi.spyOn(auditLogStore, method).mockImplementation(store[method].bind(store) as never)
    }
    const app = Fastify()
    app.addHook('onRequest', async request => {
      ;(request as any).authContext = { tenantId: request.headers['x-test-tenant'] ?? 'a', userId: 'test-user', method: 'jwt', roles: [request.headers['x-test-role'] ?? 'tenant-admin'] }
    })
    await app.register(securityRoutes)
    try {
      await append('a', longTarget, 'allow', 60)
      await append('b', longTarget, 'allow', 60)
      const invalid = await app.inject({ method: 'DELETE', url: '/security/audit-log?days=30junk' })
      expect(invalid.statusCode).toBe(400)
      const denied = await app.inject({ method: 'DELETE', url: '/security/audit-log?days=30', headers: { 'x-test-role': 'user' } })
      expect(denied.json().code).toBe(41015)
      const cleanup = await app.inject({ method: 'DELETE', url: '/security/audit-log?days=30' })
      expect(cleanup.json().data).toMatchObject({ removed: 1, archived: 1, days: 30 })
      const list = await app.inject({ method: 'GET', url: '/security/audit-log/archives' })
      const id = list.json().data[0].archiveId
      const own = await app.inject({ method: 'GET', url: `/security/audit-log/archives/${id}` })
      expect(own.statusCode).toBe(200)
      expect(decodeAuditArchive(own.rawPayload).events[0].target).toBe(longTarget)
      const foreign = await app.inject({ method: 'GET', url: `/security/audit-log/archives/${id}`, headers: { 'x-test-tenant': 'b' } })
      expect(foreign.statusCode).toBe(404)
      const online = await app.inject({ method: 'GET', url: '/security/audit-log', headers: { 'x-test-tenant': 'b' } })
      expect(online.json().data[0]).toMatchObject({ target: longTarget, details })
    } finally { await app.close() }
  })
})
