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

const root = path.resolve('.e2e-tmp', 'proof-batching-' + randomUUID())
const total = Number(process.env.PROOF_REF_COUNT ?? 257), sha = (value: string): string => createHash('sha256').update(value).digest('hex')
if (!Number.isInteger(total) || total < 257 || total > 4096) throw new Error('Fixture supports 257 to 4096 references')
const reportDir = process.env.PROOF_MEASUREMENT_DIR ?? root
const scope = { tenantId: 'synthetic', parentSessionId: 'parent', rootSessionId: 'root', parentTurnId: 'turn', rootRunId: 'root-run', attemptId: 'attempt', streamId: 'stream' }
const base: PublishedFence = { ...scope, generation: 'generation', eventSequence: total, revision: total, usageRevision: total }
const entries: ChildProjectionReference[] = Array.from({ length: total }, (_, index) => ({ projectionIndex: index, field: 'subagentEvent', runId: 'child-' + index, atSeq: 2, ...(index % 13 === 0 ? { sourceAtSeq: 1 } : {}) }))
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

it('verifies every archive row with one global retained scan in one physical transaction', async () => {
  const measurement = await verify()
  fs.writeFileSync(path.join(reportDir,'query-measurement-' + process.env.PROOF_VARIANT + '.json'), JSON.stringify({ at: new Date().toISOString(), total, ...measurement }, null, 2))
  expect(measurement.entriesRead).toBe(total)
  expect(measurement.retainedScans).toBe(1)
})

it('rechecks disk edits between requests even after an earlier successful proof', async () => {
  await verify()
  const saved = JSON.stringify(entries[total-1]), changed = JSON.stringify({ ...entries[total-1], sourceAtSeq: 1 })
  await write(async tx => { await tx.execute({ sql: 'UPDATE parent_turn_bootstrap_refs SET entry_json=?,entry_digest=? WHERE checkpoint_id=? AND projection_index=?', args: [changed,sha(changed),'bootstrap',total-1] }) })
  try { await expect(verify()).rejects.toMatchObject({ reason: 'bootstrap_corrupt' }) }
  finally { await write(async tx => { await tx.execute({ sql: 'UPDATE parent_turn_bootstrap_refs SET entry_json=?,entry_digest=? WHERE checkpoint_id=? AND projection_index=?', args: [saved,sha(saved),'bootstrap',total-1] }) }) }
})

it('rejects a missing checkpoint outside the selected current entry and a missing historical source checkpoint', async () => {
  await write(async tx => { await tx.execute({ sql: 'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?', args: ['synthetic','child-256',2] }) })
  try { await expect(verify()).rejects.toMatchObject({ reason: 'missing_checkpoint' }) }
  finally { await write(async tx => { await tx.execute({ sql: 'INSERT INTO subagent_checkpoints VALUES(?,?,?,?)', args: ['synthetic','child-256',2,'{}'] }) }) }
  await write(async tx => { await tx.execute({ sql: 'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?', args: ['synthetic','child-0',1] }) })
  try { await expect(verify()).rejects.toMatchObject({ reason: 'projection_prefix_mismatch' }) }
  finally { await write(async tx => { await tx.execute({ sql: 'INSERT INTO subagent_checkpoints VALUES(?,?,?,?)', args: ['synthetic','child-0',1,'{}'] }) }) }
})

async function read<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.transaction('read')
  try { return await fn(tx) } finally { await tx.rollback(); tx.close() }
}
async function lookupPublishedChildren(tx: Transaction, selected: PublishedFence, runIds: readonly string[]): Promise<Map<string, PublishedChildRef>> {
  return withPublishedChildProof(tx, selected, async lookup => lookup(runIds))
}

it('cannot reuse the completed proof callback even while the same transaction remains open', async () => {
  await read(async tx => {
    let saved: ((runIds: readonly string[]) => Promise<Map<string, PublishedChildRef>>) | undefined
    await withPublishedChildProof(tx, fence, async lookup => { saved = lookup; expect((await lookup(['child-0'])).size).toBe(1) })
    if (!saved) throw new Error('Fixture did not capture lookup')
    await expect(saved(['child-0'])).rejects.toThrow('outside its transaction scope')
  })
})

it('rejects an in-flight batch whose proof callback ended before the physical SQL result', async () => {
  await read(async tx => {
    let pending: Promise<unknown> | undefined
    await withPublishedChildProof(tx, fence, async lookup => {
      pending = lookup(['child-0']).then(items => ({items}), error => ({error}))
    })
    if (!pending) throw new Error('Fixture did not start lookup')
    expect(await pending).toMatchObject({error:{message:'Published proof batch is outside its transaction scope'}})
  })
})

it('pins the validated fence values when the caller mutates its input during a callback', async () => {
  await read(async tx => {
    const selected = {...fence}
    await withPublishedChildProof(tx, selected, async lookup => {
      selected.tenantId = 'foreign'; selected.revision = 0
      const items = await lookup(['child-0'])
      expect(items.get('child-0')?.identity.tenantId).toBe('synthetic')
      expect(items.get('child-0')?.atSeq).toBe(2)
    })
  })
})

