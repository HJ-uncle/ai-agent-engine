import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Transaction, Value, Row } from '@libsql/client'
import type { RunStatus, SubagentRun, SubagentRunHeader } from './types.js'

export const DISCOVERY_PAGE_BYTES = 256 * 1024
export const DISCOVERY_RETAIN_REVISIONS = 4096
const active = new Set<RunStatus>(['queued', 'running', 'cancelling'])
const statuses = new Set<string>([...active, 'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted'])
export type DiscoveryScope = { tenantId: string; parentSessionId: string; rootSessionId?: string; parentConversationId?: string }
export type DiscoveryOptions = { mode: 'active' | 'changes'; afterRevision?: number; cursor?: string; limit?: number; responseBytes?: number }
export type DiscoveryIdentity = Pick<SubagentRun, 'tenantId' | 'runId' | 'parentSessionId' | 'rootSessionId' | 'parentConversationId' | 'parentMessageId' | 'parentToolCallId' | 'childSessionId' | 'modelId' | 'agentId' | 'agentName' | 'createdAt'>
export type DiscoveryRef = DiscoveryIdentity & { revision: number; createdRevision: number; runSeq: number; status: RunStatus; deleted: boolean }
export type DiscoveryPage = {
  protocolVersion: 1; source: 'durable-lifecycle'; generation: string; scope: DiscoveryScope;
  mode: 'active' | 'changes'; asOfRevision: number; floorRevision: number; activeCount: number;
  items: DiscoveryRef[]; includedCount: number; scannedCount: number; nextRevision?: number;
  hasMore: boolean; nextCursor: string | null; membershipCompleteness: 'partial' | 'complete';
}
type State = { generation: string; secret: string; revision: number; floor: number; complete: boolean }
type Cursor = { v: 1; scope: string; generation: string; mode: 'active' | 'changes'; upper: number; after: number; key: number }
type Lifecycle = Pick<SubagentRunHeader, keyof DiscoveryIdentity | 'status' | 'lastSeq'>
export class DiscoveryRecoveryError extends Error {
  constructor(readonly reason: 'bootstrap_incomplete' | 'generation_changed' | 'retention_gap' | 'oversized_identity' | 'invalid_identity', message: string) { super(message); this.name = 'DiscoveryRecoveryError' }
}
function safeInteger(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new RangeError('Invalid discovery ' + name)
  return value
}
function checkedScope(scope: DiscoveryScope): DiscoveryScope {
  for (const name of ['tenantId', 'parentSessionId', 'rootSessionId', 'parentConversationId'] as const) {
    const value = scope[name]
    if (value === undefined && name !== 'tenantId' && name !== 'parentSessionId') continue
    if (typeof value !== 'string' || !value.length || value.length > 4096) throw new RangeError('Invalid discovery ' + name)
  }
  return { tenantId: scope.tenantId, parentSessionId: scope.parentSessionId,
    ...(scope.rootSessionId === undefined ? {} : { rootSessionId: scope.rootSessionId }),
    ...(scope.parentConversationId === undefined ? {} : { parentConversationId: scope.parentConversationId }) }
}
const digest = (scope: DiscoveryScope) => createHash('sha256').update(JSON.stringify(checkedScope(scope))).digest('hex')
function stateRow(row: Row): State {
  return { generation: String(row.generation), secret: String(row.secret), revision: safeInteger(Number(row.revision), 'revision'), floor: safeInteger(Number(row.floor_revision), 'floor'), complete: Number(row.bootstrap_complete) === 1 }
}
async function stateAt(tx: Transaction, scope: DiscoveryScope): Promise<State> {
  const result = await tx.execute({ sql: 'SELECT * FROM subagent_discovery_state WHERE tenant_id=? AND parent_session_id=?', args: [scope.tenantId, scope.parentSessionId] })
  if (!result.rows[0]) throw new DiscoveryRecoveryError('bootstrap_incomplete', 'Discovery baseline not initialized')
  const state = stateRow(result.rows[0])
  if (!state.complete) throw new DiscoveryRecoveryError('bootstrap_incomplete', 'Discovery baseline is not committed')
  return state
}
function encode(cursor: Cursor, secret: string): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url')
}
function decode(text: string, scope: DiscoveryScope, options: DiscoveryOptions, state: State): Cursor {
  if (typeof text !== 'string' || text.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(text)) throw new RangeError('Invalid discovery cursor')
  const [payload, mac] = text.split('.')
  const expected = createHmac('sha256', state.secret).update(payload).digest()
  const actual = Buffer.from(mac, 'base64url')
  if (actual.toString('base64url') !== mac || Buffer.from(payload, 'base64url').toString('base64url') !== payload) throw new RangeError('Invalid discovery cursor canonical encoding')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new RangeError('Invalid discovery cursor signature')
  let cursor: Cursor
  try { cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Cursor } catch { throw new RangeError('Invalid discovery cursor encoding') }
  if (!cursor || cursor.v !== 1 || cursor.scope !== digest(scope) || cursor.mode !== options.mode || typeof cursor.generation !== 'string') throw new RangeError('Invalid discovery cursor scope')
  safeInteger(cursor.upper, 'cursor upper'); safeInteger(cursor.after, 'cursor after'); safeInteger(cursor.key, 'cursor key')
  if (cursor.generation !== state.generation) throw new DiscoveryRecoveryError('generation_changed', 'Discovery generation changed; restart the baseline')
  if (cursor.upper > state.revision || cursor.after > cursor.upper || cursor.key > cursor.upper || (cursor.mode === 'changes' && cursor.key < cursor.after)) throw new RangeError('Invalid discovery cursor bounds')
  if (cursor.mode === 'active' && cursor.after !== 0) throw new RangeError('Invalid active discovery cursor boundary')
  if (options.afterRevision !== undefined && options.afterRevision !== cursor.after) throw new RangeError('Discovery afterRevision does not match cursor')
  if ((cursor.mode === 'active' ? cursor.upper : cursor.after) < state.floor) throw new DiscoveryRecoveryError('retention_gap', 'Discovery prefix expired; restart the baseline')
  return cursor
}
function identityOf(run: Lifecycle): DiscoveryIdentity {
  const identity: DiscoveryIdentity = { tenantId: run.tenantId, runId: run.runId, rootSessionId: run.rootSessionId,
    parentSessionId: run.parentSessionId, parentConversationId: run.parentConversationId, parentMessageId: run.parentMessageId,
    parentToolCallId: run.parentToolCallId, childSessionId: run.childSessionId, modelId: run.modelId, createdAt: run.createdAt,
    ...(run.agentId === undefined ? {} : { agentId: run.agentId }), ...(run.agentName === undefined ? {} : { agentName: run.agentName }) }
  for (const key of ['tenantId', 'runId', 'rootSessionId', 'parentSessionId', 'parentConversationId', 'parentMessageId', 'parentToolCallId', 'childSessionId', 'modelId'] as const) {
    if (typeof identity[key] !== 'string' || !identity[key].length) throw new DiscoveryRecoveryError('invalid_identity', 'Incomplete discovery identity: ' + key)
  }
  if (!statuses.has(run.status)) throw new DiscoveryRecoveryError('invalid_identity', 'Unknown discovery status')
  safeInteger(run.lastSeq, 'run sequence', 1); safeInteger(run.createdAt, 'createdAt')
  return identity
}
const scalar = (field: string) => `coalesce(json_extract(m.record,'$.${field}'),json_extract(r.snapshot,'$.${field}'))`
const bootstrapIdentity = `json_object('tenantId',r.tenant_id,'runId',r.run_id,'parentSessionId',r.parent_session_id,
  'rootSessionId',${scalar('rootSessionId')},'parentConversationId',${scalar('parentConversationId')},
  'parentMessageId',${scalar('parentMessageId')},'parentToolCallId',r.parent_tool_call_id,'childSessionId',r.child_session_id,
  'modelId',${scalar('modelId')},'agentId',${scalar('agentId')},'agentName',${scalar('agentName')},'createdAt',r.created_at)`

