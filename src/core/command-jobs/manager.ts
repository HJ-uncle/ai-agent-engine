import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Client, Transaction, Row } from '@libsql/client'
import { getDb } from '../../storage/sqlite/db.js'
import { ExecutionParkError, throwIfAborted } from '../utils/abort.js'
import { stopCommandProcessTree } from './process-tree.js'
import { createCommandLaunchPlan } from './launch-plan.js'
import { getCommandOutputFiles, type CommandOutputReader } from './output-files.js'
import { COMMAND_OUTPUT_BYTES, COMMAND_PAGE_BYTES, commandJobIsTerminal,
  type CommandJobLaunch, type CommandJobOutput, type CommandJobScope, type CommandJobSnapshot, type CommandOutputEntry, type CommandOutputOptions, type CommandScopeCapture, type CommandChangeObserver } from './types.js'

const schemas = new WeakMap<Client, Promise<void>>()
const writeGates = new WeakMap<Client, Promise<void>>()

interface StoredJob { tenantId: string; job: CommandJobSnapshot; entries: CommandOutputEntry[]; outputStorageVersion?: number }
interface LiveJob extends StoredJob {
  db: Client
  child?: ChildProcess
  retainedBytes: number
  completion: Promise<CommandJobSnapshot>
  resolve: (job: CommandJobSnapshot) => void
  completionWaiters?: Set<(job: CommandJobSnapshot) => void>
  termination?: Promise<void>
  stopReason?: 'cancelled' | 'timed_out'
  stopError?: Error
  closed: boolean
  timer?: ReturnType<typeof setTimeout>
  flushTimer?: ReturnType<typeof setTimeout>
  cleanupSignal: () => void
  writes: Promise<void>
  flushing?: Promise<void>
  persistRetryTimer?: ReturnType<typeof setTimeout>
  persistRetryDelayMs?: number
  pendingWrite?: StoredJob
  /** Output chunks awaiting durable insertion. The in-memory entries array remains a bounded tail. */
  pendingOutput: CommandOutputEntry[]
  pendingOutputBytes: number
  outputPaused: boolean
  persistError?: Error
  persistedVersion: number
  changeObserver?: CommandChangeObserver
  wasSpawned?: boolean
}

export interface CommandJobManagerOptions {
  db?: Client
  maxOutputBytes?: number
  maxPageBytes?: number
  maxConcurrentJobs?: number
  maxRetainedJobs?: number
  maxSessionJobs?: number
  retentionMs?: number
  /** Only for an injected :memory: fixture; durable stores derive their real SQLite path. */
  isolatedOutputRoot?: string
}

interface Admission { input: CommandJobLaunch; db: Client; cancelled: boolean; done: Promise<void>; live?: LiveJob }
interface CapturedScope { db: Client; admissions: Admission[]; jobs: LiveJob[]; cancellation?: Promise<CommandJobSnapshot[]> }

const scopeMatches = (stored: StoredJob, scope: CommandJobScope) => stored.tenantId === scope.tenantId && stored.job.sessionId === scope.sessionId &&
  (scope.runId === undefined || stored.job.runId === scope.runId) &&
  (scope.ownerSessionId === undefined || stored.job.ownerSessionId === scope.ownerSessionId) &&
  (scope.ownerRunId === undefined || stored.job.ownerRunId === scope.ownerRunId)
const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400, code: 'COMMAND_CURSOR_INVALID' })
const clone = <T>(value: T): T => structuredClone(value)

/** Same-process command handles, with bounded durable tails for reload/restart inspection. */
export class CommandJobManager {
  private readonly active = new Map<string, LiveJob>()
  private readonly outputLimit: number
  private readonly pageLimit: number
  private readonly pendingOutputLimit: number
  private readonly concurrentLimit: number
  private starting = 0
  private stopping = false
  private currentDb?: Client
  private readonly admissions = new Set<Admission>()
  private readonly capturedScopes = new WeakMap<CommandScopeCapture, CapturedScope>()
  private readonly shutdowns = new WeakMap<Client, Promise<void>>()
  /** Terminal jobs whose final durable write is waiting for a transient DB recovery. */
  private readonly retrying = new Set<LiveJob>()

  constructor(private readonly options: CommandJobManagerOptions = {}) {
    this.outputLimit = Math.max(4, Math.floor(options.maxOutputBytes ?? COMMAND_OUTPUT_BYTES))
    this.pageLimit = Math.max(4, Math.min(Math.floor(options.maxPageBytes ?? COMMAND_PAGE_BYTES), this.outputLimit))
    // A slow disk must apply backpressure to the child instead of allowing an unbounded queue.
    this.pendingOutputLimit = Math.max(256 * 1024, this.outputLimit * 2)
    this.concurrentLimit = Math.max(1, Math.floor(options.maxConcurrentJobs ?? 16))
  }

  private get db(): Client { return this.options.db ?? getDb() }

