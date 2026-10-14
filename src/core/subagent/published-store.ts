import type { Transaction } from '@libsql/client'
import type { SubagentRun } from './types.js'
import { assertChildUsageFence, childUsageContribution, ensureParentChildUsage, readChildUsageFence, readDurableChildUsage, recoveryVersion, requireChildRecovery, scalarFromRow, type ChildUsageFence, type ChildUsageScalar, type RecoveryQuery } from './child-usage-authority.js'

export const PUBLISHED_CHILD_PAGE_BYTES = 256 * 1024
export interface PublicationScope {
  tenantId: string; parentSessionId: string; rootSessionId: string; parentTurnId: string
  rootRunId: string; attemptId: string; streamId: string
}
export type PublishedChildIdentity = Pick<SubagentRun, 'tenantId' | 'runId' | 'rootSessionId' | 'parentSessionId' | 'parentConversationId' | 'parentMessageId' | 'parentToolCallId' | 'childSessionId' | 'modelId' | 'createdAt' | 'agentId' | 'agentName'>
export interface PublishedChildRef { identity: PublishedChildIdentity; atSeq: number; firstOrdinal: number }
export interface PublishedFence extends PublicationScope {
  generation: string; eventSequence: number; revision: number; usageRevision: number
  recoveryMode?: 'persisted-published'; bootstrapId?: string; bootstrapDigest?: string
}
export interface PublishedPage {
  fence: PublishedFence; totalPublishedCount: number; items: PublishedChildRef[]; includedCount: number
  hasMore: boolean; after: { firstOrdinal: number; runId: string } | null
}
const scopeKeys = ['tenantId', 'parentSessionId', 'rootSessionId', 'parentTurnId', 'rootRunId', 'attemptId', 'streamId'] as const
const scopeColumns = ['tenant_id', 'parent_session_id', 'root_session_id', 'parent_turn_id', 'root_run_id', 'attempt_id', 'stream_id'] as const
function checkedScope(scope: PublicationScope): void {
  for (const key of scopeKeys) if (typeof scope[key] !== 'string' || !scope[key]) requireChildRecovery('invalid_scope')
}
const ownerArgs = (scope: PublicationScope) => [scope.tenantId, scope.parentSessionId, scope.streamId]
const serializedSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const usageFence = (fence: PublishedFence): ChildUsageFence => ({ tenantId: fence.tenantId, parentSessionId: fence.parentSessionId, generation: fence.generation, revision: fence.usageRevision })
async function stateAt(q: RecoveryQuery, scope: PublicationScope) {
  checkedScope(scope)
  const row = (await q.execute({ sql: 'SELECT * FROM parent_publication_state WHERE tenant_id=? AND parent_session_id=? AND stream_id=?', args: ownerArgs(scope) })).rows[0]
  if (!row) requireChildRecovery('missing_publication_owner')
  for (let n = 0; n < scopeKeys.length; n++) if (row[scopeColumns[n]] !== scope[scopeKeys[n]]) requireChildRecovery('scope_mismatch')
  return row
}

/** Only a new, empty stream may acquire an owner. Old streams are never bootstrapped from latest children. */
export async function ensurePublicationOwner(tx: Transaction, scope: PublicationScope): Promise<void> {
  checkedScope(scope)
  const usage = await ensureParentChildUsage(tx, scope.tenantId, scope.parentSessionId)
  const previous = (await tx.execute({ sql: 'SELECT 1 FROM parent_publication_state WHERE tenant_id=? AND parent_session_id=? AND stream_id=?', args: ownerArgs(scope) })).rows[0]
  if (previous) { const row = await stateAt(tx, scope); if (row.generation !== usage.generation) requireChildRecovery('generation_changed'); return }
  await tx.execute({ sql: 'INSERT INTO parent_publication_state(tenant_id,parent_session_id,stream_id,generation,root_session_id,parent_turn_id,root_run_id,attempt_id) VALUES (?,?,?,?,?,?,?,?)',
    args: [...ownerArgs(scope), usage.generation, scope.rootSessionId, scope.parentTurnId, scope.rootRunId, scope.attemptId] })
}

