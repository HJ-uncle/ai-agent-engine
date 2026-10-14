import { createHash, randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { getDb } from '../../storage/sqlite/db.js'
import { up } from '../../storage/sqlite/migrations/019_subagent_runs.js'
import { ensureSubagentDeltaSchema } from './durable-schema.js'
import { ensureDiscoverySchema } from './discovery-schema.js'
import { ensureChildRecoverySchema } from './child-recovery-schema.js'
import { ensureParentChildUsage, readChildUsageFence, readDurableChildUsage, recordDurableChildUsage, resetParentChildRecovery, sameChildUsage, type ChildUsageFence, type ChildUsageScalar } from './child-usage-authority.js'
import { appendDiscoveryLifecycle, ensureParentDiscovery, readDiscoveryPage, resetParentDiscovery, tombstoneDiscoveryRun, type DiscoveryOptions, type DiscoveryPage } from './discovery.js'
import { projectSubagentRunView, summarizeSubagentTool } from './view.js'
import { isTaskPlanControl } from '../task-plan/control.js'
import { isTerminalRun, type CreateSubagentRun, type RunInvocationUsage, type RunStatus, type SubagentEvent, type SubagentRun, type SubagentRunHeader, type SubagentMutation, type SubagentRunView, type SubagentToolCall, type SubagentToolSummary, type SubagentDeltaEvent, type SubagentIdentity, type SubagentWireEvent } from './types.js'

type RunPatch = Partial<Pick<SubagentRun, 'status' | 'startedAt' | 'finishedAt' | 'durationMs' | 'stopReason' | 'error' | 'resultSummary' | 'partialOutput' | 'usage' | 'toolCalls' | 'modelId' | 'externalEffectStatus'>>
type PatchSource = RunPatch | ((current: SubagentRun) => RunPatch)
const writes = new WeakMap<Client, Promise<unknown>>()
type Query = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>
type HeaderPatch = Omit<RunPatch, 'toolCalls'>
/** Server-owned admission work must commit or roll back with the child record. */
export type SubagentAdmission = (tx: Transaction, header: SubagentRunHeader, admission: Readonly<{ created: boolean }>) => Promise<void>
const PAGE_BYTES = 512 * 1024
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T
const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const scopeHash = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
const cursorEncode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url')
function failRecovery(message: string): never { throw new Error('SUBAGENT_RECOVERY_REQUIRED: ' + message) }
function utf8Prefix(text: string, limit: number): string {
  let bytes = 0, length = 0
  for (const character of text) { const size = Buffer.byteLength(character); if (bytes + size > limit) break; bytes += size; length += character.length }
  return text.slice(0, length)
}
function boundHeaderPatch(patch: HeaderPatch): HeaderPatch {
  return { ...patch,
    ...(patch.partialOutput === undefined ? {} : { partialOutput: utf8Prefix(patch.partialOutput, 8192) }),
    ...(patch.resultSummary === undefined ? {} : { resultSummary: utf8Prefix(patch.resultSummary, 8192) }),
    ...(patch.stopReason === undefined ? {} : { stopReason: utf8Prefix(patch.stopReason, 1024) }),
    ...(patch.error ? { error: { ...patch.error, code: utf8Prefix(patch.error.code, 256), message: utf8Prefix(patch.error.message, 1024) } } : {}),
  }
}
const stateKeys = ['status', 'lastSeq', 'updatedAt', 'startedAt', 'finishedAt', 'durationMs', 'stopReason', 'error', 'resultSummary', 'partialOutput', 'externalEffectStatus', 'usage', 'modelId', 'toolCount', 'activeToolCount', 'nonPlanToolCount', 'latestActivity'] as const
const stateOf = (run: SubagentRunHeader) => Object.fromEntries(stateKeys.filter(key => run[key] !== undefined).map(key => [key, run[key]]))
const identityOf = (run: SubagentRunHeader): SubagentIdentity => ({ tenantId: run.tenantId, rootSessionId: run.rootSessionId, parentSessionId: run.parentSessionId, parentConversationId: run.parentConversationId, parentMessageId: run.parentMessageId, parentToolCallId: run.parentToolCallId, childSessionId: run.childSessionId })
function pageSize(value = 64): number { if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new RangeError('Invalid subagent page size'); return value }
function sequence(value: number): number { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid subagent watermark'); return value }
function decodeCursor(raw: string | undefined, expected: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  if (!raw || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new RangeError('Invalid subagent cursor')
  let value: Record<string, unknown>
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) } catch { throw new RangeError('Invalid subagent cursor') }
  if (!value || value.scope !== expected) throw new RangeError('Subagent cursor scope mismatch')
  return value
}
const publicRecord = (column: string) => `json_patch(json_set(json_remove(${column},'$.continuation','$.toolCalls','$.error'), '$.task',substr(json_extract(${column},'$.task'),1,2048),'$.description',substr(json_extract(${column},'$.description'),1,1024),'$.agentName',substr(json_extract(${column},'$.agentName'),1,512),'$.partialOutput',substr(json_extract(${column},'$.partialOutput'),1,8192),'$.resultSummary',substr(json_extract(${column},'$.resultSummary'),1,8192)),CASE WHEN json_type(${column},'$.error')='object' THEN json_object('error',json_object('code',substr(json_extract(${column},'$.error.code'),1,256),'message',substr(json_extract(${column},'$.error.message'),1,1024),'retryable',json(CASE WHEN json_extract(${column},'$.error.retryable') THEN 'true' ELSE 'false' END))) ELSE '{}' END)`
const cleanToolSummary = (value: unknown): SubagentToolSummary => Object.fromEntries(Object.entries(parse<Record<string, unknown>>(value)).filter(([key, item]) => item !== null || key === 'args')) as unknown as SubagentToolSummary
const cleanHeader = (record: unknown, state?: unknown): SubagentRunHeader => Object.fromEntries(Object.entries({ ...parse<Record<string, unknown>>(record), ...(state === undefined ? {} : parse<Record<string, unknown>>(state)) }).filter(([, value]) => value !== null)) as unknown as SubagentRunHeader

export interface ParentProjection {
  id: string
  tenantId: string
  event: SubagentWireEvent
}

/** SQLite is authoritative; the outbox lets parent JSONL projection recover independently after a crash. */
export class SubagentStore {
  private initialized?: Promise<void>

  constructor(readonly db: Client = getDb()) {}

  private ready(): Promise<void> {
    return this.initialized ??= up(this.db).then(() => ensureSubagentDeltaSchema(this.db)).then(() => ensureDiscoverySchema(this.db)).then(() => ensureChildRecoverySchema(this.db)).then(async () => {
      await this.db.execute(`CREATE TABLE IF NOT EXISTS subagent_execution_receipts (tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,terminal_seq INTEGER NOT NULL,PRIMARY KEY(tenant_id,run_id,request_key))`)
      await this.db.execute(`CREATE TABLE IF NOT EXISTS subagent_projection_receipts (tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,seq INTEGER NOT NULL,message_id TEXT NOT NULL,disposition TEXT NOT NULL,PRIMARY KEY(tenant_id,run_id,seq))`)
    })
  }
  initialize(): Promise<void> { return this.ready() }

  private async read<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    // A latest-index probe and its tool rows must share one SQLite snapshot;
    // otherwise a concurrent completion can leak a future revision at an old watermark.
    const tx = await this.db.transaction('read')
    try { return await fn(tx) }
    finally { if (!tx.closed) await tx.rollback(); tx.close() }
  }

  private async write<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.ready()
    const previous = writes.get(this.db) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const tx = await this.db.transaction('write')
      try {
        const result = await fn(tx)
        await tx.commit()
        return result
      } catch (error) {
        await tx.rollback().catch(() => undefined)
        throw error
      } finally { tx.close() }
    })
    writes.set(this.db, next.catch(() => undefined))
    return next
  }

  /** Read scalar checkpoints without transporting a legacy tool array into JS. */
  private async readHeader(q: Query, tenantId: string, runId: string, atSeq?: number, fullRecord = false): Promise<SubagentRunHeader | null> {
    if (atSeq !== undefined) sequence(atSeq)
    const rows = await q.execute({ sql: 'SELECT seq,json_extract(snapshot,\'$.schemaVersion\') AS version FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
    const current = rows.rows[0]
    if (!current) return null
    const target = atSeq ?? Number(current.seq)
    if (target > Number(current.seq)) failRecovery('Requested future subagent watermark')
    const modern = await q.execute({ sql: `SELECT ${fullRecord ? 'r.record' : publicRecord('r.record')} AS record,c.header,json_extract(r.record,'$.continuation.readOnly') AS read_only,substr(json_extract(r.record,'$.continuation.role'),1,512) AS role FROM subagent_records r JOIN subagent_checkpoints c ON c.tenant_id=r.tenant_id AND c.run_id=r.run_id WHERE r.tenant_id=? AND r.run_id=? AND c.seq=?`, args: [tenantId, runId, target] })
    if (modern.rows[0]) {
      const row = modern.rows[0], header = { ...cleanHeader(row.record, row.header), schemaVersion: 1 as const }
      if (!fullRecord && row.read_only !== null && row.read_only !== undefined) header.continuationDisplay = { readOnly: Boolean(row.read_only), ...(row.role ? { role: String(row.role) } : {}) }
      return header
    }
    // Converted legacy runs still have their earlier exact v1 archive. Missing
    // modern checkpoints never fall through to a newer snapshot.
    const source = atSeq === undefined && Number(current.version) === 1 ? 'snapshot' : "json_extract(event,'$.snapshot')"
    const table = source === 'snapshot' ? 'subagent_runs' : 'subagent_events'
    const filter = source === 'snapshot' ? '' : ' AND seq=? AND json_extract(event,\'$.schemaVersion\')=1'
    const base = fullRecord ? `json_remove(${source},'$.toolCalls')` : publicRecord(source)
    const old = await q.execute({ sql: `SELECT ${base} AS header,json_extract(${source},'$.continuation.readOnly') AS read_only,substr(json_extract(${source},'$.continuation.role'),1,512) AS role,json_array_length(${source},'$.toolCalls') AS tool_count,
      (SELECT count(*) FROM json_each(${source},'$.toolCalls') j WHERE json_extract(j.value,'$.status')='running') AS active_count,
      (SELECT count(*) FROM json_each(${source},'$.toolCalls') j WHERE json_extract(j.value,'$.name') NOT IN ('plan_update','todo_list','todo_create','todo_update','todo_delete')) AS effect_count
      FROM ${table} WHERE tenant_id=? AND run_id=?${filter}`, args: [tenantId, runId, ...(source === 'snapshot' ? [] : [target])] })
    if (!old.rows[0]) failRecovery('Missing exact subagent checkpoint')
    const row = old.rows[0], header = { ...cleanHeader(row.header), toolCount: Number(row.tool_count), activeToolCount: Number(row.active_count), nonPlanToolCount: Number(row.effect_count) }
    if (!fullRecord && row.read_only !== null && row.read_only !== undefined) header.continuationDisplay = { readOnly: Boolean(row.read_only), ...(row.role ? { role: String(row.role) } : {}) }
    return header
  }

  async getRunHeader(tenantId: string, runId: string, fullRecord = false): Promise<SubagentRunHeader | null> {
    await this.ready()
    return this.readHeader(this.db, tenantId, runId, undefined, fullRecord)
  }

  async findHeaderByParentTool(tenantId: string, parentSessionId: string, parentToolCallId: string): Promise<SubagentRunHeader | null> {
    await this.ready()
    const found = await this.db.execute({ sql: 'SELECT run_id FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? AND parent_tool_call_id=?', args: [tenantId, parentSessionId, parentToolCallId] })
    return found.rows[0] ? this.getRunHeader(tenantId, String(found.rows[0].run_id)) : null
  }

  private legacyToolSummary(column: string, runId: string, atSeq: number): string {
    // Legacy details are returned only on demand. This SQL projection sends
    // bounded, valid JSON previews even for multi-megabyte historical args.
    const ref = `/subagent/runs/${encodeURIComponent(runId)}/tools/`
    return `json_object('id',json_extract(${column},'$.id'),'name',substr(json_extract(${column},'$.name'),1,512),
      'status',json_extract(${column},'$.status'),'args',json(CASE WHEN COALESCE(length(CAST(json_extract(${column},'$.args') AS BLOB)),0)<=1024
        THEN CASE json_type(${column},'$.args') WHEN 'object' THEN json_extract(${column},'$.args') WHEN 'array' THEN json_extract(${column},'$.args') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_quote(json_extract(${column},'$.args')) END
        ELSE json_object('preview',substr(json_extract(${column},'$.args'),1,256),'truncated',json('true')) END),
      'argsPreview',substr(json_extract(${column},'$.args'),1,256),'output',substr(json_extract(${column},'$.output'),1,1024),
      'outputPreview',substr(json_extract(${column},'$.output'),1,1024),'detailTruncated',json(CASE WHEN COALESCE(length(CAST(json_extract(${column},'$.args') AS BLOB)),0)>1024 OR COALESCE(length(json_extract(${column},'$.output')),0)>1024 OR COALESCE(length(CAST(json_extract(${column},'$.output') AS BLOB)),0)>2048 OR COALESCE(length(CAST(json_extract(${column},'$.name') AS BLOB)),0)>512 THEN 'true' ELSE 'false' END),
      'startedAt',json_extract(${column},'$.startedAt'),'finishedAt',json_extract(${column},'$.finishedAt'),'durationMs',json_extract(${column},'$.durationMs'),
      'revisionSeq',${atSeq},'ordinal',CAST(j.key AS INTEGER)+1,'detailRef','${ref.replace(/'/g, "''")}'||json_extract(${column},'$.id')||'?atSeq=${atSeq}')`
  }

  private async toolRows(q: Query, header: SubagentRunHeader, options: { afterOrdinal?: number; limit: number; recent?: boolean; active?: boolean }): Promise<SubagentToolSummary[]> {
    const { tenantId, runId, lastSeq } = header
    const checkpoint = await q.execute({ sql: 'SELECT 1 FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?', args: [tenantId, runId, lastSeq] })
    if (checkpoint.rows[0]) {
      const latest = await q.execute({ sql: 'SELECT seq FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
      if (Number(latest.rows[0]?.seq) === lastSeq) {
        const result = await q.execute({ sql: `SELECT t.summary,EXISTS(SELECT 1 FROM subagent_tool_versions v WHERE v.tenant_id=t.tenant_id AND v.run_id=t.run_id AND v.tool_id=t.tool_id AND v.seq=t.revision_seq) AS archived FROM subagent_tools t WHERE tenant_id=? AND run_id=? ${options.active ? "AND status='running'" : ''} ${options.afterOrdinal === undefined ? '' : 'AND ordinal>?'} ORDER BY ${options.recent ? 'revision_seq DESC,ordinal DESC' : 'ordinal,tool_id'} LIMIT ?`, args: [tenantId, runId, ...(options.afterOrdinal === undefined ? [] : [options.afterOrdinal]), options.limit] })
        if (result.rows.some(row => !row.archived)) failRecovery('Missing latest tool detail version')
        return result.rows.map(row => cleanToolSummary(row.summary))
      }
      // SQLite can prefer the run/seq index for this correlated query and then
      // scan every event JSON for each tool. Pin the matching expression index.
      // Unary + removes the TEXT column affinity so its JSON expression key
      // is searchable; tool IDs remain strings and equality is unchanged.
      const result = await q.execute({ sql: `SELECT v.summary,v.seq,(SELECT max(e.seq) FROM subagent_events e INDEXED BY idx_subagent_delta_tool_revision WHERE e.tenant_id=v.tenant_id AND e.run_id=v.run_id AND json_extract(e.event,'$.schemaVersion')=2 AND e.kind IN ('tool.started','tool.completed') AND json_extract(e.event,'$.toolUpsert.id')=+v.tool_id AND e.seq<=?) AS expected_seq FROM subagent_tool_versions v WHERE v.tenant_id=? AND v.run_id=? AND v.seq<=?
        AND v.seq=(SELECT max(n.seq) FROM subagent_tool_versions n WHERE n.tenant_id=v.tenant_id AND n.run_id=v.run_id AND n.tool_id=v.tool_id AND n.seq<=?)
        ${options.active ? "AND v.status='running'" : ''} ${options.afterOrdinal === undefined ? '' : 'AND v.ordinal>?'}
        ORDER BY ${options.recent ? 'v.seq DESC,v.ordinal DESC' : 'v.ordinal,v.tool_id'} LIMIT ?`,
        args: [lastSeq, tenantId, runId, lastSeq, lastSeq, ...(options.afterOrdinal === undefined ? [] : [options.afterOrdinal]), options.limit] })
      if (result.rows.some(row => row.expected_seq !== null && Number(row.expected_seq) > Number(row.seq))) failRecovery('Missing historical tool revision')
      if (isTerminalRun(header.status) && header.activeToolCount === 0 && result.rows.some(row => cleanToolSummary(row.summary).status === 'running')) failRecovery('Missing terminal tool revision')
      return result.rows.map(row => cleanToolSummary(row.summary))
    }
    const result = await q.execute({ sql: `SELECT ${this.legacyToolSummary('j.value', runId, lastSeq)} AS summary FROM subagent_events e,json_each(e.event,'$.snapshot.toolCalls') j
      WHERE e.tenant_id=? AND e.run_id=? AND e.seq=? AND json_extract(e.event,'$.schemaVersion')=1
      ${options.active ? "AND json_extract(j.value,'$.status')='running'" : ''} ${options.afterOrdinal === undefined ? '' : 'AND CAST(j.key AS INTEGER)+1>?'}
      ORDER BY ${options.recent ? "COALESCE(json_extract(j.value,'$.finishedAt'),json_extract(j.value,'$.startedAt'),0) DESC,CAST(j.key AS INTEGER) DESC" : 'CAST(j.key AS INTEGER)'} LIMIT ?`,
      args: [tenantId, runId, lastSeq, ...(options.afterOrdinal === undefined ? [] : [options.afterOrdinal]), options.limit] })
    return result.rows.map(row => ({ ...cleanToolSummary(row.summary), detailRef: `/subagent/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(cleanToolSummary(row.summary).id)}?atSeq=${lastSeq}` }))
  }

  private async viewAt(q: Query, header: SubagentRunHeader): Promise<SubagentRunView> {
    const active = await this.toolRows(q, header, { limit: 32, recent: true, active: true })
    const recent = await this.toolRows(q, header, { limit: 64, recent: true })
    const tools = [...new Map([...active, ...recent].map(tool => [tool.id, tool])).values()]
    if (header.toolCount > 0 && tools.length === 0) failRecovery('Missing tool versions at checkpoint')
    const residentActive = tools.filter(tool => tool.status === 'running').length
    const complete = tools.length === header.toolCount && residentActive === header.activeToolCount
    const { continuation, continuationDisplay, nonPlanToolCount: _effects, ...fields } = header
    const display = continuation ?? continuationDisplay
    const view: SubagentRunView = {
      ...fields, schemaVersion: 2, view: 'summary', toolCalls: tools,
      ...(display ? { continuation: { readOnly: display.readOnly, role: display.role } } : {}),
      coverage: { asOfSeq: header.lastSeq, toolCount: header.toolCount, activeToolCount: header.activeToolCount,
        includedToolCount: tools.length, includedActiveToolCount: residentActive, ids: tools.map(tool => tool.id),
        hasMore: !complete, truncated: !complete || tools.some(tool => tool.detailTruncated), completeness: complete ? 'complete' : 'partial' },
    }
    return projectSubagentRunView(view)
  }

  async getRunView(tenantId: string, runId: string, options: { atSeq?: number } = {}): Promise<SubagentRunView | null> {
    await this.ready()
    return this.read(async tx => {
      const header = await this.readHeader(tx, tenantId, runId, options.atSeq)
      return header ? this.viewAt(tx, header) : null
    })
  }

  async getViewsAtSequences(tenantId: string, watermarks: readonly { runId: string; seq: number }[]): Promise<SubagentRunView[]> {
    await this.ready()
    const views: SubagentRunView[] = []
    for (const mark of watermarks) {
      const view = await this.getRunView(tenantId, mark.runId, { atSeq: mark.seq })
      if (!view) failRecovery('Missing published child watermark')
      views.push(view!)
    }
    return views
  }

  async listRunViewsPage(tenantId: string, parentSessionId: string, options: { cursor?: string; limit?: number } = {}) {
    await this.ready()
    const limit = pageSize(options.limit)
    const scope = scopeHash('runs', tenantId, parentSessionId)
    const cursor = decodeCursor(options.cursor, scope)
    let upperAt: number, upperId: string, upperRow: number
    if (cursor) {
      if (!Number.isSafeInteger(cursor.upperAt) || typeof cursor.upperId !== 'string' || !Number.isSafeInteger(cursor.afterAt) || typeof cursor.afterId !== 'string' || !Number.isSafeInteger(cursor.upperRow) || Number(cursor.upperRow) < 0) throw new RangeError('Invalid run cursor')
      upperAt = Number(cursor.upperAt); upperId = cursor.upperId; upperRow = Number(cursor.upperRow)
    } else {
      const high = await this.db.execute({ sql: 'SELECT created_at,run_id,(SELECT COALESCE(max(rowid),0) FROM subagent_runs WHERE tenant_id=? AND parent_session_id=?) AS position FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? ORDER BY created_at DESC,run_id DESC LIMIT 1', args: [tenantId, parentSessionId, tenantId, parentSessionId] })
      upperAt = Number(high.rows[0]?.created_at ?? 0); upperId = String(high.rows[0]?.run_id ?? '')
      upperRow = Number(high.rows[0]?.position ?? 0)
    }
    const rows = await this.db.execute({ sql: `SELECT run_id,created_at FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? AND rowid<=? AND (created_at,run_id)<=(?,?) ${cursor ? 'AND (created_at,run_id)>(?,?)' : ''} ORDER BY created_at,run_id LIMIT ?`, args: [tenantId, parentSessionId, upperRow, upperAt, upperId, ...(cursor ? [Number(cursor.afterAt), String(cursor.afterId)] : []), limit + 1] })
    const items: SubagentRunView[] = []
    let bytes = 0
    for (const row of rows.rows.slice(0, limit)) {
      const view = await this.getRunView(tenantId, String(row.run_id))
      if (!view) failRecovery('Run disappeared during pagination')
      const size = sizeOf(view)
      if (items.length && bytes + size > PAGE_BYTES) break
      items.push(view!); bytes += size
    }
    const hasMore = rows.rows.length > items.length
    const last = rows.rows[items.length - 1]
    return { schemaVersion: 2 as const, parentSessionId, runs: items, hasMore, listComplete: !hasMore && !cursor, revision: scopeHash(scope, upperRow, upperAt, upperId),
      ...(hasMore && last ? { nextCursor: cursorEncode({ scope, upperAt, upperId, upperRow, afterAt: Number(last.created_at), afterId: String(last.run_id) }) } : {}) }
  }

  /** Transitional chat recovery still returns the run set; each run view is bounded. */
  async listRunViewsForParent(tenantId: string, parentSessionId: string): Promise<SubagentRunView[]> {
    const result: SubagentRunView[] = []
    let cursor: string | undefined
    do {
      const page = await this.listRunViewsPage(tenantId, parentSessionId, { cursor })
      result.push(...page.runs); cursor = page.nextCursor
    } while (cursor)
    return result
  }

  async listToolsPage(tenantId: string, runId: string, options: { atSeq: number; cursor?: string; limit?: number }) {
    await this.ready()
    const atSeq = sequence(options.atSeq), limit = pageSize(options.limit)
    const scope = scopeHash('tools', tenantId, runId, atSeq)
    const cursor = decodeCursor(options.cursor, scope)
    if (cursor && (!Number.isSafeInteger(cursor.ordinal) || Number(cursor.ordinal) < 0)) throw new RangeError('Invalid tool cursor')
    return this.read(async tx => {
      const header = await this.readHeader(tx, tenantId, runId, atSeq)
      if (!header) return null
      const after = Number(cursor?.ordinal ?? 0)
      if (after > header.toolCount) throw new RangeError('Tool cursor exceeds checkpoint count')
      const rows = await this.toolRows(tx, header, { limit: limit + 1, afterOrdinal: after })
      if (rows.some((tool, index) => tool.ordinal !== after + index + 1)) failRecovery('Missing tool ordinal in fixed watermark page')
      const items: SubagentToolSummary[] = []
      let bytes = 0
      for (const row of rows.slice(0, limit)) {
        const size = sizeOf(row)
        if (items.length && bytes + size > PAGE_BYTES) break
        items.push(row); bytes += size
      }
      const ordinal = items.at(-1)?.ordinal ?? after
      const hasMore = rows.length > items.length || ordinal < header.toolCount
      if (hasMore && items.length === 0) failRecovery('Missing subagent tool page')
      if (!hasMore && ordinal !== header.toolCount) failRecovery('Incomplete subagent tool index')
      return { schemaVersion: 2 as const, runId, asOfSeq: atSeq, items, totalCount: header.toolCount, hasMore,
        ...(hasMore ? { nextCursor: cursorEncode({ scope, ordinal }) } : {}) }
    })
  }

  async getToolDetail(tenantId: string, runId: string, toolId: string, options: { atSeq: number; offset?: number; limitBytes?: number }) {
    await this.ready()
    const atSeq = sequence(options.atSeq), offset = options.offset ?? 0, limitBytes = options.limitBytes ?? 64 * 1024
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limitBytes) || limitBytes < 4 || limitBytes > 128 * 1024) throw new RangeError('Invalid detail chunk')
    const header = await this.readHeader(this.db, tenantId, runId, atSeq)
    if (!header) return null
    const modern = await this.db.execute({ sql: 'SELECT 1 FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?', args: [tenantId, runId, atSeq] })
    const source = modern.rows[0]
      ? { sql: 'SELECT seq,summary,detail FROM subagent_tool_versions WHERE tenant_id=? AND run_id=? AND tool_id=? AND seq<=? ORDER BY seq DESC LIMIT 1', args: [tenantId, runId, toolId, atSeq] }
      : { sql: `SELECT ${atSeq} AS seq,${this.legacyToolSummary('j.value', runId, atSeq)} AS summary,j.value AS detail FROM subagent_events e,json_each(e.event,'$.snapshot.toolCalls') j WHERE e.tenant_id=? AND e.run_id=? AND e.seq=? AND json_extract(e.event,'$.schemaVersion')=1 AND json_extract(j.value,'$.id')=? LIMIT 1`, args: [tenantId, runId, atSeq, toolId] }
    // Slice the BLOB in SQLite, not after loading an oversized JSON body in JS.
    const rows = await this.db.execute({ sql: `SELECT seq,summary,length(CAST(detail AS BLOB)) AS total_bytes,substr(CAST(detail AS BLOB),?,?) AS chunk FROM (${source.sql})`, args: [offset + 1, limitBytes + 4, ...source.args] })
    if (!rows.rows[0]) {
      if (modern.rows[0]) {
        const indexed = await this.db.execute({ sql: 'SELECT 1 FROM subagent_tools WHERE tenant_id=? AND run_id=? AND tool_id=? AND ordinal<=?', args: [tenantId, runId, toolId, header.toolCount] })
        if (indexed.rows[0]) failRecovery('Missing archived tool detail')
      }
      return null
    }
    const row = rows.rows[0], totalBytes = Number(row.total_bytes)
    if (modern.rows[0]) {
      const expected = await this.db.execute({ sql: `SELECT max(COALESCE((SELECT revision_seq FROM subagent_tools WHERE tenant_id=? AND run_id=? AND tool_id=? AND revision_seq<=?),0),
        COALESCE((SELECT max(seq) FROM subagent_events INDEXED BY idx_subagent_delta_tool_revision WHERE tenant_id=? AND run_id=? AND json_extract(event,'$.schemaVersion')=2 AND kind IN ('tool.started','tool.completed') AND json_extract(event,'$.toolUpsert.id')=? AND seq<=?),0)) AS seq`, args: [tenantId, runId, toolId, atSeq, tenantId, runId, toolId, atSeq] })
      if (Number(expected.rows[0].seq) > Number(row.seq) || isTerminalRun(header.status) && header.activeToolCount === 0 && cleanToolSummary(row.summary).status === 'running') failRecovery('Missing exact tool detail revision')
    }
    if (offset > totalBytes) throw new RangeError('Detail offset exceeds length')
    const rawValue: unknown = row.chunk
    if (!(rawValue instanceof ArrayBuffer) && !(rawValue instanceof Uint8Array)) failRecovery('Invalid stored detail encoding')
    const raw = rawValue instanceof ArrayBuffer ? Buffer.from(rawValue) : Buffer.from(rawValue)
    if (raw.length && (raw[0] & 0xc0) === 0x80) throw new RangeError('Detail offset must be a UTF-8 boundary')
    let end = Math.min(limitBytes, raw.length)
    while (end > 0 && end < raw.length && (raw[end] & 0xc0) === 0x80) end--
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, end)) }
    catch { failRecovery('Invalid stored UTF-8 tool detail') }
    const nextOffset = offset + end
    return { schemaVersion: 2 as const, runId, asOfSeq: atSeq, tool: cleanToolSummary(row.summary),
      detail: { encoding: 'json-utf8' as const, text, offset, totalBytes, hasMore: nextOffset < totalBytes,
        ...(nextOffset < totalBytes ? { nextOffset } : {}) } }
  }

  async listEventsPage(tenantId: string, runId: string, options: { afterSeq?: number; limit?: number } = {}) {
    await this.ready()
    const afterSeq = options.afterSeq ?? 0, limit = pageSize(options.limit)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError('Invalid event cursor')
    const header = await this.getRunHeader(tenantId, runId)
    if (!header) return null
    if (afterSeq > header.lastSeq) failRecovery('Future event cursor')
    const rows = await this.db.execute({ sql: `SELECT seq,json_extract(event,'$.schemaVersion') AS version,CASE WHEN json_extract(event,'$.schemaVersion')=2 THEN event END AS event FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`, args: [tenantId, runId, afterSeq, header.lastSeq, limit + 1] })
    const events: SubagentDeltaEvent[] = []
    let bytes = 0, checkpointRequired = false
    for (const row of rows.rows.slice(0, limit)) {
      if (Number(row.seq) !== afterSeq + events.length + 1 || Number(row.version) !== 2) { checkpointRequired = true; break }
      const event = parse<SubagentDeltaEvent>(row.event), size = sizeOf(event)
      if (events.length && bytes + size > PAGE_BYTES) break
      events.push(event); bytes += size
    }
    const nextSeq = events.at(-1)?.seq ?? afterSeq
    if (nextSeq < header.lastSeq && rows.rows.length === events.length) checkpointRequired = true
    return { schemaVersion: 2 as const, runId, events, nextSeq, hasMore: nextSeq < header.lastSeq, checkpointRequired }
  }

  private async canonicalAt(header: SubagentRunHeader, q: Query = this.db): Promise<SubagentRun> {
    const archived = await q.execute({ sql: "SELECT json_extract(event,'$.snapshot') AS snapshot FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=? AND json_extract(event,'$.schemaVersion')=1", args: [header.tenantId, header.runId, header.lastSeq] })
    if (archived.rows[0]) return parse<SubagentRun>(archived.rows[0].snapshot)
    const rows = await q.execute({ sql: `SELECT v.detail,v.seq,(SELECT max(e.seq) FROM subagent_events e INDEXED BY idx_subagent_delta_tool_revision WHERE e.tenant_id=v.tenant_id AND e.run_id=v.run_id AND json_extract(e.event,'$.schemaVersion')=2 AND e.kind IN ('tool.started','tool.completed') AND json_extract(e.event,'$.toolUpsert.id')=+v.tool_id AND e.seq<=?) AS expected_seq FROM subagent_tool_versions v WHERE v.tenant_id=? AND v.run_id=? AND v.seq<=? AND v.seq=(SELECT max(n.seq) FROM subagent_tool_versions n WHERE n.tenant_id=v.tenant_id AND n.run_id=v.run_id AND n.tool_id=v.tool_id AND n.seq<=?) ORDER BY v.ordinal,v.tool_id`, args: [header.lastSeq, header.tenantId, header.runId, header.lastSeq, header.lastSeq] })
    if (rows.rows.length !== header.toolCount) failRecovery('Incomplete canonical tool archive')
    if (rows.rows.some(row => row.expected_seq !== null && Number(row.expected_seq) > Number(row.seq))) failRecovery('Missing canonical tool revision')
    const tools = rows.rows.map(row => parse<SubagentToolCall>(row.detail))
    if (tools.filter(tool => tool.status === 'running').length !== header.activeToolCount) failRecovery('Canonical active tool count mismatch')
    const { toolCount: _count, activeToolCount: _active, nonPlanToolCount: _effects, latestActivity: _latest, continuationDisplay: _display, ...fields } = header
    return { ...fields, schemaVersion: 1, toolCalls: tools }
  }

  /** Upgrade only a run being mutated; archive events remain byte-for-byte v1. */
  private async ensureModern(tx: Transaction, current: SubagentRunHeader): Promise<void> {
    const exists = await tx.execute({ sql: 'SELECT 1 FROM subagent_records WHERE tenant_id=? AND run_id=?', args: [current.tenantId, current.runId] })
    if (exists.rows[0]) return
    await tx.execute({ sql: `INSERT INTO subagent_records(tenant_id,run_id,record) SELECT tenant_id,run_id,json_remove(snapshot,'$.toolCalls',${stateKeys.map(key => `'$.${key}'`).join(',')}) FROM subagent_runs WHERE tenant_id=? AND run_id=?`, args: [current.tenantId, current.runId] })
    await tx.execute({ sql: `INSERT INTO subagent_tool_versions(tenant_id,run_id,tool_id,seq,ordinal,status,summary,detail)
      SELECT r.tenant_id,r.run_id,json_extract(j.value,'$.id'),?,CAST(j.key AS INTEGER)+1,json_extract(j.value,'$.status'),${this.legacyToolSummary('j.value', current.runId, current.lastSeq)},j.value
      FROM subagent_runs r,json_each(r.snapshot,'$.toolCalls') j WHERE r.tenant_id=? AND r.run_id=?`, args: [current.lastSeq, current.tenantId, current.runId] })
    await tx.execute({ sql: 'INSERT INTO subagent_tools(tenant_id,run_id,tool_id,ordinal,revision_seq,status,summary) SELECT tenant_id,run_id,tool_id,ordinal,seq,status,summary FROM subagent_tool_versions WHERE tenant_id=? AND run_id=? AND seq=?', args: [current.tenantId, current.runId, current.lastSeq] })
    await tx.execute({ sql: 'INSERT INTO subagent_checkpoints(tenant_id,run_id,seq,header) VALUES (?,?,?,?)', args: [current.tenantId, current.runId, current.lastSeq, JSON.stringify(stateOf(current))] })
  }

  private async persistDelta(tx: Transaction, kind: SubagentEvent['kind'], prior: SubagentRunHeader | null, next: SubagentRunHeader, toolUpsert?: SubagentToolSummary): Promise<SubagentMutation> {
    const state = JSON.stringify(stateOf(next))
    await tx.execute({ sql: 'INSERT INTO subagent_checkpoints(tenant_id,run_id,seq,header) VALUES (?,?,?,?)', args: [next.tenantId, next.runId, next.lastSeq, state] })
    await tx.execute({ sql: 'UPDATE subagent_runs SET status=?,seq=?,updated_at=?,snapshot=? WHERE tenant_id=? AND run_id=?', args: [next.status, next.lastSeq, next.updatedAt, JSON.stringify({ schemaVersion: 2, runId: next.runId, ...stateOf(next) }), next.tenantId, next.runId] })
    await appendDiscoveryLifecycle(tx, next)
    // Tool/output progress has no billing effect. Avoid two ledger probes per
    // token/tool update; a pre-migration parent can bootstrap on its first read.
    if (!prior || !sameChildUsage(prior, next)) await recordDurableChildUsage(tx, next)
    const view = await this.viewAt(tx, next)
    const { toolCalls: _tools, coverage: _coverage, ...header } = view
    const event: SubagentDeltaEvent = {
      schemaVersion: 2, kind, runId: next.runId, seq: next.lastSeq, baseSeq: prior?.lastSeq ?? 0,
      identity: identityOf(next), ...(prior ? {} : { header }),
      headerPatch: Object.fromEntries(stateKeys.filter(key => key !== 'nonPlanToolCount' && key in header).map(key => [key, header[key as keyof typeof header]])),
      ...(toolUpsert ? { toolUpsert } : {}),
    }
    await tx.execute({ sql: 'INSERT INTO subagent_events(tenant_id,run_id,seq,kind,event) VALUES (?,?,?,?,?)', args: [next.tenantId, next.runId, next.lastSeq, kind, JSON.stringify(event)] })
    if (kind === 'finished' && isTerminalRun(next.status)) {
      const checkpoint: SubagentWireEvent = { schemaVersion: 2, kind: 'snapshot', runId: next.runId, seq: next.lastSeq, view }
      await tx.execute({ sql: 'INSERT INTO subagent_outbox(id,tenant_id,run_id,seq,event) VALUES (?,?,?,?,?)', args: [`${next.tenantId}:${next.runId}:${next.lastSeq}`, next.tenantId, next.runId, next.lastSeq, JSON.stringify(checkpoint)] })
    }
    return { event, header: next, view }
  }

  async createRunDelta(input: CreateSubagentRun, admit?: SubagentAdmission): Promise<SubagentMutation> {
    return this.write(async tx => {
      const existing = await tx.execute({ sql: 'SELECT run_id FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? AND parent_tool_call_id=?', args: [input.tenantId, input.parentSessionId, input.parentToolCallId] })
      if (existing.rows[0]) {
        const header = (await this.readHeader(tx, input.tenantId, String(existing.rows[0].run_id), undefined, true))!
        await admit?.(tx, header, { created: false })
        const view = await this.viewAt(tx, header)
        // Idempotent creation publishes a checkpoint if the caller reattaches
        // mid-run; it must not fabricate a delta with an earlier baseSeq.
        const event: SubagentWireEvent = { schemaVersion: 2, kind: 'snapshot', runId: header.runId, seq: header.lastSeq, view }
        return { header, view, event }
      }
      const now = Date.now()
      let childSessionId = input.childSessionId ?? `subagent-${randomUUID()}`
      let continuation = input.continuation
      if (input.resumeFromRunId) {
        const prior = await this.readHeader(tx, input.tenantId, input.resumeFromRunId, undefined, true)
        if (!prior || prior.parentSessionId !== input.parentSessionId || prior.rootSessionId !== input.rootSessionId) throw new Error('SUBAGENT_RESUME_NOT_OWNED: 子代理不属于当前父任务。')
        if (!prior.continuation) throw new Error('SUBAGENT_RESUME_UNAVAILABLE: 旧记录缺少续跑权限信息。')
        if (!isTerminalRun(prior.status)) throw new Error('SUBAGENT_RESUME_BUSY: 子代理仍在执行。')
        const active = await tx.execute({ sql: "SELECT 1 FROM subagent_runs WHERE tenant_id=? AND child_session_id=? AND status IN ('queued','running','cancelling') LIMIT 1", args: [input.tenantId, prior.childSessionId] })
        if (active.rows.length) throw new Error('SUBAGENT_RESUME_BUSY: 同一子代理已有正在执行的任务。')
        childSessionId = prior.childSessionId; continuation = prior.continuation
      }
      const header: SubagentRunHeader = { ...input, continuation, agentId: continuation?.agent?.id ?? input.agentId, agentName: continuation?.agent?.name ?? input.agentName,
        schemaVersion: 1, runId: input.runId ?? randomUUID(), childSessionId, status: 'queued', lastSeq: 1, createdAt: now, updatedAt: now, usage: {}, transcriptRef: `session:${childSessionId}`,
        toolCount: 0, activeToolCount: 0, nonPlanToolCount: 0 }
      const record = Object.fromEntries(Object.entries(header).filter(([key]) => !stateKeys.includes(key as typeof stateKeys[number]) && key !== 'toolCount' && key !== 'activeToolCount' && key !== 'nonPlanToolCount'))
      await tx.execute({ sql: 'INSERT INTO subagent_runs(tenant_id,run_id,parent_session_id,parent_tool_call_id,child_session_id,status,seq,created_at,updated_at,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [header.tenantId, header.runId, header.parentSessionId, header.parentToolCallId, header.childSessionId, header.status, 1, now, now, '{}'] })
      await tx.execute({ sql: 'INSERT INTO subagent_records(tenant_id,run_id,record) VALUES (?,?,?)', args: [header.tenantId, header.runId, JSON.stringify(record)] })
      await admit?.(tx, header, { created: true })
      return this.persistDelta(tx, 'created', null, header)
    })
  }

  /** Cancel details in SQLite, never map the full tool history in the runner. */
  private async cancelActiveTools(tx: Transaction, header: SubagentRunHeader): Promise<void> {
    const at = header.finishedAt ?? header.updatedAt
    await tx.execute({ sql: `INSERT INTO subagent_tool_versions(tenant_id,run_id,tool_id,seq,ordinal,status,summary,detail)
      SELECT t.tenant_id,t.run_id,t.tool_id,?,t.ordinal,'cancelled',
        json_set(t.summary,'$.status','cancelled','$.finishedAt',?,'$.revisionSeq',?,'$.detailRef',replace(json_extract(t.summary,'$.detailRef'),'?atSeq='||t.revision_seq,'?atSeq='||?)),
        json_set(v.detail,'$.status','cancelled','$.finishedAt',?)
      FROM subagent_tools t JOIN subagent_tool_versions v ON v.tenant_id=t.tenant_id AND v.run_id=t.run_id AND v.tool_id=t.tool_id AND v.seq=t.revision_seq
      WHERE t.tenant_id=? AND t.run_id=? AND t.status='running'`, args: [header.lastSeq, at, header.lastSeq, header.lastSeq, at, header.tenantId, header.runId] })
    await tx.execute({ sql: `UPDATE subagent_tools SET status='cancelled',revision_seq=?,summary=(SELECT v.summary FROM subagent_tool_versions v WHERE v.tenant_id=subagent_tools.tenant_id AND v.run_id=subagent_tools.run_id AND v.tool_id=subagent_tools.tool_id AND v.seq=?) WHERE tenant_id=? AND run_id=? AND status='running'`, args: [header.lastSeq, header.lastSeq, header.tenantId, header.runId] })
    header.activeToolCount = 0
    const latest = await tx.execute({ sql: 'SELECT summary FROM subagent_tools WHERE tenant_id=? AND run_id=? ORDER BY revision_seq DESC,ordinal DESC LIMIT 1', args: [header.tenantId, header.runId] })
    if (latest.rows[0]) header.latestActivity = cleanToolSummary(latest.rows[0].summary)
  }

  async appendHeader(tenantId: string, runId: string, kind: SubagentEvent['kind'], patch: HeaderPatch | ((current: SubagentRunHeader) => HeaderPatch), options: { allowedStatuses?: readonly RunStatus[]; cancelActiveTools?: boolean; finishRequestKey?: string; finishPayloadHash?: string } = {}): Promise<SubagentMutation | null> {
    return this.write(async tx => {
      if (options.finishRequestKey) {
        if (kind !== 'finished' || !options.finishPayloadHash) throw new Error('INVALID_EXECUTION_RECEIPT')
        const receipt = await tx.execute({ sql: 'SELECT payload_hash,terminal_seq FROM subagent_execution_receipts WHERE tenant_id=? AND run_id=? AND request_key=?', args: [tenantId, runId, options.finishRequestKey] })
        if (receipt.rows[0]) {
          if (receipt.rows[0].payload_hash !== options.finishPayloadHash) throw new Error('EXECUTION_RECEIPT_PAYLOAD_CONFLICT')
          const header = await this.readHeader(tx, tenantId, runId, Number(receipt.rows[0].terminal_seq))
          if (!header || !isTerminalRun(header.status)) throw new Error('EXECUTION_RECEIPT_CHECKPOINT_UNKNOWN')
          const view = await this.viewAt(tx, header)
          return { header, view, event: { schemaVersion: 2, kind: 'snapshot', runId, seq: header.lastSeq, view } }
        }
      }
      const current = await this.readHeader(tx, tenantId, runId)
      if (!current || options.allowedStatuses && !options.allowedStatuses.includes(current.status)) return null
      const update = boundHeaderPatch(typeof patch === 'function' ? patch(current) : patch)
      if (isTerminalRun(current.status) && update.status !== undefined) return null
      if (current.status === 'cancelling' && (update.status === 'running' || update.status === 'succeeded')) return null
      await this.ensureModern(tx, current)
      const next = { ...current, ...update, lastSeq: current.lastSeq + 1, updatedAt: Date.now() }
      if (options.cancelActiveTools || isTerminalRun(next.status) && !isTerminalRun(current.status)) await this.cancelActiveTools(tx, next)
      const mutation = await this.persistDelta(tx, kind, current, next)
      if (options.finishRequestKey) {
        if (!isTerminalRun(next.status)) throw new Error('EXECUTION_RECEIPT_NOT_TERMINAL')
        await tx.execute({ sql: 'INSERT INTO subagent_execution_receipts VALUES(?,?,?,?,?)', args: [tenantId, runId, options.finishRequestKey, options.finishPayloadHash!, next.lastSeq] })
      }
      return mutation
    })
  }

  async upsertTool(tenantId: string, runId: string, kind: 'tool.started' | 'tool.completed', tool: Partial<SubagentToolCall> & Pick<SubagentToolCall, 'id' | 'name' | 'status'>): Promise<SubagentMutation | null> {
    if (!tool.id || Buffer.byteLength(tool.id) > 4096 || !tool.name || Buffer.byteLength(tool.name) > 4096 || kind === 'tool.started' && tool.status !== 'running' || kind === 'tool.completed' && !['succeeded','failed','cancelled'].includes(tool.status)) throw new RangeError('Invalid keyed subagent tool update')
    return this.write(async tx => {
      const current = await this.readHeader(tx, tenantId, runId)
      if (!current || kind === 'tool.started' && current.status !== 'running') return null
      await this.ensureModern(tx, current)
      const previous = await tx.execute({ sql: 'SELECT ordinal,status,summary,revision_seq FROM subagent_tools WHERE tenant_id=? AND run_id=? AND tool_id=?', args: [tenantId, runId, tool.id] })
      const old = previous.rows[0]
      if (kind === 'tool.started' && old && old.status !== 'running' || kind === 'tool.completed' && !old) return null
      const seq = current.lastSeq + 1, ordinal = old ? Number(old.ordinal) : current.toolCount + 1
      const prior = old ? cleanToolSummary(old.summary) : undefined
      if (prior && prior.name !== utf8Prefix(tool.name, 512)) throw new RangeError('Subagent tool identity changed')
      const status = prior && prior.status !== 'running' ? prior.status : tool.status
      const patch = { ...tool, status, ...(prior?.startedAt !== undefined ? { startedAt: prior.startedAt } : {}) }
      const full: SubagentToolCall = { args: tool.args ?? null, ...patch }
      const summary = summarizeSubagentTool({ ...prior, ...full, args: tool.args === undefined ? prior?.args ?? null : tool.args, revisionSeq: seq, ordinal, detailRef: `/subagent/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(tool.id)}?atSeq=${seq}` }, runId, seq, ordinal)
      // Completion retains original args by SQL patching the archived detail,
      // while JS only holds the old bounded summary and this call's new output.
      if (old) {
        const { args: _args, ...metadataPatch } = patch
        await tx.execute({ sql: `INSERT INTO subagent_tool_versions(tenant_id,run_id,tool_id,seq,ordinal,status,summary,detail) SELECT tenant_id,run_id,tool_id,?,ordinal,?,?,${tool.args === undefined ? 'json_patch(detail,?)' : "json_set(json_patch(detail,?),'$.args',json(?))"} FROM subagent_tool_versions WHERE tenant_id=? AND run_id=? AND tool_id=? AND seq=?`, args: [seq, status, JSON.stringify(summary), JSON.stringify(metadataPatch), ...(tool.args === undefined ? [] : [JSON.stringify(tool.args)]), tenantId, runId, tool.id, Number(old.revision_seq)] })
      } else {
        await tx.execute({ sql: 'INSERT INTO subagent_tool_versions(tenant_id,run_id,tool_id,seq,ordinal,status,summary,detail) VALUES (?,?,?,?,?,?,?,?)', args: [tenantId, runId, tool.id, seq, ordinal, status, JSON.stringify(summary), JSON.stringify(full)] })
      }
      await tx.execute({ sql: 'INSERT INTO subagent_tools(tenant_id,run_id,tool_id,ordinal,revision_seq,status,summary) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id,run_id,tool_id) DO UPDATE SET revision_seq=excluded.revision_seq,status=excluded.status,summary=excluded.summary', args: [tenantId, runId, tool.id, ordinal, seq, status, JSON.stringify(summary)] })
      const next: SubagentRunHeader = { ...current, lastSeq: seq, updatedAt: Date.now(), toolCount: current.toolCount + (old ? 0 : 1),
        activeToolCount: current.activeToolCount + (status === 'running' ? 1 : 0) - (old?.status === 'running' ? 1 : 0),
        nonPlanToolCount: current.nonPlanToolCount + (!old && !isTaskPlanControl(tool.name) ? 1 : 0), latestActivity: summary }
      return this.persistDelta(tx, kind, current, next, summary)
    })
  }

  async recordUsageDelta(tenantId: string, runId: string, usage: RunInvocationUsage): Promise<SubagentMutation | null> {
    if (!usage.invocationId || Buffer.byteLength(usage.invocationId) > 4096 || [usage.promptTokens, usage.completionTokens, usage.cacheHitTokens, usage.cacheWriteTokens].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))) throw new RangeError('Invalid subagent invocation usage')
    return this.write(async tx => {
      const current = await this.readHeader(tx, tenantId, runId)
      if (!current) return null
      const inserted = await tx.execute({ sql: 'INSERT OR IGNORE INTO subagent_usage_invocations(tenant_id,run_id,invocation_id) VALUES (?,?,?)', args: [tenantId, runId, usage.invocationId] })
      if (!inserted.rowsAffected) return null
      await this.ensureModern(tx, current)
      const prior = current.usage, prompt = Math.max(0, usage.promptTokens), completion = Math.max(0, usage.completionTokens)
      const next: SubagentRunHeader = { ...current, lastSeq: current.lastSeq + 1, updatedAt: Date.now(), usage: {
        inputTokens: (prior.inputTokens ?? 0) + prompt, outputTokens: (prior.outputTokens ?? 0) + completion, totalTokens: (prior.totalTokens ?? 0) + prompt + completion,
        cacheReadTokens: (prior.cacheReadTokens ?? 0) + (usage.cacheHitTokens ?? 0), cacheWriteTokens: (prior.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        ...(prior.estimated || usage.estimated ? { estimated: true } : {}), ...(prior.unknown || usage.unknown ? { unknown: true } : {}) } }
      return this.persistDelta(tx, 'usage.updated', current, next)
    })
  }

  private async persist(tx: Transaction, kind: SubagentEvent['kind'], run: SubagentRun): Promise<SubagentEvent> {
    const event: SubagentEvent = { schemaVersion: 1, kind, runId: run.runId, seq: run.lastSeq, snapshot: run }
    const encoded = JSON.stringify(event)
    await tx.execute({
      sql: `UPDATE subagent_runs SET status=?, seq=?, updated_at=?, snapshot=? WHERE tenant_id=? AND run_id=?`,
      args: [run.status, run.lastSeq, run.updatedAt, JSON.stringify(run), run.tenantId, run.runId],
    })
    await appendDiscoveryLifecycle(tx, run)
    await recordDurableChildUsage(tx, run)
    await tx.execute({
      sql: 'INSERT INTO subagent_events (tenant_id,run_id,seq,kind,event) VALUES (?,?,?,?,?)',
      args: [run.tenantId, run.runId, run.lastSeq, kind, encoded],
    })
    // Only terminal results are projected into the parent transcript. Queuing every
    // growing progress snapshot duplicates the archive and can exhaust memory on restart.
    if (kind === 'finished' && isTerminalRun(run.status)) {
      await tx.execute({
        sql: 'INSERT INTO subagent_outbox (id,tenant_id,run_id,seq,event) VALUES (?,?,?,?,?)',
        args: [`${run.tenantId}:${run.runId}:${run.lastSeq}`, run.tenantId, run.runId, run.lastSeq, encoded],
      })
    }
    return event
  }

  async createRun(input: CreateSubagentRun): Promise<SubagentEvent> {
    return this.write(async (tx) => {
      const existing = await tx.execute({
        sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? AND parent_tool_call_id=?',
        args: [input.tenantId, input.parentSessionId, input.parentToolCallId],
      })
      if (existing.rows[0]) {
        const data = parse<SubagentRun | { schemaVersion: 2; runId: string }>(existing.rows[0].snapshot)
        const run = data.schemaVersion === 1 ? data : await this.canonicalAt((await this.readHeader(tx, input.tenantId, data.runId, undefined, true))!, tx)
        return { schemaVersion: 1, kind: 'created', runId: run.runId, seq: run.lastSeq, snapshot: run }
      }
      const now = Date.now()
      let childSessionId = input.childSessionId ?? `subagent-${randomUUID()}`
      let continuation = input.continuation
      if (input.resumeFromRunId) {
        const prior = await this.readHeader(tx, input.tenantId, input.resumeFromRunId, undefined, true)
        if (!prior || prior.parentSessionId !== input.parentSessionId || prior.rootSessionId !== input.rootSessionId) throw new Error('SUBAGENT_RESUME_NOT_OWNED: 子代理不属于当前父任务。')
        if (!prior.continuation) throw new Error('SUBAGENT_RESUME_UNAVAILABLE: 旧记录缺少续跑权限信息。')
        if (!isTerminalRun(prior.status)) throw new Error('SUBAGENT_RESUME_BUSY: 子代理仍在执行。')
        const active = await tx.execute({ sql: "SELECT run_id FROM subagent_runs WHERE tenant_id=? AND child_session_id=? AND status IN ('queued','running','cancelling') LIMIT 1", args: [input.tenantId, prior.childSessionId] })
        if (active.rows.length) throw new Error('SUBAGENT_RESUME_BUSY: 同一子代理已有正在执行的任务。')
        childSessionId = prior.childSessionId
        continuation = prior.continuation
      }
      const run: SubagentRun = {
        ...input, continuation,
        agentId: continuation?.agent?.id ?? input.agentId,
        agentName: continuation?.agent?.name ?? input.agentName,
        schemaVersion: 1, runId: input.runId ?? randomUUID(), childSessionId,
        status: 'queued', lastSeq: 1, createdAt: now, updatedAt: now,
        usage: {}, toolCalls: [], transcriptRef: `session:${childSessionId}`,
      }
      await tx.execute({
        sql: `INSERT INTO subagent_runs (tenant_id,run_id,parent_session_id,parent_tool_call_id,child_session_id,status,seq,created_at,updated_at,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [run.tenantId, run.runId, run.parentSessionId, run.parentToolCallId, run.childSessionId, run.status, run.lastSeq, now, now, JSON.stringify(run)],
      })
      return this.persist(tx, 'created', run)
    })
  }

  async getRun(tenantId: string, runId: string): Promise<SubagentRun | null> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
    if (!result.rows[0]) return null
    const stored = JSON.parse(String(result.rows[0].snapshot)) as SubagentRun | { schemaVersion: 2 }
    if (stored.schemaVersion === 1) return stored
    const header = await this.getRunHeader(tenantId, runId, true)
    return header ? this.canonicalAt(header) : null
  }

  async findByParentTool(tenantId: string, parentSessionId: string, parentToolCallId: string): Promise<SubagentRun | null> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT run_id FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? AND parent_tool_call_id=?', args: [tenantId, parentSessionId, parentToolCallId] })
    return result.rows[0] ? this.getRun(tenantId, String(result.rows[0].run_id)) : null
  }

  async listRunsForParent(tenantId: string, parentSessionId: string): Promise<SubagentRun[]> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND parent_session_id=? ORDER BY created_at,run_id', args: [tenantId, parentSessionId] })
    const runs: SubagentRun[] = []
    for (const row of result.rows) {
      const data = JSON.parse(String(row.snapshot)) as SubagentRun | { schemaVersion: 2; runId: string }
      const run = data.schemaVersion === 1 ? data : await this.getRun(tenantId, data.runId)
      if (run) runs.push(run)
    }
    return runs
  }

  /** Recover exactly what the parent published, even after transcript eviction. */
  async getSnapshotsAtSequences(tenantId: string, watermarks: readonly { runId: string; seq: number }[]): Promise<SubagentRun[]> {
    await this.ready()
    const snapshots: SubagentRun[] = []
    // Stay below SQLite's conservative parameter limit without an N+1 read.
    for (let offset = 0; offset < watermarks.length; offset += 400) {
      const page = watermarks.slice(offset, offset + 400)
      const result = await this.db.execute({
        sql: `WITH requested(run_id,seq) AS (VALUES ${page.map(() => '(?,?)').join(',')})
          SELECT e.event FROM subagent_events e JOIN requested r ON e.run_id=r.run_id AND e.seq=r.seq
          WHERE e.tenant_id=?`, args: [...page.flatMap(item => [item.runId, item.seq]), tenantId],
      })
      for (const row of result.rows) {
        const event = JSON.parse(String(row.event)) as SubagentEvent | SubagentDeltaEvent
        if (event.schemaVersion === 1) snapshots.push(event.snapshot)
        else {
          const header = await this.readHeader(this.db, tenantId, event.runId, event.seq, true)
          if (!header) throw new Error('SUBAGENT_RECOVERY_REQUIRED: Missing exact legacy checkpoint')
          snapshots.push(await this.canonicalAt(header))
        }
      }
    }
    if (snapshots.length !== watermarks.length || watermarks.some(mark => !snapshots.some(run => run.runId === mark.runId && run.lastSeq === mark.seq))) failRecovery('Missing published canonical watermark')
    return snapshots
  }

  async listChildSessionIds(tenantId: string): Promise<string[]> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT DISTINCT child_session_id FROM subagent_runs WHERE tenant_id=?', args: [tenantId] })
    return result.rows.map((row) => String(row.child_session_id))
  }

  async appendSnapshot(tenantId: string, runId: string, kind: SubagentEvent['kind'], patch: PatchSource, options: { allowedStatuses?: readonly RunStatus[] } = {}): Promise<SubagentEvent | null> {
    await this.ready()
    const version = await this.db.execute({ sql: "SELECT json_extract(snapshot,'$.schemaVersion') AS version FROM subagent_runs WHERE tenant_id=? AND run_id=?", args: [tenantId, runId] })
    if (Number(version.rows[0]?.version) === 2) {
      const current = (await this.getRun(tenantId, runId))!
      const update = typeof patch === 'function' ? patch(current) : patch
      if (update.toolCalls !== undefined) throw new Error('SUBAGENT_LEGACY_WRITE_UNSUPPORTED: Use keyed tool updates for modern runs')
      const mutation = await this.appendHeader(tenantId, runId, kind, update, options)
      if (!mutation) return null
      const snapshot = (await this.getSnapshotsAtSequences(tenantId, [{ runId, seq: mutation.header.lastSeq }]))[0]
      return { schemaVersion: 1, kind, runId, seq: snapshot.lastSeq, snapshot }
    }
    return this.write(async (tx) => {
      const result = await tx.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
      if (!result.rows[0]) return null
      const current = JSON.parse(String(result.rows[0].snapshot)) as SubagentRun
      if (options.allowedStatuses && !options.allowedStatuses.includes(current.status)) return null
      const update = typeof patch === 'function' ? patch(current) : patch
      // Late usage/detail may supplement a terminal snapshot, but never replace its outcome.
      if (isTerminalRun(current.status) && update.status !== undefined) return null
      if (current.status === 'cancelling' && (update.status === 'running' || update.status === 'succeeded')) return null
      const next = { ...current, ...update, lastSeq: current.lastSeq + 1, updatedAt: Date.now() }
      return this.persist(tx, kind, next)
    })
  }

  async recordUsage(tenantId: string, runId: string, usage: RunInvocationUsage): Promise<SubagentEvent | null> {
    await this.ready()
    const version = await this.db.execute({ sql: "SELECT json_extract(snapshot,'$.schemaVersion') AS version FROM subagent_runs WHERE tenant_id=? AND run_id=?", args: [tenantId, runId] })
    if (Number(version.rows[0]?.version) === 2) {
      const mutation = await this.recordUsageDelta(tenantId, runId, usage)
      if (!mutation) return null
      const snapshot = (await this.getSnapshotsAtSequences(tenantId, [{ runId, seq: mutation.header.lastSeq }]))[0]
      return { schemaVersion: 1, kind: 'usage.updated', runId, seq: snapshot.lastSeq, snapshot }
    }
    return this.write(async (tx) => {
      const result = await tx.execute({ sql: 'SELECT snapshot FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })
      if (!result.rows[0]) return null
      const inserted = await tx.execute({ sql: 'INSERT OR IGNORE INTO subagent_usage_invocations (tenant_id,run_id,invocation_id) VALUES (?,?,?)', args: [tenantId, runId, usage.invocationId] })
      if (inserted.rowsAffected === 0) return null
      const current = JSON.parse(String(result.rows[0].snapshot)) as SubagentRun
      const prior = current.usage
      const prompt = Math.max(0, usage.promptTokens)
      const completion = Math.max(0, usage.completionTokens)
      const next: SubagentRun = {
        ...current, lastSeq: current.lastSeq + 1, updatedAt: Date.now(),
        usage: {
          inputTokens: (prior.inputTokens ?? 0) + prompt,
          outputTokens: (prior.outputTokens ?? 0) + completion,
          totalTokens: (prior.totalTokens ?? 0) + prompt + completion,
          cacheReadTokens: (prior.cacheReadTokens ?? 0) + (usage.cacheHitTokens ?? 0),
          cacheWriteTokens: (prior.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          ...(prior.estimated || usage.estimated ? { estimated: true } : {}),
          ...(prior.unknown || usage.unknown ? { unknown: true } : {}),
        },
      }
      return this.persist(tx, 'usage.updated', next)
    })
  }

  async listEvents(tenantId: string, runId: string, afterSeq = 0): Promise<SubagentEvent[]> {
    await this.ready()
    const result = await this.db.execute({ sql: 'SELECT event FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq>? ORDER BY seq', args: [tenantId, runId, afterSeq] })
    const events: SubagentEvent[] = []
    for (const row of result.rows) {
      const event = parse<SubagentEvent | SubagentDeltaEvent>(row.event)
      if (event.schemaVersion === 1) events.push(event)
      else {
        const header = await this.readHeader(this.db, tenantId, runId, event.seq, true)
        if (!header) failRecovery('Missing legacy event checkpoint')
        events.push({ schemaVersion: 1, kind: event.kind, runId, seq: event.seq, snapshot: await this.canonicalAt(header!) })
      }
    }
    return events
  }

  /** Read one bounded page; acknowledgment advances the queue without an OFFSET. */
  async listPendingParentProjections(tenantId?: string, limit = 32): Promise<ParentProjection[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Projection page size must be a positive integer')
    await this.ready()
    const result = await this.db.execute({
      // Legacy queues contain gigabytes of progress snapshots. Filter on indexed
      // event identity and kind in SQLite, before any JSON crosses the process boundary.
      // Retain those old rows and the canonical event archive without rewriting user data.
      sql: `SELECT o.id,o.tenant_id,o.run_id,o.seq FROM subagent_outbox o
        JOIN subagent_events e ON e.tenant_id=o.tenant_id AND e.run_id=o.run_id AND e.seq=o.seq
        WHERE o.acknowledged=0 AND e.kind='finished'${tenantId ? ' AND o.tenant_id=?' : ''}
        ORDER BY o.tenant_id,o.run_id,o.seq LIMIT ?`,
      args: [...(tenantId ? [tenantId] : []), Math.min(limit, 32)],
    })
    const projections: ParentProjection[] = []
    for (const row of result.rows) {
      const view = await this.getRunView(String(row.tenant_id), String(row.run_id), { atSeq: Number(row.seq) })
      if (!view) failRecovery('Missing terminal outbox checkpoint')
      projections.push({ id: String(row.id), tenantId: String(row.tenant_id), event: { schemaVersion: 2, kind: 'snapshot', runId: view!.runId, seq: view!.lastSeq, view: view! } })
    }
    return projections
  }

  async ackProjection(id: string, tenantId: string): Promise<void> {
    await this.ready()
    await this.db.execute({ sql: 'UPDATE subagent_outbox SET acknowledged=1 WHERE id=? AND tenant_id=?', args: [id, tenantId] })
  }

  async finishReceipt(tenantId: string, runId: string, requestKey: string, payloadHash: string): Promise<SubagentMutation | null> {
    await this.ready()
    return this.read(async tx => {
      const row = await tx.execute({ sql: 'SELECT payload_hash,terminal_seq FROM subagent_execution_receipts WHERE tenant_id=? AND run_id=? AND request_key=?', args: [tenantId, runId, requestKey] })
      if (!row.rows[0]) return null
      if (row.rows[0].payload_hash !== payloadHash) throw new Error('EXECUTION_RECEIPT_PAYLOAD_CONFLICT')
      const header = await this.readHeader(tx, tenantId, runId, Number(row.rows[0].terminal_seq))
      if (!header || !isTerminalRun(header.status)) throw new Error('EXECUTION_RECEIPT_CHECKPOINT_UNKNOWN')
      const view = await this.viewAt(tx, header)
      return { header, view, event: { schemaVersion: 2, kind: 'snapshot', runId, seq: header.lastSeq, view } }
    })
  }

  async ownedParentProjection(tenantId: string, runId: string, seq: number): Promise<{ acknowledged: boolean; disposition?: 'appended' | 'duplicate' | 'suppressed' }> {
    await this.ready()
    const result = await this.db.execute({ sql: `SELECT o.acknowledged,p.disposition FROM subagent_outbox o LEFT JOIN subagent_projection_receipts p
      ON p.tenant_id=o.tenant_id AND p.run_id=o.run_id AND p.seq=o.seq WHERE o.tenant_id=? AND o.run_id=? AND o.seq=?`, args: [tenantId, runId, seq] })
    if (!result.rows[0]) throw new Error('OWNED_PROJECTION_OUTBOX_MISSING')
    const row = result.rows[0]
    return { acknowledged: Boolean(row.acknowledged), ...(row.disposition ? { disposition: String(row.disposition) as 'appended' | 'duplicate' | 'suppressed' } : {}) }
  }
  async ackOwnedProjection(tenantId: string, runId: string, seq: number, messageId: string, disposition: 'appended' | 'duplicate' | 'suppressed'): Promise<void> {
    await this.write(async tx => {
      const existing = await tx.execute({ sql: 'SELECT message_id,disposition FROM subagent_projection_receipts WHERE tenant_id=? AND run_id=? AND seq=?', args: [tenantId, runId, seq] })
      if (existing.rows[0] && (existing.rows[0].message_id !== messageId || existing.rows[0].disposition !== disposition)) throw new Error('OWNED_PROJECTION_RECEIPT_CONFLICT')
      if (!existing.rows[0]) await tx.execute({ sql: 'INSERT INTO subagent_projection_receipts VALUES(?,?,?,?,?)', args: [tenantId, runId, seq, messageId, disposition] })
      const updated = await tx.execute({ sql: 'UPDATE subagent_outbox SET acknowledged=1 WHERE tenant_id=? AND run_id=? AND seq=? RETURNING id', args: [tenantId, runId, seq] })
      if (!updated.rows.length) throw new Error('OWNED_PROJECTION_OUTBOX_MISSING')
    })
  }

  async deleteRunsForParent(tenantId: string, parentSessionId: string): Promise<void> {
    await this.write(async (tx) => {
      // The caller cancels and joins active runners first, so no late terminal write can resurrect this tree.
      for (const table of ['subagent_usage_invocations', 'subagent_outbox', 'subagent_events', 'subagent_tool_versions', 'subagent_tools', 'subagent_checkpoints', 'subagent_records']) {
        await tx.execute({ sql: `DELETE FROM ${table} WHERE tenant_id=? AND run_id IN (SELECT run_id FROM subagent_runs WHERE tenant_id=? AND parent_session_id=?)`, args: [tenantId, tenantId, parentSessionId] })
      }
      await tx.execute({ sql: 'DELETE FROM subagent_runs WHERE tenant_id=? AND parent_session_id=?', args: [tenantId, parentSessionId] })
      await resetParentDiscovery(tx, tenantId, parentSessionId)
      await resetParentChildRecovery(tx, tenantId, parentSessionId)
      await ensureParentChildUsage(tx, tenantId, parentSessionId)
    })
  }

  async deleteRuns(tenantId: string, runIds: string[]): Promise<void> {
    if (runIds.length === 0) return
    await this.write(async (tx) => {
      const affectedParents = new Set<string>()
      for (const runId of new Set(runIds)) {
        const owner = (await tx.execute({ sql: 'SELECT parent_session_id FROM subagent_runs WHERE tenant_id=? AND run_id=?', args: [tenantId, runId] })).rows[0]
        if (owner) affectedParents.add(String(owner.parent_session_id))
        await tombstoneDiscoveryRun(tx, tenantId, runId)
        for (const table of ['subagent_usage_invocations', 'subagent_outbox', 'subagent_events', 'subagent_tool_versions', 'subagent_tools', 'subagent_checkpoints', 'subagent_records', 'subagent_runs']) {
          await tx.execute({ sql: `DELETE FROM ${table} WHERE tenant_id=? AND run_id=?`, args: [tenantId, runId] })
        }
      }
      // A destructive clear invalidates publication leases before exact checkpoints
      // disappear. Survivors acquire a fresh, atomically complete usage baseline.
      for (const parentSessionId of affectedParents) {
        await resetParentChildRecovery(tx, tenantId, parentSessionId)
        await ensureParentChildUsage(tx, tenantId, parentSessionId)
      }
    })
  }

  async captureChildUsage(tenantId: string, parentSessionId: string): Promise<ChildUsageFence> {
    await this.ready()
    const existing = await this.read(async tx => {
      const marker = (await tx.execute({ sql: 'SELECT bootstrap_complete FROM subagent_usage_parent_state WHERE tenant_id=? AND parent_session_id=?', args: [tenantId, parentSessionId] })).rows[0]
      return marker ? readChildUsageFence(tx, tenantId, parentSessionId) : null
    })
    return existing ?? this.write(tx => ensureParentChildUsage(tx, tenantId, parentSessionId))
  }

  async childUsageAt(fence: ChildUsageFence): Promise<ChildUsageScalar> {
    await this.ready()
    return this.read(tx => readDurableChildUsage(tx, fence))
  }

  /** Discovery is independent of ordinary directory pages and never materializes canonical outputs. */
  async listDiscoveryPage(tenantId: string, parentSessionId: string, options: DiscoveryOptions & { rootSessionId?: string; parentConversationId?: string }): Promise<DiscoveryPage> {
    const scope = { tenantId, parentSessionId,
      ...(options.rootSessionId === undefined ? {} : { rootSessionId: options.rootSessionId }),
      ...(options.parentConversationId === undefined ? {} : { parentConversationId: options.parentConversationId }) }
    // Ordinary observation must not wait behind or compete for the global SQLite
    // writer. Check the marker and consume its page in the same read snapshot;
    // only a genuinely missing baseline needs the atomic bootstrap write.
    const page = await this.read(async tx => {
      const initialized = await tx.execute({ sql: 'SELECT 1 FROM subagent_discovery_state WHERE tenant_id=? AND parent_session_id=?', args: [tenantId, parentSessionId] })
      return initialized.rows.length ? readDiscoveryPage(tx, scope, options) : null
    })
    if (page) return page
    await this.write(tx => ensureParentDiscovery(tx, tenantId, parentSessionId))
    return this.read(tx => readDiscoveryPage(tx, scope, options))
  }

  /** Call once before accepting requests; never restart potentially side-effecting tools automatically. */
  async recoverInterrupted(): Promise<SubagentWireEvent[]> {
    await this.ready()
    const result = await this.db.execute("SELECT tenant_id,run_id FROM subagent_runs WHERE status IN ('queued','running','cancelling')")
    const events: SubagentWireEvent[] = []
    for (const row of result.rows) {
      const mutation = await this.appendHeader(String(row.tenant_id), String(row.run_id), 'finished', (current) => ({
        status: 'interrupted', stopReason: 'engine_restarted', finishedAt: Date.now(),
        durationMs: current.startedAt ? Date.now() - current.startedAt : 0,
        error: { code: 'ENGINE_RESTARTED', message: '引擎重启，任务执行状态未知，未自动重跑。', retryable: false },
        usage: { ...current.usage, unknown: true },
      }), { allowedStatuses: ['queued', 'running', 'cancelling'], cancelActiveTools: true })
      if (mutation) events.push(mutation.event)
    }
    return events
  }
}

let singleton: SubagentStore | undefined
export function getSubagentStore(): SubagentStore {
  const db = getDb()
  if (!singleton || singleton.db !== db) singleton = new SubagentStore(db)
  return singleton
}