  private async writeTransaction(db: Client): Promise<Transaction> {
    const files = await getCommandOutputFiles(db, this.options.isolatedOutputRoot)
    const prior = writeGates.get(db) ?? Promise.resolve()
    let unlock!: () => void
    const gate = new Promise<void>(resolve => { unlock = resolve })
    writeGates.set(db, gate)
    await prior
    let released = false
    const release = () => { if (!released) { released = true; unlock() } }
    try {
      if (!files.transient) {
        const tx = await db.transaction('write')
        return new Proxy(tx, { get(target, property) {
          if (property === 'close') return () => { try { target.close() } finally { release() } }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      }
      // Native libsql transaction() detaches the current connection. A private
      // :memory: DB would disappear on its next query, so keep fixtures on one
      // serialized connection. Durable/remote clients never use this adapter.
      await db.execute('BEGIN IMMEDIATE')
      let closed = false
      return {
        execute: statement => db.execute(statement),
        batch: async statements => { const results = []; for (const statement of statements) results.push(await db.execute(statement)); return results },
        executeMultiple: sql => db.executeMultiple(sql),
        commit: async () => { await db.execute('COMMIT'); closed = true },
        rollback: async () => { if (!closed) { try { await db.execute('ROLLBACK') } finally { closed = true } } },
        close: () => { if (!closed) { closed = true; void db.execute('ROLLBACK').finally(release).catch(() => undefined) } else release() },
        get closed() { return closed },
      }
    } catch (error) { release(); throw error }
  }

  private async writeBatch(db: Client, statements: Parameters<Transaction['batch']>[0]): Promise<void> {
    const tx = await this.writeTransaction(db)
    try { await tx.batch(statements); await tx.commit() }
    catch (error) { await tx.rollback().catch(() => undefined); throw error }
    finally { tx.close() }
  }

  async initialize(): Promise<void> {
    const db = this.db
    if (this.currentDb !== db) { if (this.currentDb) this.stopping = false; this.currentDb = db }
    let initialized = schemas.get(db)
    if (!initialized) {
      initialized = (async () => {
        await db.execute(`CREATE TABLE IF NOT EXISTS command_jobs (
          tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, job_id TEXT PRIMARY KEY,
          status TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, entries TEXT NOT NULL,
          output_bytes INTEGER NOT NULL DEFAULT 0, storage_version INTEGER NOT NULL DEFAULT 0,
          tail_migrated INTEGER NOT NULL DEFAULT 0, tail_cursor INTEGER NOT NULL DEFAULT 0)`)
        await db.execute('CREATE INDEX IF NOT EXISTS command_jobs_session ON command_jobs(tenant_id,session_id)')
        await db.execute(`CREATE TABLE IF NOT EXISTS command_job_output (
          tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, job_id TEXT NOT NULL,
          seq INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL,
          storage_version INTEGER NOT NULL DEFAULT 0, byte_offset INTEGER, byte_length INTEGER,
          PRIMARY KEY (job_id, seq))`)
        for (const [table, columns] of [
          ['command_jobs', ['output_bytes INTEGER NOT NULL DEFAULT 0', 'storage_version INTEGER NOT NULL DEFAULT 0', 'tail_migrated INTEGER NOT NULL DEFAULT 0', 'tail_cursor INTEGER NOT NULL DEFAULT 0']],
          ['command_job_output', ['storage_version INTEGER NOT NULL DEFAULT 0', 'byte_offset INTEGER', 'byte_length INTEGER']],
        ] as const) {
          const present = new Set((await db.execute(`PRAGMA table_info(${table})`)).rows.map(row => String(row.name)))
          for (const column of columns) if (!present.has(column.split(' ')[0])) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column}`)
        }
        await db.execute('CREATE INDEX IF NOT EXISTS command_job_output_lookup ON command_job_output(tenant_id,session_id,job_id,seq)')
        await db.execute(`CREATE TABLE IF NOT EXISTS command_output_gc (
          tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,job_id TEXT PRIMARY KEY)`)
        await getCommandOutputFiles(db, this.options.isolatedOutputRoot)
        // Recovery reads only execution metadata. Old bodies migrate in bounded
        // per-job pages on demand, never by scanning every tail at startup.
        const previous = await db.execute("SELECT tenant_id,snapshot FROM command_jobs WHERE status IN ('running','cancelling')")
        for (const row of previous.rows) {
          const job = JSON.parse(String(row.snapshot)) as CommandJobSnapshot
          job.status = 'interrupted'; job.version++; job.updatedAt = job.finishedAt = Date.now()
          job.exitCode = null; job.signal = null
          job.error = { code: 'ENGINE_RESTARTED', message: 'Engine restarted. This command was not reattached or rerun; its former process state is unknown.' }
          if (job.changeTracking?.status === 'observing') job.changeTracking = { ...job.changeTracking, status: 'unavailable',
            note: '引擎已重启，命令前的内存快照已丢失；未推断或自动回退其文件副作用。' }
          await this.save({ tenantId: String(row.tenant_id), job, entries: [] }, db)
        }
        await this.prune(db)
      })()
      schemas.set(db, initialized)
      initialized.catch(() => { if (schemas.get(db) === initialized) schemas.delete(db) })
    }
    await initialized
  }

  /** Retain active work and a bounded recent terminal history, including its bounded tails. */
  private async prune(db = this.db): Promise<void> {
    const limit = Math.max(1, Math.floor(this.options.maxRetainedJobs ?? 500))
    const sessionLimit = Math.max(1, Math.floor(this.options.maxSessionJobs ?? 100))
    const oldest = Date.now() - Math.max(0, this.options.retentionMs ?? 7 * 24 * 60 * 60 * 1000)
    const rows = await db.execute({ sql: `WITH terminal AS (
      SELECT job_id,tenant_id,session_id,json_extract(snapshot,'$.updatedAt') AS updated_at,
        row_number() OVER(PARTITION BY tenant_id,session_id ORDER BY json_extract(snapshot,'$.updatedAt') DESC,job_id DESC) AS session_rank
      FROM command_jobs WHERE status NOT IN ('running','cancelling')
    ), eligible AS (SELECT job_id,row_number() OVER(ORDER BY updated_at DESC,job_id DESC) AS global_rank
      FROM terminal WHERE updated_at>=? AND session_rank<=?)
    SELECT t.job_id,t.tenant_id,t.session_id FROM terminal t LEFT JOIN eligible e ON e.job_id=t.job_id
    WHERE t.updated_at<? OR t.session_rank>? OR e.global_rank>? LIMIT 128`, args: [oldest, sessionLimit, oldest, sessionLimit, limit] })
    if (rows.rows.length) await this.writeBatch(db, rows.rows.flatMap(row => [
      { sql: 'INSERT OR IGNORE INTO command_output_gc(tenant_id,session_id,job_id) VALUES(?,?,?)', args: [row.tenant_id, row.session_id, row.job_id] },
      { sql: 'DELETE FROM command_job_output WHERE job_id=?', args: [row.job_id] },
      { sql: "DELETE FROM command_jobs WHERE job_id=? AND status NOT IN ('running','cancelling')", args: [row.job_id] },
    ]))
    await this.collectOutputFiles(db)
  }

  private saveStatement(stored: StoredJob, outputBytes = 0) {
    return {
      sql: `INSERT INTO command_jobs(tenant_id,session_id,job_id,status,version,snapshot,entries,output_bytes,storage_version,tail_migrated) VALUES(?,?,?,?,?,?,'[]',?,1,1)
        ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,version=excluded.version,snapshot=excluded.snapshot,
        entries=CASE WHEN command_jobs.tail_migrated=1 THEN '[]' ELSE command_jobs.entries END,
        output_bytes=MAX(command_jobs.output_bytes,excluded.output_bytes)
        WHERE excluded.version >= command_jobs.version`,
      args: [stored.tenantId, stored.job.sessionId, stored.job.jobId, stored.job.status, stored.job.version,
        JSON.stringify(stored.job), outputBytes],
    }
  }

  private async save(stored: StoredJob, db = this.db): Promise<void> {
    await db.execute(this.saveStatement(stored))
  }

  private async collectOutputFiles(db: Client, requestedJobId?: string): Promise<void> {
    const pending = (await db.execute('SELECT 1 FROM command_output_gc LIMIT 1')).rows.length
    if (!pending) return
    const tx = await this.writeTransaction(db)
    try {
    const rows = (await tx.execute({ sql: `SELECT g.tenant_id,g.session_id,g.job_id FROM command_output_gc g
      WHERE NOT EXISTS(SELECT 1 FROM command_jobs j WHERE j.job_id=g.job_id)
      ORDER BY CASE WHEN g.job_id=? THEN 0 ELSE 1 END,g.job_id LIMIT 32`, args: [requestedJobId ?? ''] })).rows
    const files = await getCommandOutputFiles(db, this.options.isolatedOutputRoot)
    for (const row of rows) {
      try {
        await files.remove({ tenantId: String(row.tenant_id), sessionId: String(row.session_id), jobId: String(row.job_id) })
        await tx.execute({ sql: 'DELETE FROM command_output_gc WHERE job_id=?', args: [row.job_id] })
      } catch { /* A durable queue retains failures for the next bounded sweep. */ }
    }
    await tx.commit()
    } catch (error) { await tx.rollback().catch(() => undefined); throw error }
    finally { tx.close() }
  }

  /** One-time tail conversion is checkpointed, scoped and bounded; it never transports bodies to JS. */
  private async migrateLegacyTail(tx: Transaction, stored: StoredJob): Promise<void> {
    const row = (await tx.execute({ sql: 'SELECT tail_migrated,tail_cursor,json_array_length(entries) AS count FROM command_jobs WHERE job_id=?', args: [stored.job.jobId] })).rows[0]
    if (!row || Number(row.tail_migrated) === 1) return
    const cursor = Number(row.tail_cursor), total = Number(row.count)
    const candidates = (await tx.execute({ sql: `SELECT CAST(j.key AS INTEGER) AS ordinal,length(CAST(json_extract(j.value,'$.text') AS BLOB)) AS bytes
      FROM command_jobs c,json_each(c.entries) j WHERE c.job_id=? AND CAST(j.key AS INTEGER)>=? ORDER BY CAST(j.key AS INTEGER) LIMIT 2048`,
      args: [stored.job.jobId, cursor] })).rows
    let bytes = 0, end = cursor
    for (const item of candidates) {
      // A single old tail entry is copied within SQLite, never loaded into JS;
      // later file conversion can leave an oversized body in the bounded SQL reader.
      // Old live tails were capped at 2048 entries of at most 4096 bytes. This
      // metadata-only selection covers that finite tail without startup scans.
      if (end > cursor && bytes + Number(item.bytes) > 8 * 1024 * 1024) break
      bytes += Number(item.bytes); end = Number(item.ordinal) + 1
    }
    if (end > cursor) await tx.execute({ sql: `INSERT OR IGNORE INTO command_job_output(tenant_id,session_id,job_id,seq,stream,text)
      SELECT c.tenant_id,c.session_id,c.job_id,json_extract(j.value,'$.seq'),json_extract(j.value,'$.stream'),json_extract(j.value,'$.text')
      FROM command_jobs c,json_each(c.entries) j WHERE c.job_id=? AND CAST(j.key AS INTEGER)>=? AND CAST(j.key AS INTEGER)<?`,
      args: [stored.job.jobId, cursor, end] })
    await tx.execute({ sql: `UPDATE command_jobs SET tail_cursor=?,tail_migrated=?,entries=CASE WHEN ?=1 THEN '[]' ELSE entries END WHERE job_id=?`,
      args: [end, end >= total ? 1 : 0, end >= total ? 1 : 0, stored.job.jobId] })
  }

  /** Migrate at most 64 rows / 256 KiB; large legacy single rows retain SQL range reads. */
  private async migrateLegacyOutput(stored: StoredJob): Promise<void> {
    // v2 is a completed migration with oversized legacy rows intentionally left
    // on the SQL range reader. Polling it must not reopen a write transaction.
    if (stored.outputStorageVersion === 1 || stored.outputStorageVersion === 2) return
    const db = this.db, tx = await this.writeTransaction(db)
    try {
      await this.migrateLegacyTail(tx, stored)
      const row = (await tx.execute({ sql: 'SELECT output_bytes,tail_migrated FROM command_jobs WHERE job_id=?', args: [stored.job.jobId] })).rows[0]
      if (!row) { await tx.rollback(); return }
      const candidates = (await tx.execute({ sql: `SELECT seq,length(CAST(text AS BLOB)) AS bytes FROM command_job_output
        WHERE job_id=? AND storage_version=0 AND length(CAST(text AS BLOB))<=262144 ORDER BY seq LIMIT 64`, args: [stored.job.jobId] })).rows
      let bytes = 0
      const selected: number[] = []
      for (const item of candidates) {
        const size = Number(item.bytes)
        if (size > 256 * 1024) continue
        if (bytes + size > 256 * 1024) break
        selected.push(Number(item.seq)); bytes += size
      }
      let position = Number(row.output_bytes)
      if (selected.length) {
        const bodies = (await tx.execute({ sql: `SELECT seq,CAST(text AS BLOB) AS body FROM command_job_output WHERE job_id=? AND storage_version=0
          AND seq IN (${selected.map(() => '?').join(',')}) ORDER BY seq`, args: [stored.job.jobId, ...selected] })).rows
        const chunks = bodies.map(body => Buffer.from(new Uint8Array(body.body as ArrayBuffer)))
        await (await getCommandOutputFiles(db, this.options.isolatedOutputRoot)).append(
          { tenantId: stored.tenantId, sessionId: stored.job.sessionId, jobId: stored.job.jobId }, position, chunks)
        const updates = bodies.map((body, index) => {
          const length = chunks[index].length
          const update = { sql: `UPDATE command_job_output SET storage_version=1,byte_offset=?,byte_length=?,text=''
            WHERE job_id=? AND seq=? AND storage_version=0`, args: [position, length, stored.job.jobId, body.seq] }
          position += length
          return update
        })
        await tx.batch(updates)
      }
      const remaining = (await tx.execute({ sql: 'SELECT 1 FROM command_job_output WHERE job_id=? AND storage_version=0 LIMIT 1', args: [stored.job.jobId] })).rows.length > 0
      const migratable = remaining && (await tx.execute({ sql: `SELECT 1 FROM command_job_output
        WHERE job_id=? AND storage_version=0 AND length(CAST(text AS BLOB))<=262144 LIMIT 1`, args: [stored.job.jobId] })).rows.length > 0
      await tx.execute({ sql: 'UPDATE command_jobs SET output_bytes=?,storage_version=? WHERE job_id=?',
        args: [position, Number(row.tail_migrated) !== 1 || migratable ? 0 : remaining ? 2 : 1, stored.job.jobId] })
      await tx.commit()
    } catch (error) { await tx.rollback().catch(() => undefined); throw error }
    finally { tx.close() }
  }

  private persist(live: LiveJob): Promise<void> {
    if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = undefined }
    if (live.persistRetryTimer) { clearTimeout(live.persistRetryTimer); live.persistRetryTimer = undefined }
    if (!live.pendingOutput.length && !live.pendingWrite && live.persistedVersion >= live.job.version) return live.flushing ?? Promise.resolve()
    // RAM keeps a finite tail; neither that tail nor complete output is rewritten
    // into SQLite. Snapshot identity remains metadata, with a version fence.
    live.pendingWrite = clone({ tenantId: live.tenantId, job: live.job, entries: [] })
    if (!live.flushing) {
      live.flushing = (async () => {
        while (live.pendingWrite || live.pendingOutput.length) {
          const snapshot = clone({ tenantId: live.tenantId, job: live.job, entries: [] })
          live.pendingWrite = undefined
          const output = live.pendingOutput.splice(0)
          if (output.length || snapshot.job.version > live.persistedVersion) {
            try {
              const tx = await this.writeTransaction(live.db)
              try {
                const row = (await tx.execute({ sql: 'SELECT output_bytes,version FROM command_jobs WHERE job_id=?', args: [live.job.jobId] })).rows[0]
                const committedSeq = Number((await tx.execute({ sql: 'SELECT MAX(seq) AS seq FROM command_job_output WHERE job_id=?', args: [live.job.jobId] })).rows[0]?.seq ?? 0)
                const pending = output.filter(entry => entry.seq > committedSeq)
                let position = Number(row?.output_bytes ?? 0)
                const chunks = pending.map(entry => Buffer.from(entry.text, 'utf8'))
                if (chunks.length) await (await getCommandOutputFiles(live.db, this.options.isolatedOutputRoot))
                  .append({ tenantId: live.tenantId, sessionId: live.job.sessionId, jobId: live.job.jobId }, position, chunks)
                const statements = pending.map((entry, index) => {
                  const offset = position, length = chunks[index].length; position += length
                  return { sql: `INSERT OR IGNORE INTO command_job_output(tenant_id,session_id,job_id,seq,stream,text,storage_version,byte_offset,byte_length)
                    VALUES(?,?,?,?,?,'',1,?,?)`, args: [live.tenantId, live.job.sessionId, live.job.jobId, entry.seq, entry.stream, offset, length] }
                })
                await tx.batch([...statements, this.saveStatement(snapshot, position)])
                await tx.commit()
                live.persistedVersion = Math.max(snapshot.job.version, Number(row?.version ?? 0))
              } catch (error) { await tx.rollback().catch(() => undefined); throw error }
              finally { tx.close() }
              if (output.length) live.pendingOutputBytes -= output.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0)
              if (live.outputPaused && live.pendingOutputBytes <= this.pendingOutputLimit / 2) {
                live.child?.stdout?.resume(); live.child?.stderr?.resume(); live.outputPaused = false
              }
            } catch (error) {
              live.pendingOutput.unshift(...output)
              const pendingWrite = live.pendingWrite as StoredJob | undefined
              if (!pendingWrite || pendingWrite.job.version < snapshot.job.version) live.pendingWrite = snapshot
              throw error
            }
          }
        }
        live.persistRetryDelayMs = undefined
        this.retrying.delete(live)
      })().finally(() => { live.flushing = undefined })
      live.writes = live.flushing
      live.flushing.catch(error => {
        live.persistError = error instanceof Error ? error : new Error(String(error))
        // Transient SQLite/network stalls must not permanently lose a command's
        // final state. Exponential backoff prevents a broken disk from creating
        // an unbounded retry loop while retaining only the bounded live tail.
        if (!this.stopping && !live.persistRetryTimer && (live.pendingWrite || live.pendingOutput.length)) {
          const delay = live.persistRetryDelayMs ?? 1_000
          live.persistRetryDelayMs = Math.min(delay * 2, 30_000)
          this.retrying.add(live)
          live.persistRetryTimer = setTimeout(() => {
            live.persistRetryTimer = undefined
            void this.persist(live).catch(() => undefined)
          }, delay)
          live.persistRetryTimer.unref()
        }
      })
    }
    return live.flushing
  }

  /** Node timers are 32-bit. Slice very long explicit deadlines so they never overflow. */
  private armTimeout(live: LiveJob, timeoutMs: number): void {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        void this.stop(live, 'timed_out', `Command timed out after ${timeoutMs}ms`).catch(() => undefined)
        return
      }
      live.timer = setTimeout(tick, Math.min(remaining, 2_000_000_000))
      live.timer.unref()
    }
    tick()
  }

  private append(live: LiveJob, stream: CommandOutputEntry['stream'], text: string): void {
    if (!text || live.closed) return
    // Split on Unicode code points, keeping each entry bounded and independently readable.
    let part = ''
    let size = 0
    const push = () => {
      if (!part) return
      live.entries.push({ seq: ++live.job.cursor, stream, text: part })
      live.pendingOutput.push({ seq: live.job.cursor, stream, text: part })
      live.pendingOutputBytes += size
      if (!live.outputPaused && live.pendingOutputBytes > this.pendingOutputLimit) {
        live.child?.stdout?.pause(); live.child?.stderr?.pause(); live.outputPaused = true
      }
      live.retainedBytes += size
      while ((live.retainedBytes > this.outputLimit || live.entries.length > 2048) && live.entries.length) {
        const removed = live.entries.shift()!
        live.retainedBytes -= Buffer.byteLength(removed.text)
        // The durable output table retains every chunk; this eviction only bounds memory.
      }
      part = ''; size = 0
    }
    for (const point of text) {
      const bytes = Buffer.byteLength(point)
      if (size + bytes > Math.min(this.pageLimit, 4096)) push()
      part += point; size += bytes
    }
    push()
    live.job.version++; live.job.updatedAt = Date.now()
    if (!live.flushTimer) {
      live.flushTimer = setTimeout(() => { void this.persist(live).catch(() => undefined) }, 100)
      live.flushTimer.unref()
    }
  }

  async start(input: CommandJobLaunch): Promise<CommandJobSnapshot> {
    // Ownership and launch data belong to this admission, not a caller's mutable object.
    input = { ...input, args: [...input.args], env: { ...input.env } }
    let release!: () => void
    const admission: Admission = { input, db: this.db, cancelled: false, done: new Promise<void>(done => { release = done }) }
    this.admissions.add(admission)
    try { return await this.startAdmitted(input, admission) }
    finally { this.admissions.delete(admission); release() }
  }

  private async startAdmitted(input: CommandJobLaunch, admission: Admission): Promise<CommandJobSnapshot> {
    await this.initialize()
    throwIfAborted(input.signal)
    if (this.db !== admission.db) throw new Error('Command datasource changed during admission')
    if (this.stopping || admission.cancelled) throw new Error('Command service or owner is stopping')
    if (this.active.size + this.starting >= this.concurrentLimit) throw Object.assign(new Error('Too many active command jobs'), { code: 'COMMAND_CAPACITY', statusCode: 429 })
    if (!input.tenantId || !input.sessionId || !input.ownerSessionId ||
      (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0))) throw new Error('Invalid command ownership or timeout')
    this.starting++
    const now = Date.now()
    const job: CommandJobSnapshot = {
      schemaVersion: 1, jobId: randomUUID(), sessionId: input.sessionId, ownerSessionId: input.ownerSessionId,
      runId: input.runId, ownerRunId: input.ownerRunId, turnId: input.turnId, toolCallId: input.toolCallId,
      version: 1, status: 'running', command: input.command, args: [...input.args], cwd: input.cwd,
      background: input.background, createdAt: now, updatedAt: now, exitCode: null, signal: null, cursor: 0, earliestCursor: 0,
    }
    let resolve!: (value: CommandJobSnapshot) => void
    const completion = new Promise<CommandJobSnapshot>(done => { resolve = done })
    const live: LiveJob = { db: admission.db, tenantId: input.tenantId, job, entries: [], outputStorageVersion: 1, retainedBytes: 0, completion, resolve, persistedVersion: 0,
      closed: false, cleanupSignal: () => {}, writes: Promise.resolve(), pendingOutput: [], pendingOutputBytes: 0, outputPaused: false }
    admission.live = live
    try {
      await this.persist(live)
      if (input.observeChanges) {
        try {
          live.changeObserver = await input.observeChanges(clone(job))
          job.changeTracking = clone(live.changeObserver.initial)
        } catch (error) {
          job.changeTracking = { status: 'unavailable', root: input.cwd,
            note: `未能建立命令文件快照：${error instanceof Error ? error.message : String(error)}；不能保证文件变化已纳入回滚。` }
        }
        job.version++; job.updatedAt = Date.now()
        await this.persist(live)
      }
      throwIfAborted(input.signal)
      if (this.stopping || admission.cancelled) throw new Error('Command service or owner is stopping')
      this.active.set(job.jobId, live)
      const windows = process.platform === 'win32'
      const plan = createCommandLaunchPlan(input.command, input.args, input.cwd, input.env)
      const child = spawn(plan.command, plan.args,
        { cwd: input.cwd, shell: false, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments,
          detached: !windows, env: input.env, stdio: ['ignore', 'pipe', 'pipe'] })
      live.child = child
      const stdout = new StringDecoder('utf8')
      const stderr = new StringDecoder('utf8')
      child.stdout!.on('data', (data: Buffer) => this.append(live, 'stdout', stdout.write(data)))
      child.stderr!.on('data', (data: Buffer) => this.append(live, 'stderr', stderr.write(data)))
      let spawnError: Error | undefined
      child.once('error', error => { spawnError = error })
      child.once('close', (code, signal) => {
        this.append(live, 'stdout', stdout.end()); this.append(live, 'stderr', stderr.end())
        live.closed = true
        void this.finish(live, code, signal, spawnError)
      })
      if (input.timeoutMs !== undefined) this.armTimeout(live, input.timeoutMs)
      const abort = () => {
        // Parking revokes model/tool dispatch while awaiting approval, but a
        // launched background job retains its own deadline and stop controls.
        // Explicit root/session cancellation still captures these jobs directly.
        if (input.background && input.signal?.reason instanceof ExecutionParkError) return
        void this.stop(live, 'cancelled', 'Command cancelled with its owner').catch(() => undefined)
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      live.cleanupSignal = () => input.signal?.removeEventListener('abort', abort)
      if (input.signal?.aborted) abort()
      const launched = await new Promise<boolean>(done => { child.once('spawn', () => { live.wasSpawned = true; done(true) }); child.once('error', () => done(false)) })
      return launched ? clone(job) : await completion
    } catch (error) {
      if (!live.child) {
        live.closed = true
        if (admission.cancelled || this.stopping || input.signal?.aborted) {
          live.stopReason = 'cancelled'
          live.job.error = { code: 'COMMAND_CANCELLED', message: 'Command owner stopped before process launch' }
        }
        await this.finish(live, null, null, error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    } finally { this.starting-- }
  }

  private async finish(live: LiveJob, code: number | null, signal: string | null, error?: Error): Promise<void> {
    if (live.timer) clearTimeout(live.timer)
    live.cleanupSignal()
    await live.termination
    // The child has emitted `close`; do not keep its stdio handles alive while
    // a terminal persistence retry waits for a database to recover.
    live.child = undefined
    const job = live.job
    if (live.changeObserver) {
      try {
        if (live.wasSpawned) {
          const observed = await live.changeObserver.finish()
          job.changes = observed.changes
          job.changeTracking = observed.tracking
        } else job.changeTracking = { ...live.changeObserver.initial, status: 'unavailable', recordedCount: 0,
          note: '进程未启动，未将等待期间的工作区变化归到此命令。' }
      } catch (error) {
        job.changeTracking = { ...live.changeObserver.initial, status: 'unavailable',
          note: `命令已退出，但文件变化记录失败：${error instanceof Error ? error.message : String(error)}。` }
      } finally { live.changeObserver.dispose(); live.changeObserver = undefined }
    }
    job.exitCode = code; job.signal = signal
    job.status = live.stopError ? 'failed' : live.stopReason ?? (error || code !== 0 ? 'failed' : 'succeeded')
    if (live.stopError) job.error = { code: 'COMMAND_TERMINATION_FAILED', message: live.stopError.message }
    else if (error && !live.stopReason) job.error = { code: 'COMMAND_SPAWN_FAILED', message: error.message }
    else if (!live.stopReason && code !== 0) job.error = { code: 'COMMAND_EXIT_FAILED', message: `Command exited with ${signal ? `signal ${signal}` : `code ${code}`}` }
    job.version++; job.updatedAt = job.finishedAt = Date.now()
    try { await this.persist(live) } catch (persistError) {
      job.error = { code: 'COMMAND_PERSIST_FAILED', message: `Command ended but its final state could not be saved: ${String(persistError)}` }
    }
    await this.prune(live.db).catch(() => undefined)
    this.active.delete(job.jobId)
    live.resolve(clone(job))
    for (const notify of live.completionWaiters ?? []) notify(clone(job))
    live.completionWaiters?.clear()
  }

  private async stop(live: LiveJob, status: 'cancelled' | 'timed_out', reason: string): Promise<CommandJobSnapshot> {
    if (commandJobIsTerminal(live.job.status) || live.closed) return live.completion
    if (!live.termination) {
      live.stopReason = status
      live.job.status = 'cancelling'; live.job.version++; live.job.updatedAt = Date.now()
      live.job.error = { code: status === 'timed_out' ? 'COMMAND_TIMEOUT' : 'COMMAND_CANCELLED', message: reason }
      void this.persist(live).catch(() => undefined)
      live.termination = (async () => {
        try { if (live.child) await stopCommandProcessTree(live.child, live.job.createdAt) }
        catch (error) {
          live.stopError = error instanceof Error ? error : new Error(String(error))
          live.job.error = { code: 'COMMAND_TERMINATION_FAILED', message: live.stopError.message }
          live.job.version++; live.job.updatedAt = Date.now()
          await this.persist(live).catch(() => undefined)
        }
      })()
    }
    await live.termination
    if (live.stopError && !live.closed) throw Object.assign(live.stopError, { statusCode: 500, code: 'COMMAND_TERMINATION_FAILED' })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([live.completion, new Promise<CommandJobSnapshot>((_resolve, reject) => {
        deadline = setTimeout(() => {
          const error = Object.assign(new Error('Command termination was requested but process exit was not confirmed'), { code: 'COMMAND_TERMINATION_FAILED', statusCode: 500 })
          live.job.error = { code: error.code, message: error.message }
          live.job.version++; live.job.updatedAt = Date.now()
          void this.persist(live).catch(() => undefined)
          reject(error)
        }, 5_000)
      })])
    } finally { if (deadline) clearTimeout(deadline) }
  }

  private async lookup(scope: CommandJobScope, jobId: string, includeEntries = false): Promise<StoredJob | null> {
    await this.initialize()
    const live = this.active.get(jobId)
    if (live) return scopeMatches(live, scope) ? live : null
    const result = await this.db.execute({ sql: `SELECT tenant_id,snapshot,storage_version${includeEntries ? ',entries' : ''} FROM command_jobs WHERE tenant_id=? AND session_id=? AND job_id=?`,
      args: [scope.tenantId, scope.sessionId, jobId] })
    if (!result.rows[0]) return null
    const row = result.rows[0]
    const stored = { tenantId: String(row.tenant_id), job: JSON.parse(String(row.snapshot)) as CommandJobSnapshot,
      entries: includeEntries ? JSON.parse(String(row.entries)) as CommandOutputEntry[] : [], outputStorageVersion: Number(row.storage_version) }
    return scopeMatches(stored, scope) ? stored : null
  }

  async get(scope: CommandJobScope, jobId: string): Promise<CommandJobSnapshot | null> {
    const stored = await this.lookup(scope, jobId, false)
    return stored ? clone(stored.job) : null
  }

  async list(scope: CommandJobScope): Promise<CommandJobSnapshot[]> {
    await this.initialize()
    const result = await this.db.execute({ sql: 'SELECT tenant_id,snapshot FROM command_jobs WHERE tenant_id=? AND session_id=?', args: [scope.tenantId, scope.sessionId] })
    return result.rows.map(row => this.active.get(JSON.parse(String(row.snapshot)).jobId) ?? {
      tenantId: String(row.tenant_id), job: JSON.parse(String(row.snapshot)) as CommandJobSnapshot, entries: [],
    }).filter(stored => scopeMatches(stored, scope)).map(stored => clone(stored.job)).sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId))
  }

  /**
   * Return active jobs for a tenant without widening the public session-scoped
   * command output API.  Source-change protection uses this narrow projection
   * to identify another execution that may still be writing the same
   * workspace; command arguments and output are deliberately omitted by the
   * caller before persisting a wait receipt.
   */
  async listActiveForTenant(tenantId: string): Promise<CommandJobSnapshot[]> {
    await this.initialize()
    const result = await this.db.execute({
      // Source protection must see every active writer. Truncating this list
      // could omit an overlapping command and create a false negative.
      sql: "SELECT tenant_id,session_id,job_id,snapshot FROM command_jobs WHERE tenant_id=? AND status IN ('running','cancelling') ORDER BY json_extract(snapshot,'$.createdAt') DESC,job_id DESC",
      args: [tenantId],
    })
    return result.rows.map(row => {
      const parsed = JSON.parse(String(row.snapshot)) as CommandJobSnapshot
      const live = this.active.get(parsed.jobId)
      return live ? clone(live.job) : parsed
    }).filter(job => job.status === 'running' || job.status === 'cancelling')
      .sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId))
  }

  async output(scope: CommandJobScope, jobId: string, options: CommandOutputOptions = {}): Promise<CommandJobOutput | null> {
    let stored = await this.lookup(scope, jobId, false)
    if (!stored) return null
    // Flush a live job before reading so the API has one durable, gap-free cursor.
    const live = this.active.get(jobId)
    if (live) {
      if (live.pendingOutput.length || live.pendingWrite || live.persistedVersion < live.job.version) await this.persist(live)
      stored = await this.lookup(scope, jobId, false)
      if (!stored) return null
    }
    await this.migrateLegacyOutput(stored)
    stored = { ...stored, job: clone(stored.job), entries: [] }
    if (options.tail !== undefined && typeof options.tail !== 'boolean') throw badRequest('tail must be boolean')
    if (options.tail && (options.cursor !== undefined || options.cursorOffset !== undefined)) throw badRequest('tail cannot be combined with cursor or cursorOffset')
    let cursor = options.cursor ?? 0
    let cursorOffset = options.cursorOffset ?? 0
    const maxBytes = options.maxBytes ?? this.pageLimit
    const maxChars = options.maxChars ?? this.pageLimit
    const maxEntries = options.maxEntries ?? 1024
    const partial = options.tail === true || options.maxChars !== undefined || options.cursorOffset !== undefined
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stored.job.cursor) throw badRequest('Output cursor is invalid or ahead of this job')
    if (!Number.isSafeInteger(cursorOffset) || cursorOffset < 0) throw badRequest('cursorOffset must be a nonnegative integer')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > this.pageLimit) throw badRequest(`maxBytes must be between 4 and ${this.pageLimit}`)
    if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw badRequest('maxChars must be an integer of at least 2')
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024) throw badRequest('maxEntries must be between 1 and 1024')

    const firstResult = await this.db.execute({ sql: 'SELECT MIN(seq) AS first_seq FROM command_job_output WHERE tenant_id=? AND session_id=? AND job_id=?',
      args: [stored.tenantId, stored.job.sessionId, stored.job.jobId] })
    const firstValue = firstResult.rows[0]?.first_seq
    const earliestCursor = firstValue === null || firstValue === undefined ? 0 : Math.max(0, Number(firstValue) - 1)
    if (options.tail) {
      const recent = (await this.db.execute({ sql: `SELECT seq,storage_version,byte_offset,
        CASE WHEN storage_version=1 THEN byte_length ELSE length(CAST(text AS BLOB)) END AS bytes FROM command_job_output
        WHERE tenant_id=? AND session_id=? AND job_id=? AND seq<=? ORDER BY seq DESC LIMIT ?`,
        args: [stored.tenantId, stored.job.sessionId, jobId, stored.job.cursor, maxEntries] })).rows
      let total = 0
      cursor = stored.job.cursor
      for (const row of recent) {
        const size = Number(row.bytes), available = maxBytes - total
        if (available <= 0) break
        cursor = Number(row.seq) - 1
        cursorOffset = Math.max(0, size - available)
        if (cursorOffset) {
          const boundary = Number(row.storage_version) === 1
            ? await (await getCommandOutputFiles(this.db, this.options.isolatedOutputRoot)).read(
              { tenantId: stored.tenantId, sessionId: stored.job.sessionId, jobId }, Number(row.byte_offset) + cursorOffset, Math.min(4, size - cursorOffset))
            : Buffer.from(new Uint8Array((await this.db.execute({ sql: 'SELECT substr(CAST(text AS BLOB),?,4) AS boundary FROM command_job_output WHERE job_id=? AND seq=?',
              args: [cursorOffset + 1, jobId, row.seq] })).rows[0].boundary as ArrayBuffer))
          let skip = 0
          while (skip < boundary.length && (boundary[skip] & 0xc0) === 0x80) skip++
          cursorOffset += skip
          // If the available bytes contain only the end of a code point, start
          // with the following complete entry instead of emitting replacement text.
          if (cursorOffset >= size) { cursor = Number(row.seq); cursorOffset = 0 }
          break
        }
        total += size
      }
    }
    if (cursorOffset && cursor < earliestCursor) throw badRequest('The partially consumed output entry is no longer retained; restart at earliestCursor with cursorOffset=0')
    let bytes = 0, chars = 0, nextCursor = Math.max(cursor, earliestCursor), nextOffset = cursorOffset
    const entries: CommandOutputEntry[] = []
    let reader: CommandOutputReader | undefined
    let rows: Row[] = []
    try {
    while (entries.length < maxEntries && bytes < maxBytes && (!partial || chars < maxChars)) {
      // Project only the remaining page allowance, even for an oversized legacy
      // entry. Never materialize 1024 complete chunks to return a small model page.
      const readBytes = partial ? Math.min((maxChars - chars) * 4, maxBytes - bytes) : maxBytes - bytes
      if (!rows.length) rows = (await this.db.execute({ sql: `SELECT seq,stream,storage_version,byte_offset,
        CASE WHEN storage_version=1 THEN byte_length ELSE length(CAST(text AS BLOB)) END AS bytes FROM command_job_output
        WHERE tenant_id=? AND session_id=? AND job_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`,
        args: [stored.tenantId, stored.job.sessionId, stored.job.jobId, nextCursor, stored.job.cursor, Math.min(32, maxEntries - entries.length)] })).rows
      const row = rows.shift()
      if (!row) {
        if (nextOffset) throw badRequest('cursorOffset has no corresponding output entry')
        break
      }
      const entryBytes = Number(row.bytes)
      if (nextOffset >= entryBytes && nextOffset > 0) throw badRequest('cursorOffset must be inside the next output entry')
      if (!partial && bytes + Number(row.bytes) > maxBytes) {
        if (!entries.length) throw badRequest('maxBytes is smaller than the next complete output entry')
        break
      }
      let buffer: Buffer
      if (Number(row.storage_version) === 1) {
        reader ??= await (await getCommandOutputFiles(this.db, this.options.isolatedOutputRoot))
          .openReader({ tenantId: stored.tenantId, sessionId: stored.job.sessionId, jobId })
        buffer = await reader.read(Number(row.byte_offset) + nextOffset, Math.min(readBytes, Math.max(0, entryBytes - nextOffset)))
      } else {
        const body = (await this.db.execute({ sql: `SELECT substr(CAST(text AS BLOB),?,?) AS text FROM command_job_output
          WHERE tenant_id=? AND session_id=? AND job_id=? AND seq=?`,
          args: [nextOffset + 1, readBytes, stored.tenantId, stored.job.sessionId, jobId, row.seq] })).rows[0]
        if (!body) throw badRequest('Command output changed while reading; retry the same cursor')
        buffer = Buffer.from(new Uint8Array(body.text as ArrayBuffer))
      }
      if (nextOffset && buffer.length && (buffer[0] & 0xc0) === 0x80) throw badRequest('cursorOffset must be at a UTF-8 character boundary')
      // SQLite TEXT length/substr stop at NUL. Blob slicing preserves it, and
      // StringDecoder withholds an incomplete trailing UTF-8 code point.
      let text = new StringDecoder('utf8').write(buffer), size = 0, length = 0
      if (partial) {
        for (const point of text) {
          const pointBytes = Buffer.byteLength(point)
          if (bytes + size + pointBytes > maxBytes || chars + length + point.length > maxChars) break
          size += pointBytes; length += point.length
        }
        text = text.slice(0, length)
        if (!size && entryBytes > nextOffset) break
      } else { size = entryBytes; length = text.length }
      const seq = Number(row.seq)
      entries.push({ seq, stream: String(row.stream) as CommandOutputEntry['stream'], text })
      bytes += size; chars += length
      if (nextOffset + size < entryBytes) { nextOffset += size; break }
      nextCursor = seq; nextOffset = 0
    }
    } finally { await reader?.close() }
    const more = nextCursor < stored.job.cursor
      ? await this.db.execute({ sql: 'SELECT 1 AS more FROM command_job_output WHERE tenant_id=? AND session_id=? AND job_id=? AND seq>? AND seq<=? LIMIT 1',
        args: [stored.tenantId, stored.job.sessionId, stored.job.jobId, nextCursor, stored.job.cursor] })
      : { rows: [] }
    if (cursorOffset && !entries.length) throw badRequest('cursorOffset has no corresponding output entry')
    const legacyMore = stored.outputStorageVersion === 0 && nextCursor < stored.job.cursor
      ? Number((await this.db.execute({ sql: 'SELECT tail_migrated FROM command_jobs WHERE job_id=?', args: [jobId] })).rows[0]?.tail_migrated) === 0 : false
    return clone({ job: stored.job, entries, nextCursor, ...(partial ? { nextOffset } : {}), earliestCursor,
      truncated: !options.tail && cursor < earliestCursor, hasMore: more.rows.length > 0 || legacyMore, ...(options.tail ? { tail: true as const } : {}) })
  }

  /** Unlike racing wait(), an aborted waiter leaves no callback attached to a long-running job. */
  async waitForCompletion(scope: CommandJobScope, jobId: string, signal?: AbortSignal): Promise<CommandJobSnapshot | null> {
    throwIfAborted(signal)
    const stored = await this.lookup(scope, jobId, false)
    throwIfAborted(signal)
    if (!stored) return null
    const live = this.active.get(jobId)
    if (!live) return clone(stored.job)
    return new Promise((resolve, reject) => {
      const cleanup = () => { live.completionWaiters?.delete(done); signal?.removeEventListener('abort', abort) }
      const done = (job: CommandJobSnapshot) => { cleanup(); resolve(job) }
      const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException('Operation cancelled', 'AbortError')) }
      ;(live.completionWaiters ??= new Set()).add(done)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  async wait(scope: CommandJobScope, jobId: string): Promise<CommandJobSnapshot | null> {
    const stored = await this.lookup(scope, jobId)
    if (!stored) return null
    const live = this.active.get(jobId)
    return live ? live.completion : clone(stored.job)
  }

  async restart(scope: CommandJobScope, jobId: string, launch: Pick<CommandJobLaunch, 'cwd' | 'env'>): Promise<CommandJobSnapshot | null> {
    const stored = await this.lookup(scope, jobId)
    if (!stored) return null
    if (!stored.job.background || !commandJobIsTerminal(stored.job.status)) {
      throw Object.assign(new Error('Only a terminal background command job can be restarted'), { statusCode: 409, code: 'COMMAND_JOB_NOT_TERMINAL' })
    }
    // A restart is a new top-level user action, never a continuation of the old run/tool ownership.
    return this.start({ tenantId: scope.tenantId, sessionId: scope.sessionId, ownerSessionId: scope.sessionId,
      command: stored.job.command, args: [...stored.job.args], cwd: launch.cwd, background: stored.job.background, env: { ...launch.env } })
  }

  async delete(scope: CommandJobScope, jobId: string): Promise<boolean> {
    const stored = await this.lookup(scope, jobId)
    if (!stored) return false
    if (!stored.job.background || !commandJobIsTerminal(stored.job.status)) {
      throw Object.assign(new Error('Only a terminal background command job can be deleted'), { statusCode: 409, code: 'COMMAND_JOB_NOT_TERMINAL' })
    }
    await this.writeBatch(this.db, [
      { sql: 'INSERT OR IGNORE INTO command_output_gc(tenant_id,session_id,job_id) VALUES(?,?,?)', args: [scope.tenantId, scope.sessionId, jobId] },
      { sql: 'DELETE FROM command_job_output WHERE tenant_id=? AND session_id=? AND job_id=?', args: [scope.tenantId, scope.sessionId, jobId] },
      { sql: "DELETE FROM command_jobs WHERE tenant_id=? AND session_id=? AND job_id=? AND status NOT IN ('running','cancelling')", args: [scope.tenantId, scope.sessionId, jobId] },
    ])
    await this.collectOutputFiles(this.db, jobId)
    return true
  }

  async cancel(scope: CommandJobScope, jobId: string, reason = 'Stopped by user'): Promise<CommandJobSnapshot | null> {
    const stored = await this.lookup(scope, jobId)
    if (!stored) return null
    const live = this.active.get(jobId)
    return live ? this.stop(live, 'cancelled', reason) : clone(stored.job)
  }

  captureScope(scope: CommandJobScope): CommandScopeCapture {
    const db = this.db
    const admissions = [...this.admissions].filter(admission => admission.db === db &&
      admission.input.tenantId === scope.tenantId && admission.input.sessionId === scope.sessionId &&
      (scope.runId === undefined || admission.input.runId === scope.runId) &&
      (scope.ownerSessionId === undefined || admission.input.ownerSessionId === scope.ownerSessionId) &&
      (scope.ownerRunId === undefined || admission.input.ownerRunId === scope.ownerRunId))
    const jobs = [...this.active.values()].filter(job => job.db === db && scopeMatches(job, scope))
    const capture = Object.freeze({}) as CommandScopeCapture
    this.capturedScopes.set(capture, { db, admissions, jobs })
    return capture
  }

  private captured(capture: CommandScopeCapture): CapturedScope {
    const owned = this.capturedScopes.get(capture)
    if (!owned || owned.db !== this.db || owned.db.closed) throw new Error('A live same-manager command scope capture is required')
    return owned
  }

  hasCapturedWork(capture: CommandScopeCapture): boolean {
    const owned = this.captured(capture)
    return owned.admissions.length > 0 || owned.jobs.length > 0
  }

  cancelCaptured(capture: CommandScopeCapture, reason = 'Owner stopped'): Promise<CommandJobSnapshot[]> {
    const owned = this.captured(capture)
    if (!owned.cancellation) {
      // Revoke these admissions and handles before any await. Joining the old
      // set must never perform another broad lookup after a later manual start.
      for (const admission of owned.admissions) admission.cancelled = true
      const stops = owned.jobs.map(job => this.stop(job, 'cancelled', reason))
      owned.cancellation = (async () => {
        const results = await Promise.allSettled([...stops, ...owned.admissions.map(admission => admission.done)])
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'COMMAND_CLEANUP_UNKNOWN')
        return results.slice(0, stops.length).map(result => (result as PromiseFulfilledResult<CommandJobSnapshot>).value)
      })()
      void owned.cancellation.catch(() => undefined)
    }
    return owned.cancellation
  }

  cancelScope(scope: CommandJobScope, reason = 'Owner stopped'): Promise<CommandJobSnapshot[]> {
    return this.cancelCaptured(this.captureScope(scope), reason)
  }

  shutdown(reason = 'Engine shutting down'): Promise<void> {
    const db = this.db, previous = this.shutdowns.get(db)
    if (previous) return previous
    this.stopping = true
    // The service close owns these exact handles. A failed stop must not let
    // another child's close/persistence ACK outlive the database close gate.
    const admissions = [...this.admissions], jobs = [...this.active.values()], retries = [...this.retrying]
    for (const admission of admissions) admission.cancelled = true
    // Stop future retries synchronously; an already dispatched retry still
    // owns a real write promise which must finish before the datasource closes.
    for (const live of retries) {
      if (live.persistRetryTimer) clearTimeout(live.persistRetryTimer)
      live.persistRetryTimer = undefined
    }
    const retryWrites = retries.flatMap(live => live.flushing ? [live.flushing] : [])
    const stops = jobs.map(job => this.stop(job, 'cancelled', reason))
    const closing = (async () => {
      const results = await Promise.allSettled([...stops, ...admissions.map(admission => admission.done), ...retryWrites])
      const owned = new Set([...jobs, ...retries, ...admissions.flatMap(admission => admission.live ? [admission.live] : [])])
      const failures: unknown[] = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
      for (const live of owned) {
        if (live.persistRetryTimer) clearTimeout(live.persistRetryTimer)
        live.persistRetryTimer = undefined
        this.retrying.delete(live)
        if (live.job.error?.code === 'COMMAND_PERSIST_FAILED') failures.push(new Error(live.job.error.message))
      }
      if (failures.length) throw new AggregateError(failures, 'COMMAND_CLEANUP_UNKNOWN')
    })()
    this.shutdowns.set(db, closing)
    void closing.catch(() => undefined)
    return closing
  }
}

export const commandJobs = new CommandJobManager()