it('keeps batch lookup bound to 128 requested identities and does not invent missing children', async () => {
  await read(async tx => {
    await expect(lookupPublishedChildren(tx, fence, [])).rejects.toThrow(RangeError)
    await expect(lookupPublishedChildren(tx, fence, Array.from({length: 129}, (_, index) => 'child-' + index))).rejects.toThrow(RangeError)
    await expect(lookupPublishedChildren(tx, fence, [''])).rejects.toThrow(RangeError)
    const children = await lookupPublishedChildren(tx, fence, ['child-0', 'absent', 'child-0', 'child-256'])
    expect([...children.keys()].sort()).toEqual(['child-0', 'child-256'])
    expect(children.get('child-0')).toMatchObject({ atSeq: 2, identity: { runId: 'child-0', tenantId: 'synthetic' } })
  })
})

it('rechecks tenant, owner and generation fences for every request', async () => {
  await read(async tx => { expect((await lookupPublishedChildren(tx, fence, ['child-0'])).size).toBe(1) })
  await read(async tx => {
    await expect(lookupPublishedChildren(tx, {...fence, tenantId: 'foreign'}, ['child-0'])).rejects.toMatchObject({reason: 'missing_publication_owner'})
    await expect(lookupPublishedChildren(tx, {...fence, rootRunId: 'foreign'}, ['child-0'])).rejects.toMatchObject({reason: 'scope_mismatch'})
    await expect(lookupPublishedChildren(tx, {...fence, generation: 'foreign'}, ['child-0'])).rejects.toMatchObject({reason: 'generation_changed'})
  })
  await write(async tx => { await tx.execute({sql:'UPDATE parent_publication_state SET floor_revision=? WHERE tenant_id=? AND parent_session_id=? AND stream_id=?',args:[total+1,'synthetic','parent','stream']}) })
  try { await expect(verify()).rejects.toMatchObject({reason:'retention_gap'}) }
  finally { await write(async tx => { await tx.execute({sql:'UPDATE parent_publication_state SET floor_revision=? WHERE tenant_id=? AND parent_session_id=? AND stream_id=?',args:[0,'synthetic','parent','stream']}) }) }
})

it('retains individual raw digest, column binding, entry shape and current sequence checks', async () => {
  const original = JSON.stringify(entries[128])
  for (const [encoded, digestValue, columnSeq, reason] of [
    [original + ' ', sha(original), 2, 'bootstrap_corrupt'],
    [original, sha(original), 1, 'bootstrap_corrupt'],
    [JSON.stringify({...entries[128], unexpected: true}), '', 2, 'invalid_identity'],
    [JSON.stringify({...entries[128], atSeq: 1}), '', 1, 'projection_prefix_mismatch'],
  ] as const) {
    await write(async tx => { await tx.execute({sql:'UPDATE parent_turn_bootstrap_refs SET entry_json=?,entry_digest=?,at_seq=? WHERE checkpoint_id=? AND projection_index=?',args:[encoded,digestValue || sha(encoded),columnSeq,'bootstrap',128]}) })
    try { await expect(verify()).rejects.toMatchObject({reason}) }
    finally { await write(async tx => { await tx.execute({sql:'UPDATE parent_turn_bootstrap_refs SET entry_json=?,entry_digest=?,at_seq=? WHERE checkpoint_id=? AND projection_index=?',args:[original,sha(original),2,'bootstrap',128]}) }) }
  }
})

it('still hashes and verifies the complete body after the complete reference archive', async () => {
  const full = JSON.stringify({streamId:'stream',eventId:'stream:'+total,projection:[{text:'synthetic body'}],projectionIndices:[0]})
  const bodyProof = {...proof, snapshot_json:JSON.stringify({streamId:'stream',eventId:'stream:'+total,projection:[],projectionIndices:[],bodyArchive:{protocolVersion:1,source:'sealed-current-turn',sha256:sha(full),byteLength:Buffer.byteLength(full),chunkCount:1,originalProjectionCount:1,originalCurrentTurnComplete:true,previewComplete:false,endpoint:'/chat/snapshot/body'}})}
  await write(async tx => { await tx.execute({sql:'INSERT INTO parent_turn_bootstrap_body_chunks VALUES(?,?,?,?)',args:['bootstrap',0,full,sha(full)]}) })
  try {
    await read(async tx => { await assertTurnBootstrapArchive(tx,fence,bodyProof) })
    const corrupt = full.replace('synthetic body', 'corrupted body')
    await write(async tx => { await tx.execute({sql:'UPDATE parent_turn_bootstrap_body_chunks SET chunk=?,digest=? WHERE checkpoint_id=? AND part_index=0',args:[corrupt,sha(corrupt),'bootstrap']}) })
    await expect(read(async tx => { await assertTurnBootstrapArchive(tx,fence,bodyProof) })).rejects.toMatchObject({reason:'bootstrap_body_corrupt'})
  } finally { await write(async tx => { await tx.execute({sql:'DELETE FROM parent_turn_bootstrap_body_chunks WHERE checkpoint_id=?',args:['bootstrap']}) }) }
})