const identityFields = ['tenantId', 'runId', 'rootSessionId', 'parentSessionId', 'parentConversationId', 'parentMessageId', 'parentToolCallId', 'childSessionId', 'modelId', 'createdAt', 'agentId', 'agentName'] as const
const identitySelect = (record: string, header: string) => identityFields.map(key => `coalesce(json_extract(${header},'$.${key}'),json_extract(${record},'$.${key}')) AS ${key}`).join(',')
const metricSelect = (source: string) => `json_extract(${source},'$.usage.totalTokens') AS tokens,json_extract(${source},'$.usage.inputTokens') AS input_tokens,json_extract(${source},'$.usage.outputTokens') AS output_tokens,json_extract(${source},'$.usage.unknown') AS unknown,json_extract(${source},'$.finishedAt') AS finished_at`
async function exactEvidence(q: RecoveryQuery, scope: PublicationScope, runId: string, atSeq: number) {
  if (typeof runId !== 'string' || !runId || recoveryVersion(atSeq) < 1) requireChildRecovery('invalid_identity')
  let row = (await q.execute({ sql: `SELECT ${identitySelect('r.record', 'c.header')},${metricSelect('c.header')} FROM subagent_records r JOIN subagent_checkpoints c ON c.tenant_id=r.tenant_id AND c.run_id=r.run_id WHERE r.tenant_id=? AND r.run_id=? AND c.seq=?`, args: [scope.tenantId, runId, atSeq] })).rows[0]
  if (!row) row = (await q.execute({ sql: `SELECT ${identitySelect("json_extract(event,'$.snapshot')", "json_extract(event,'$.snapshot')")},${metricSelect("json_extract(event,'$.snapshot')")} FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=? AND json_extract(event,'$.schemaVersion')=1`, args: [scope.tenantId, runId, atSeq] })).rows[0]
  if (!row) requireChildRecovery('missing_checkpoint')
  const identity = Object.fromEntries(identityFields.filter(key => row[key] !== null && row[key] !== undefined).map(key => [key, row[key]])) as unknown as PublishedChildIdentity
  for (const key of ['tenantId', 'runId', 'rootSessionId', 'parentSessionId', 'parentConversationId', 'parentMessageId', 'parentToolCallId', 'childSessionId', 'modelId'] as const)
    if (typeof identity[key] !== 'string' || !identity[key]) requireChildRecovery('invalid_identity')
  if (identity.tenantId !== scope.tenantId || identity.runId !== runId || identity.rootSessionId !== scope.rootSessionId || identity.parentSessionId !== scope.parentSessionId || identity.parentConversationId !== scope.parentTurnId) requireChildRecovery('foreign_checkpoint')
  if (!Number.isSafeInteger(identity.createdAt) || identity.createdAt < 0) requireChildRecovery('invalid_identity')
  const contribution = childUsageContribution({ totalTokens: row.tokens ?? undefined, inputTokens: row.input_tokens ?? undefined, outputTokens: row.output_tokens ?? undefined, unknown: row.unknown }, row.finished_at)
  return { identity, encoded: JSON.stringify(identity), contribution }
}