/** One write transaction publishes the completion marker after bounded SQL-only scalar batches. */
export async function ensureParentDiscovery(tx: Transaction, tenantId: string, parentSessionId: string): Promise<void> {
  const prior = await tx.execute({ sql: 'SELECT * FROM subagent_discovery_state WHERE tenant_id=? AND parent_session_id=?', args: [tenantId, parentSessionId] })
  if (prior.rows.length) { if (!stateRow(prior.rows[0]).complete) throw new DiscoveryRecoveryError('bootstrap_incomplete', 'Interrupted discovery bootstrap'); return }
  const generation = randomUUID(), secret = randomUUID() + randomUUID()
  await tx.execute({ sql: 'INSERT INTO subagent_discovery_state(tenant_id,parent_session_id,generation,secret) VALUES (?,?,?,?)', args: [tenantId, parentSessionId, generation, secret] })
  let rowid = 0, revision = 0
  while (true) {
    const keys = await tx.execute({ sql: 'SELECT rowid AS key FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? AND rowid>? ORDER BY rowid LIMIT 128', args: [tenantId, parentSessionId, rowid] })
    if (!keys.rows.length) break
    const upper = Number(keys.rows[keys.rows.length - 1].key)
    const invalid = await tx.execute({ sql: `SELECT count(*) AS count FROM subagent_runs r LEFT JOIN subagent_records m ON m.tenant_id=r.tenant_id AND m.run_id=r.run_id
      WHERE r.tenant_id=? AND r.parent_session_id=? AND r.rowid>? AND r.rowid<=? AND
      (r.status NOT IN ('queued','running','cancelling','succeeded','failed','cancelled','blocked','interrupted') OR r.seq<1 OR r.created_at<0
      OR coalesce(length(${scalar('rootSessionId')}),0)=0 OR coalesce(length(${scalar('parentConversationId')}),0)=0
      OR coalesce(length(${scalar('parentMessageId')}),0)=0 OR coalesce(length(${scalar('modelId')}),0)=0)`, args: [tenantId, parentSessionId, rowid, upper] })
    if (Number(invalid.rows[0].count)) throw new DiscoveryRecoveryError('invalid_identity', 'Cannot bootstrap incomplete legacy discovery identity')
    await tx.execute({ sql: `INSERT INTO subagent_discovery_versions(tenant_id,parent_session_id,generation,revision,run_id,created_revision,run_seq,status,deleted,root_session_id,parent_conversation_id,identity)
      SELECT r.tenant_id,r.parent_session_id,?,?+row_number() OVER(ORDER BY r.rowid),r.run_id,?+row_number() OVER(ORDER BY r.rowid),r.seq,r.status,0,
      ${scalar('rootSessionId')},${scalar('parentConversationId')},${bootstrapIdentity}
      FROM subagent_runs r LEFT JOIN subagent_records m ON m.tenant_id=r.tenant_id AND m.run_id=r.run_id
      WHERE r.tenant_id=? AND r.parent_session_id=? AND r.rowid>? AND r.rowid<=? ORDER BY r.rowid`, args: [generation, revision, revision, tenantId, parentSessionId, rowid, upper] })
    revision += keys.rows.length; safeInteger(revision, 'bootstrap revision'); rowid = upper
  }
  await tx.execute({ sql: 'UPDATE subagent_discovery_state SET revision=?,bootstrap_complete=1 WHERE tenant_id=? AND parent_session_id=?', args: [revision, tenantId, parentSessionId] })
  await pruneDiscovery(tx, { tenantId, parentSessionId }, revision)
}
async function pruneDiscovery(tx: Transaction, scope: DiscoveryScope, revision: number): Promise<void> {
  const floor = Math.max(0, revision - DISCOVERY_RETAIN_REVISIONS)
  if (!floor) return
  await tx.execute({ sql: `DELETE FROM subagent_discovery_versions AS v WHERE tenant_id=? AND parent_session_id=? AND revision<?
    AND revision < (SELECT max(old.revision) FROM subagent_discovery_versions old WHERE old.tenant_id=v.tenant_id AND old.parent_session_id=v.parent_session_id AND old.generation=v.generation AND old.run_id=v.run_id AND old.revision<=?)`, args: [scope.tenantId, scope.parentSessionId, floor, floor] })
  await tx.execute({ sql: 'UPDATE subagent_discovery_state SET floor_revision=? WHERE tenant_id=? AND parent_session_id=?', args: [floor, scope.tenantId, scope.parentSessionId] })
}
export async function appendDiscoveryLifecycle(tx: Transaction, run: Lifecycle): Promise<void> {
  const identity = identityOf(run), scope = { tenantId: run.tenantId, parentSessionId: run.parentSessionId }
  await ensureParentDiscovery(tx, run.tenantId, run.parentSessionId)
  const state = await stateAt(tx, scope)
  const encoded = JSON.stringify(identity)
  const prior = await tx.execute({ sql: 'SELECT created_revision,status,identity,deleted FROM subagent_discovery_versions WHERE tenant_id=? AND parent_session_id=? AND generation=? AND run_id=? ORDER BY revision DESC LIMIT 1', args: [run.tenantId, run.parentSessionId, state.generation, run.runId] })
  const old = prior.rows[0]
  // SQL bootstrap omits no identity but may contain nullable optional fields.
  const priorIdentity = old ? Object.fromEntries(Object.entries(JSON.parse(String(old.identity)) as Record<string, unknown>).filter(([, value]) => value !== null)) : undefined
  const sameIdentity = priorIdentity && Object.keys(priorIdentity).length === Object.keys(identity).length
    && Object.entries(identity).every(([key, value]) => priorIdentity[key] === value)
  if (old && !Number(old.deleted) && old.status === run.status && sameIdentity) return
  if (old && Number(old.deleted)) throw new DiscoveryRecoveryError('invalid_identity', 'Deleted run identity cannot be reused inside its generation')
  const revision = safeInteger(state.revision + 1, 'next revision', 1)
  await tx.execute({ sql: 'INSERT INTO subagent_discovery_versions(tenant_id,parent_session_id,generation,revision,run_id,created_revision,run_seq,status,root_session_id,parent_conversation_id,identity) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    args: [run.tenantId, run.parentSessionId, state.generation, revision, run.runId, old ? Number(old.created_revision) : revision, run.lastSeq, run.status, run.rootSessionId, run.parentConversationId, encoded] })
  await tx.execute({ sql: 'UPDATE subagent_discovery_state SET revision=? WHERE tenant_id=? AND parent_session_id=?', args: [revision, run.tenantId, run.parentSessionId] })
  await pruneDiscovery(tx, scope, revision)
}
export async function tombstoneDiscoveryRun(tx: Transaction, tenantId: string, runId: string): Promise<void> {
  const run = await tx.execute({ sql: 'SELECT parent_session_id FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
  if (!run.rows[0]) return
  const parentSessionId = String(run.rows[0].parent_session_id), scope = { tenantId, parentSessionId }
  await ensureParentDiscovery(tx, tenantId, parentSessionId)
  const state = await stateAt(tx, scope), revision = safeInteger(state.revision + 1, 'delete revision', 1)
  const result = await tx.execute({ sql: `INSERT INTO subagent_discovery_versions(tenant_id,parent_session_id,generation,revision,run_id,created_revision,run_seq,status,deleted,root_session_id,parent_conversation_id,identity)
    SELECT tenant_id,parent_session_id,generation,?,run_id,created_revision,run_seq,status,1,root_session_id,parent_conversation_id,identity
    FROM subagent_discovery_versions WHERE tenant_id=? AND parent_session_id=? AND generation=? AND run_id=? ORDER BY revision DESC LIMIT 1`, args: [revision, tenantId, parentSessionId, state.generation, runId] })
  if (result.rowsAffected !== 1) throw new DiscoveryRecoveryError('invalid_identity', 'Missing deletion identity')
  await tx.execute({ sql: 'UPDATE subagent_discovery_state SET revision=? WHERE tenant_id=? AND parent_session_id=?', args: [revision, tenantId, parentSessionId] })
  await pruneDiscovery(tx, scope, revision)
}
export async function resetParentDiscovery(tx: Transaction, tenantId: string, parentSessionId: string): Promise<void> {
  await tx.execute({ sql: 'DELETE FROM subagent_discovery_versions WHERE tenant_id=? AND parent_session_id=?', args: [tenantId, parentSessionId] })
  await tx.execute({ sql: `INSERT INTO subagent_discovery_state(tenant_id,parent_session_id,generation,secret,bootstrap_complete) VALUES (?,?,?,?,1)
    ON CONFLICT(tenant_id,parent_session_id) DO UPDATE SET generation=excluded.generation,revision=0,floor_revision=0,bootstrap_complete=1`, args: [tenantId, parentSessionId, randomUUID(), randomUUID() + randomUUID()] })
}

const latest = `WITH latest AS (SELECT v.* FROM subagent_discovery_versions v WHERE tenant_id=? AND parent_session_id=? AND generation=? AND revision<=?
  AND revision=(SELECT max(t.revision) FROM subagent_discovery_versions t WHERE t.tenant_id=v.tenant_id AND t.parent_session_id=v.parent_session_id AND t.generation=v.generation AND t.run_id=v.run_id AND t.revision<=?))`
function matches(row: Row, scope: DiscoveryScope): boolean { return (!scope.rootSessionId || row.root_session_id === scope.rootSessionId) && (!scope.parentConversationId || row.parent_conversation_id === scope.parentConversationId) }
function selected(scope: DiscoveryScope): { sql: string; args: Value[] } {
  return { sql: `${scope.rootSessionId ? ' AND root_session_id=?' : ''}${scope.parentConversationId ? ' AND parent_conversation_id=?' : ''}`, args: [ ...(scope.rootSessionId ? [scope.rootSessionId] : []), ...(scope.parentConversationId ? [scope.parentConversationId] : []) ] }
}
function ref(row: Row): DiscoveryRef {
  if (row.identity === null || Number(row.identity_bytes) > DISCOVERY_PAGE_BYTES) throw new DiscoveryRecoveryError('oversized_identity', 'Exact discovery identity exceeds the response budget; identity was not truncated or skipped')
  const data = JSON.parse(String(row.identity)) as DiscoveryIdentity
  return { ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null)) as DiscoveryIdentity,
    revision: Number(row.revision), createdRevision: Number(row.created_revision), runSeq: Number(row.run_seq), status: String(row.status) as RunStatus, deleted: Boolean(Number(row.deleted)) }
}
/** Budget includes the real HTTP envelope; timestamp uses the longest supported safe integer. */
export function discoveryEnvelopeBytes(page: DiscoveryPage): number { return Buffer.byteLength(JSON.stringify({ code: 200, message: '操作成功', data: page, timestamp: Number.MAX_SAFE_INTEGER }), 'utf8') }
export async function readDiscoveryPage(tx: Transaction, input: DiscoveryScope, options: DiscoveryOptions): Promise<DiscoveryPage> {
  const scope = checkedScope(input), state = await stateAt(tx, scope), limit = safeInteger(options.limit ?? 64, 'limit', 1, 200)
  const budget = safeInteger(options.responseBytes ?? DISCOVERY_PAGE_BYTES, 'response budget', 1024, DISCOVERY_PAGE_BYTES)
  if (options.mode !== 'active' && options.mode !== 'changes') throw new RangeError('Invalid discovery mode')
  if (options.mode === 'active' && options.afterRevision !== undefined) throw new RangeError('active discovery does not accept afterRevision')
  if (options.afterRevision !== undefined) safeInteger(options.afterRevision, 'afterRevision')
  if (options.mode === 'changes' && options.afterRevision === undefined && !options.cursor) throw new RangeError('changes discovery requires afterRevision')
  const cursor = options.cursor ? decode(options.cursor, scope, options, state) : {
    v: 1 as const, scope: digest(scope), generation: state.generation, mode: options.mode, upper: state.revision,
    after: options.afterRevision ?? 0, key: options.afterRevision ?? 0,
  }
  if (cursor.after > state.revision) throw new RangeError('Discovery afterRevision is in the future')
  if ((options.mode === 'active' ? cursor.upper : cursor.after) < state.floor) throw new DiscoveryRecoveryError('retention_gap', 'Discovery prefix expired; restart the baseline')
  const filter = selected(scope), base: Value[] = [scope.tenantId, scope.parentSessionId, state.generation, cursor.upper, cursor.upper]
  const count = await tx.execute({ sql: `${latest} SELECT count(*) AS count FROM latest WHERE deleted=0 AND status IN ('queued','running','cancelling')${filter.sql}`, args: [...base, ...filter.args] })
  const page: DiscoveryPage = { protocolVersion: 1, source: 'durable-lifecycle', generation: state.generation, scope, mode: options.mode,
    asOfRevision: cursor.upper, floorRevision: state.floor, activeCount: Number(count.rows[0].count), items: [], includedCount: 0, scannedCount: 0,
    hasMore: false, nextCursor: null, membershipCompleteness: 'complete', ...(options.mode === 'changes' ? { nextRevision: cursor.key } : {}) }
  let key = cursor.key
  const rowQuery = (withIdentity: boolean) => {
    const fields = withIdentity ? `revision,created_revision,run_seq,status,deleted,root_session_id,parent_conversation_id,
      length(CAST(identity AS BLOB)) AS identity_bytes,CASE WHEN length(CAST(identity AS BLOB))<=${DISCOVERY_PAGE_BYTES} THEN identity ELSE NULL END AS identity` : '1 AS present'
    return options.mode === 'active'
      ? { sql: `${latest} SELECT ${fields} FROM latest WHERE deleted=0 AND status IN ('queued','running','cancelling')${filter.sql} AND created_revision>? ORDER BY created_revision,run_id LIMIT 1`, args: [...base, ...filter.args, key] }
      : { sql: `SELECT ${fields} FROM subagent_discovery_versions WHERE tenant_id=? AND parent_session_id=? AND generation=? AND revision>? AND revision<=? ORDER BY revision LIMIT 1`, args: [scope.tenantId, scope.parentSessionId, state.generation, key, cursor.upper] }
  }
  while (page.scannedCount < limit) {
    const result = await tx.execute(rowQuery(true)), row = result.rows[0]
    if (!row) { if (options.mode === 'changes') key = cursor.upper; break }
    const nextKey = Number(options.mode === 'active' ? row.created_revision : row.revision)
    if (nextKey <= key) throw new DiscoveryRecoveryError('invalid_identity', 'Discovery cursor did not advance')
    const include = matches(row, scope)
    const candidate = include ? ref(row) : undefined
    const proposed: DiscoveryPage = { ...page, items: candidate ? [...page.items, candidate] : page.items,
      includedCount: page.includedCount + (candidate ? 1 : 0), scannedCount: page.scannedCount + 1,
      hasMore: true, nextCursor: encode({ ...cursor, key: nextKey }, state.secret), membershipCompleteness: 'partial',
      ...(options.mode === 'changes' ? { nextRevision: nextKey } : {}) }
    if (discoveryEnvelopeBytes(proposed) > budget) {
      if (page.scannedCount === 0) throw new DiscoveryRecoveryError('oversized_identity', 'Exact discovery identity and envelope exceed the response budget; cursor did not advance')
      break
    }
    page.items = proposed.items; page.includedCount = proposed.includedCount; page.scannedCount = proposed.scannedCount; key = nextKey
  }
  const remainder = await tx.execute(rowQuery(false))
  page.hasMore = remainder.rows.length > 0
  if (!page.hasMore && options.mode === 'changes') key = cursor.upper
  page.nextCursor = page.hasMore ? encode({ ...cursor, key }, state.secret) : null
  page.membershipCompleteness = page.hasMore ? 'partial' : 'complete'
  if (options.mode === 'changes') page.nextRevision = key
  if (discoveryEnvelopeBytes(page) > budget) throw new DiscoveryRecoveryError('oversized_identity', 'Discovery metadata exceeds response budget')
  return page
}
