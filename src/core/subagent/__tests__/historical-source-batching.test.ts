/** Real owned SQLite query counts; every request verifies real retained bytes. No model, Electron or listener. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { beforeAll, afterAll, expect, it } from 'vitest'
import type { Transaction, InStatement } from '@libsql/client'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { up } from '../../../storage/sqlite/migrations/019_subagent_runs.js'
import { ensureSubagentDeltaSchema } from '../durable-schema.js'
import { ensureChildRecoverySchema } from '../child-recovery-schema.js'
import { assertTurnBootstrapArchive, bootstrapHash, turnBootstrapDigest } from '../turn-bootstrap-proof.js'
import { withPublishedChildProof, type PublishedFence, type PublishedChildRef } from '../published-store.js'
import type { ChildProjectionReference } from '../recovery-leases.js'

const root = path.resolve('.e2e-tmp', 'historical-source-batch-' + randomUUID())
const total = Number(process.env.PROOF_REF_COUNT ?? 257), sha = (value: string): string => createHash('sha256').update(value).digest('hex')
if (!Number.isInteger(total) || total < 257 || total > 4096) throw new Error('Fixture supports 257 to 4096 references')
const reportDir = process.env.PROOF_MEASUREMENT_DIR ?? root
const scope = { tenantId: 'synthetic', parentSessionId: 'parent', rootSessionId: 'root', parentTurnId: 'turn', rootRunId: 'root-run', attemptId: 'attempt', streamId: 'stream' }
const base: PublishedFence = { ...scope, generation: 'generation', eventSequence: total, revision: total, usageRevision: total }
const entries: ChildProjectionReference[] = Array.from({ length: total }, (_, index) => ({ projectionIndex: index, field: 'subagentEvent', runId: 'child-' + index, atSeq: 2, sourceAtSeq: 1 }))
const snapshot = JSON.stringify({ streamId: 'stream', eventId: 'stream:' + total, projection: [], projectionIndices: [] })
const archive = sha(entries.map(entry => JSON.stringify(entry) + '\n').join(''))
const digest = turnBootstrapDigest(JSON.stringify(base), snapshot, archive, total, total)
const fence: PublishedFence = { ...base, recoveryMode: 'persisted-published', bootstrapId: 'bootstrap', bootstrapDigest: digest }
const proof = { original_count: total, refs_count: total, archive_digest: archive, snapshot_json: snapshot }
let db: LocalSqliteProcessClient

async function write(fn: (tx: Transaction) => Promise<void>): Promise<void> {
  const tx = await db.transaction('write')
  try { await fn(tx); await tx.commit() } catch (error) { if (!tx.closed) await tx.rollback(); throw error } finally { tx.close() }
}
beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true })
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(root, 'fixture.db').replaceAll('\\', '/') })
  await up(db); await ensureSubagentDeltaSchema(db); await ensureChildRecoverySchema(db)
  await write(async tx => {
    await tx.execute({ sql: 'INSERT INTO subagent_usage_parent_state VALUES(?,?,?,?,?,1)', args: ['synthetic', 'parent', 'generation', total, 0] })
    await tx.execute({ sql: 'INSERT INTO parent_publication_state VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', args: ['synthetic','parent','stream','generation','root','turn','root-run','attempt',total,0,total,0] })
    await tx.execute({ sql: 'INSERT INTO parent_publication_marks VALUES(?,?,?,?,?,?,?)', args: ['synthetic','parent','stream',total,total,'child-'+(total-1),2] })
    await tx.execute({ sql: 'INSERT INTO parent_turn_bootstraps VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: ['bootstrap','synthetic','parent','stream','generation',total,total,total,JSON.stringify(base),snapshot,archive,digest,total,total,1] })
    for (const [index, entry] of entries.entries()) {
      const identity = JSON.stringify({ ...scope, runId: entry.runId, parentConversationId: 'turn', parentMessageId: 'message-' + index, parentToolCallId: 'tool-' + index, childSessionId: 'session-' + index, modelId: 'no-model', createdAt: index })
      await tx.execute({ sql: 'INSERT INTO subagent_records VALUES(?,?,?)', args: ['synthetic',entry.runId,identity] })
      for (const seq of [1,2]) await tx.execute({ sql: 'INSERT INTO subagent_checkpoints VALUES(?,?,?,?)', args: ['synthetic',entry.runId,seq,identity] })
      await tx.execute({ sql: 'INSERT INTO parent_published_child_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', args: ['synthetic','parent','stream',entry.runId,index+1,0,index+1,1,identity,1,0,null] })
      await tx.execute({ sql: 'INSERT INTO parent_published_child_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', args: ['synthetic','parent','stream',entry.runId,index+1,index+1,null,2,identity,2,0,null] })
      const encoded = JSON.stringify(entry)
      await tx.execute({ sql: 'INSERT INTO parent_turn_bootstrap_refs VALUES(?,?,?,?,?,?)', args: ['bootstrap',index,entry.runId,2,encoded,bootstrapHash(encoded)] })
    }
  })
})
afterAll(async () => {
  if (db) {
    const receipt = await db.closeWithReceipt()
    fs.writeFileSync(path.join(reportDir,'native-close-' + process.env.PROOF_VARIANT + '.json'), JSON.stringify(receipt, null, 2))
    expect(receipt.healthy).toBe(true)
  }
})

async function verify(): Promise<{ totalQueries: number; retainedScans: number; entriesRead: number; wallMs: number; hostCpuMs: number; hostRssBefore: number; hostRssAfter: number }> {
  let totalQueries = 0, retainedScans = 0, entriesRead = 0
  const hostRssBefore = process.memoryUsage().rss, start = performance.now(), cpu = process.cpuUsage(), tx = await db.transaction('read')
  const counted = new Proxy(tx, { get(target, property, receiver) {
    if (property === 'execute') return async (statement: InStatement) => {
      const sql = typeof statement === 'string' ? statement : statement.sql
      totalQueries++; if (sql.includes('AND NOT EXISTS(SELECT 1 FROM subagent_checkpoints')) retainedScans++
      const result = await target.execute(statement)
      if (sql.startsWith('SELECT * FROM parent_turn_bootstrap_refs')) entriesRead += result.rows.length
      return result
    }
    const value: unknown = Reflect.get(target, property, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  try { await assertTurnBootstrapArchive(counted, fence, proof) } finally { await tx.rollback(); tx.close() }
  const used = process.cpuUsage(cpu)
  return { totalQueries, retainedScans, entriesRead, wallMs: performance.now() - start, hostCpuMs: (used.user + used.system) / 1000, hostRssBefore, hostRssAfter: process.memoryUsage().rss }
}


it('checks all historical sources using bounded physical SQL batches', async () => {
  const result = await verify()
  fs.writeFileSync(path.join(reportDir,'historical-measurement.json'),JSON.stringify({total,...result},null,2))
  expect(result.entriesRead).toBe(total)
  expect(result.retainedScans).toBe(1)
  expect(result.totalQueries).toBeLessThan(16 + 3 * Math.ceil(total/128))
})

async function mutateAndReject(sql: string, args: Array<string|number>, undoSql: string, undoArgs: Array<string|number>): Promise<void> {
  await write(async tx => { await tx.execute({sql,args}) })
  try { await expect(verify()).rejects.toMatchObject({reason:'projection_prefix_mismatch'}) }
  finally { await write(async tx => { await tx.execute({sql:undoSql,args:undoArgs}) }) }
}
it('rejects a missing historical publication even while the exact source checkpoint exists',async()=>{
  await mutateAndReject('UPDATE parent_published_child_versions SET stream_id=? WHERE tenant_id=? AND run_id=? AND at_seq=1',
    ['foreign','synthetic','child-128'],'UPDATE parent_published_child_versions SET stream_id=? WHERE tenant_id=? AND run_id=? AND at_seq=1',['stream','synthetic','child-128'])
})
it('rejects a source publication first admitted after the fence',async()=>{
  await mutateAndReject('UPDATE parent_published_child_versions SET valid_from=? WHERE tenant_id=? AND run_id=? AND at_seq=1',
    [total+1,'synthetic','child-129'],'UPDATE parent_published_child_versions SET valid_from=? WHERE tenant_id=? AND run_id=? AND at_seq=1',[0,'synthetic','child-129'])
})
it('cannot substitute another tenant checkpoint for the missing exact source',async()=>{
  await mutateAndReject('UPDATE subagent_checkpoints SET tenant_id=? WHERE tenant_id=? AND run_id=? AND seq=1',
    ['foreign','synthetic','child-256'],'UPDATE subagent_checkpoints SET tenant_id=? WHERE tenant_id=? AND run_id=? AND seq=1',['synthetic','foreign','child-256'])
})
it('accepts schema1 source events and rejects an event with the wrong schema',async()=>{
  await write(async tx=>{
    await tx.execute({sql:'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=1',args:['synthetic','child-0']})
    await tx.execute({sql:'INSERT INTO subagent_events(tenant_id,run_id,seq,kind,event) VALUES(?,?,?,?,?)',args:['synthetic','child-0',1,'checkpoint',JSON.stringify({schemaVersion:1})]})
  })
  try {
    await verify()
    await write(async tx=>{await tx.execute({sql:'UPDATE subagent_events SET event=? WHERE tenant_id=? AND run_id=? AND seq=1',args:[JSON.stringify({schemaVersion:2}),'synthetic','child-0']})})
    await expect(verify()).rejects.toMatchObject({reason:'projection_prefix_mismatch'})
  }finally{await write(async tx=>{
    await tx.execute({sql:'DELETE FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=1',args:['synthetic','child-0']})
    await tx.execute({sql:'INSERT INTO subagent_checkpoints VALUES(?,?,?,?)',args:['synthetic','child-0',1,'{}']})
  })}
})
it('does not reuse a successful source proof across requests',async()=>{
  await verify()
  await mutateAndReject('UPDATE subagent_checkpoints SET seq=3 WHERE tenant_id=? AND run_id=? AND seq=1',
    ['synthetic','child-130'],'UPDATE subagent_checkpoints SET seq=1 WHERE tenant_id=? AND run_id=? AND seq=3',['synthetic','child-130'])
  await verify()
})