/** Caller owns the checkpoint/publication transaction and the parent ordering barrier. */
export async function admitPublishedChild(tx: Transaction, scope: PublicationScope, eventSequence: number, runId: string, atSeq: number): Promise<number> {
  if (recoveryVersion(eventSequence) < 1) requireChildRecovery('invalid_revision')
  const state = await stateAt(tx, scope), evidence = await exactEvidence(tx, scope, runId, atSeq)
  const usage = await readChildUsageFence(tx, scope.tenantId, scope.parentSessionId)
  if (state.generation !== usage.generation) requireChildRecovery('generation_changed')
  const repeated = (await tx.execute({ sql: 'SELECT * FROM parent_publication_marks WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND event_sequence=?', args: [...ownerArgs(scope), eventSequence] })).rows[0]
  if (repeated) {
    if (eventSequence < Number(state.floor_event_sequence) || Number(repeated.revision) < Number(state.floor_revision)) requireChildRecovery('retention_gap')
    if (repeated.run_id !== runId || Number(repeated.at_seq) !== atSeq) requireChildRecovery('event_conflict')
    const version = (await tx.execute({ sql: 'SELECT * FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND run_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)', args: [...ownerArgs(scope), runId, Number(repeated.revision), Number(repeated.revision)] })).rows[0]
    if (!version || version.identity !== evidence.encoded || Number(version.at_seq) !== atSeq || Number(version.tokens) !== evidence.contribution.tokens || Boolean(version.unknown) !== evidence.contribution.unknown || (version.finished_at === null ? undefined : Number(version.finished_at)) !== evidence.contribution.finishedAt) requireChildRecovery('checkpoint_conflict')
    return recoveryVersion(repeated.revision)
  }
  if (eventSequence <= Number(state.event_sequence)) requireChildRecovery('event_not_monotone')
  const previous = (await tx.execute({ sql: 'SELECT * FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND run_id=? AND valid_to IS NULL', args: [...ownerArgs(scope), runId] })).rows[0]
  if (previous) {
    const old = JSON.parse(String(previous.identity)) as PublishedChildIdentity
    for (const key of ['tenantId','runId','rootSessionId','parentSessionId','parentConversationId','parentMessageId','parentToolCallId','childSessionId','createdAt'] as const)
      if (old[key] !== evidence.identity[key]) requireChildRecovery('identity_changed')
  }
  if (previous && Number(previous.at_seq) > atSeq) requireChildRecovery('child_sequence_regression')
  if (previous && Number(previous.at_seq) === atSeq && (previous.identity !== evidence.encoded || Number(previous.tokens) !== evidence.contribution.tokens || Boolean(previous.unknown) !== evidence.contribution.unknown || (previous.finished_at === null ? undefined : Number(previous.finished_at)) !== evidence.contribution.finishedAt)) requireChildRecovery('checkpoint_conflict')
  const changed = !previous || Number(previous.at_seq) < atSeq
  const revision = recoveryVersion(Number(state.revision) + Number(changed))
  if (changed) {
    if (previous) await tx.execute({ sql: 'UPDATE parent_published_child_versions SET valid_to=? WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND run_id=? AND valid_to IS NULL', args: [revision, ...ownerArgs(scope), runId] })
    await tx.execute({ sql: 'INSERT INTO parent_published_child_versions(tenant_id,parent_session_id,stream_id,run_id,first_ordinal,valid_from,at_seq,identity,tokens,unknown,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      args: [...ownerArgs(scope), runId, previous ? Number(previous.first_ordinal) : revision, revision, atSeq, evidence.encoded, evidence.contribution.tokens, Number(evidence.contribution.unknown), evidence.contribution.finishedAt ?? null] })
  }
  await tx.execute({ sql: 'INSERT INTO parent_publication_marks(tenant_id,parent_session_id,stream_id,event_sequence,revision,run_id,at_seq) VALUES (?,?,?,?,?,?,?)', args: [...ownerArgs(scope), eventSequence, revision, runId, atSeq] })
  const result = await tx.execute({ sql: 'UPDATE parent_publication_state SET revision=?,event_sequence=? WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND generation=? AND revision=? AND event_sequence=?', args: [revision, eventSequence, ...ownerArgs(scope), state.generation, Number(state.revision), Number(state.event_sequence)] })
  if (result.rowsAffected !== 1) requireChildRecovery('publication_write_race')
  return revision
}

/** Ordinary frames need no per-token write; a snapshot/end boundary records its admitted parent prefix. */
export async function advancePublicationBoundary(tx: Transaction, scope: PublicationScope, eventSequence: number): Promise<void> {
  const state = await stateAt(tx, scope)
  recoveryVersion(eventSequence)
  if (eventSequence < Number(state.event_sequence)) requireChildRecovery('event_not_monotone')
  const result = await tx.execute({ sql: 'UPDATE parent_publication_state SET event_sequence=? WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND generation=? AND event_sequence=?', args: [eventSequence, ...ownerArgs(scope), state.generation, Number(state.event_sequence)] })
  if (result.rowsAffected !== 1) requireChildRecovery('publication_write_race')
}

export async function capturePublishedFence(tx: Transaction, scope: PublicationScope, atEventSequence?: number): Promise<PublishedFence> {
  const state = await stateAt(tx, scope), usage = await readChildUsageFence(tx, scope.tenantId, scope.parentSessionId)
  if (state.generation !== usage.generation) requireChildRecovery('generation_changed')
  const eventSequence = recoveryVersion(atEventSequence ?? state.event_sequence)
  if (eventSequence < Number(state.floor_event_sequence) || eventSequence > Number(state.event_sequence)) requireChildRecovery('retention_gap')
  const mark = (await tx.execute({ sql: 'SELECT revision FROM parent_publication_marks WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND event_sequence<=? ORDER BY event_sequence DESC LIMIT 1', args: [...ownerArgs(scope), eventSequence] })).rows[0]
  const fence: PublishedFence = { ...scope, generation: usage.generation, eventSequence, revision: mark ? recoveryVersion(mark.revision) : 0, usageRevision: usage.revision }
  await assertPublishedFence(tx, fence)
  return fence
}
export async function assertPublishedFence(tx: Transaction, fence: PublishedFence): Promise<void> {
  const state = await stateAt(tx, fence)
  await assertChildUsageFence(tx, usageFence(fence))
  if (state.generation !== fence.generation) requireChildRecovery('generation_changed')
  const revision = recoveryVersion(fence.revision), eventSequence = recoveryVersion(fence.eventSequence)
  if (revision < Number(state.floor_revision) || revision > Number(state.revision) || eventSequence < Number(state.floor_event_sequence) || eventSequence > Number(state.event_sequence)) requireChildRecovery('retention_gap')
  const mark = (await tx.execute({ sql: 'SELECT revision FROM parent_publication_marks WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND event_sequence<=? ORDER BY event_sequence DESC LIMIT 1', args: [...ownerArgs(fence), eventSequence] })).rows[0]
  if ((mark ? Number(mark.revision) : 0) !== revision) requireChildRecovery('prefix_mismatch')
}
const effective = 'valid_from<=? AND (valid_to IS NULL OR valid_to>?)'
const effectiveArgs = (fence: PublishedFence) => [...ownerArgs(fence), fence.revision, fence.revision]
async function assertRetainedCheckpoints(tx: Transaction, fence: PublishedFence): Promise<void> {
  const row = (await tx.execute({ sql: `SELECT count(*) AS count FROM parent_published_child_versions v WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND ${effective}
    AND NOT EXISTS(SELECT 1 FROM subagent_checkpoints c JOIN subagent_records r ON r.tenant_id=c.tenant_id AND r.run_id=c.run_id WHERE c.tenant_id=v.tenant_id AND c.run_id=v.run_id AND c.seq=v.at_seq)
    AND NOT EXISTS(SELECT 1 FROM subagent_events e WHERE e.tenant_id=v.tenant_id AND e.run_id=v.run_id AND e.seq=v.at_seq AND json_extract(e.event,'$.schemaVersion')=1)`, args: effectiveArgs(fence) })).rows[0]
  if (Number(row.count)) requireChildRecovery('missing_checkpoint')
}
export async function readPublishedPage(tx: Transaction, fence: PublishedFence, options: { limit?: number; after?: { firstOrdinal: number; runId: string }; responseBytes?: number } = {}): Promise<PublishedPage> {
  const limit = options.limit ?? 64, bytes = options.responseBytes ?? PUBLISHED_CHILD_PAGE_BYTES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(bytes) || bytes < 1024 || bytes > PUBLISHED_CHILD_PAGE_BYTES) throw new RangeError('Invalid published page budget')
  await assertPublishedFence(tx, fence); await assertRetainedCheckpoints(tx, fence)
  const after = options.after
  if (after && (recoveryVersion(after.firstOrdinal) < 1 || typeof after.runId !== 'string' || !after.runId)) requireChildRecovery('invalid_cursor')
  const total = (await tx.execute({ sql: `SELECT count(*) AS count FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND ${effective}`, args: effectiveArgs(fence) })).rows[0]
  const rows = (await tx.execute({ sql: `SELECT run_id,first_ordinal,at_seq,identity FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND ${effective} ${after ? 'AND (first_ordinal>? OR (first_ordinal=? AND run_id>?))' : ''} ORDER BY first_ordinal,run_id LIMIT ?`, args: [...effectiveArgs(fence), ...(after ? [after.firstOrdinal, after.firstOrdinal, after.runId] : []), limit + 1] })).rows
  const page: PublishedPage = { fence, totalPublishedCount: recoveryVersion(total.count), items: [], includedCount: 0, hasMore: false, after: null }
  if (serializedSize(page) > bytes) requireChildRecovery('oversized_identity')
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (index === limit) { page.hasMore = true; break }
    const item: PublishedChildRef = { identity: JSON.parse(String(row.identity)) as PublishedChildIdentity, atSeq: recoveryVersion(row.at_seq), firstOrdinal: recoveryVersion(row.first_ordinal) }
    const candidate = { ...page, items: [...page.items, item], includedCount: page.items.length + 1, hasMore: index + 1 < rows.length, after: { firstOrdinal: item.firstOrdinal, runId: item.identity.runId } }
    if (serializedSize(candidate) > bytes) { if (!page.items.length) requireChildRecovery('oversized_identity'); page.hasMore = true; break }
    page.items.push(item); page.includedCount++; page.after = candidate.after
  }
  if (!page.hasMore) page.after = null
  return page
}
export async function lookupPublishedChild(tx: Transaction, fence: PublishedFence, runId: string): Promise<PublishedChildRef | null> {
  await assertPublishedFence(tx, fence); await assertRetainedCheckpoints(tx, fence)
  const row = (await tx.execute({ sql: `SELECT first_ordinal,at_seq,identity FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND ${effective} AND run_id=?`, args: [...effectiveArgs(fence), runId] })).rows[0]
  if (!row) return null
  const item: PublishedChildRef = { identity: JSON.parse(String(row.identity)) as PublishedChildIdentity, atSeq: recoveryVersion(row.at_seq), firstOrdinal: recoveryVersion(row.first_ordinal) }
  if (serializedSize({ fence, item }) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('oversized_identity')
  return item
}
async function lookupPublishedChildren(tx: Transaction, fence: PublishedFence, runIds: readonly string[]): Promise<Map<string, PublishedChildRef>> {
  if (!runIds.length || runIds.length > 128 || runIds.some(runId => typeof runId !== 'string' || !runId)) throw new RangeError('Invalid published lookup batch')
  const unique = [...new Set(runIds)]
  const rows = (await tx.execute({ sql: `SELECT run_id,first_ordinal,at_seq,identity FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND ${effective} AND run_id IN (${unique.map(() => '?').join(',')})`, args: [...effectiveArgs(fence), ...unique] })).rows
  const items = new Map<string, PublishedChildRef>()
  for (const row of rows) {
    const item: PublishedChildRef = { identity: JSON.parse(String(row.identity)) as PublishedChildIdentity, atSeq: recoveryVersion(row.at_seq), firstOrdinal: recoveryVersion(row.first_ordinal) }
    if (serializedSize({ fence, item }) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('oversized_identity')
    items.set(String(row.run_id), item)
  }
  return items
}
/** The caller keeps one physical transaction open and performs no writes while
 * this callback runs. Its consistent snapshot needs one full retained-prefix
 * proof; bounded identity batches still read actual rows. No proof or rows are
 * cached across callbacks, transactions or HTTP requests. */
export async function withPublishedChildProof<T>(tx: Transaction, fence: PublishedFence,
  verify: (lookup: (runIds: readonly string[]) => Promise<Map<string, PublishedChildRef>>) => Promise<T>): Promise<T> {
  const selected = { ...fence }
  await assertPublishedFence(tx, selected); await assertRetainedCheckpoints(tx, selected)
  let active = true
  try {
    return await verify(async runIds => {
      if (!active || tx.closed) throw new Error('Published proof batch is outside its transaction scope')
      const items = await lookupPublishedChildren(tx, selected, runIds)
      if (!active || tx.closed) throw new Error('Published proof batch is outside its transaction scope')
      return items
    })
  } finally { active = false }
}
export async function readLiveChildUsage(tx: Transaction, fence: PublishedFence): Promise<ChildUsageScalar> {
  await assertPublishedFence(tx, fence); await assertRetainedCheckpoints(tx, fence)
  const others = await readDurableChildUsage(tx, usageFence(fence), fence.parentTurnId)
  const own = scalarFromRow((await tx.execute({ sql: `SELECT coalesce(sum(tokens),0) AS tokens,count(*) AS count,coalesce(sum(unknown),0) AS unknown,max(finished_at) AS finished_at FROM parent_published_child_versions WHERE tenant_id=? AND parent_session_id=? AND stream_id=? AND ${effective}`, args: effectiveArgs(fence) })).rows[0])
  const finished = [others.finishedAt, own.finishedAt].filter((value): value is number => value !== undefined)
  return scalarFromRow({ tokens: others.totalTokens + own.totalTokens, count: others.count + own.count, unknown: others.unknown + own.unknown, finished_at: finished.length ? Math.max(...finished) : null })
}
