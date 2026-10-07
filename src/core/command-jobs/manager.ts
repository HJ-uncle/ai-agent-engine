import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Client } from '@libsql/client'
import { getDb } from '../../storage/sqlite/db.js'
import { throwIfAborted } from '../utils/abort.js'
import { stopCommandProcessTree } from './process-tree.js'
import { COMMAND_OUTPUT_BYTES, COMMAND_PAGE_BYTES, commandJobIsTerminal,
  type CommandJobLaunch, type CommandJobOutput, type CommandJobScope, type CommandJobSnapshot, type CommandOutputEntry } from './types.js'

const WIN_BUILTINS = new Set(['dir', 'type', 'copy', 'move', 'del', 'rd', 'md', 'mkdir', 'rmdir', 'ren', 'rename',
  'cls', 'echo', 'set', 'cd', 'pushd', 'popd', 'title', 'ver', 'vol', 'path', 'assoc', 'ftype', 'mklink'])
const schemas = new WeakMap<Client, Promise<void>>()

interface StoredJob { tenantId: string; job: CommandJobSnapshot; entries: CommandOutputEntry[] }
interface LiveJob extends StoredJob {
  db: Client
  child?: ChildProcess
  retainedBytes: number
  completion: Promise<CommandJobSnapshot>
  resolve: (job: CommandJobSnapshot) => void
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
}

export interface CommandJobManagerOptions {
  db?: Client
  maxOutputBytes?: number
  maxPageBytes?: number
  maxConcurrentJobs?: number
  maxRetainedJobs?: number
  maxSessionJobs?: number
  retentionMs?: number
}

interface Admission { input: CommandJobLaunch; cancelled: boolean; done: Promise<void> }

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

  async initialize(): Promise<void> {
    const db = this.db
    if (this.currentDb !== db) { if (this.currentDb) this.stopping = false; this.currentDb = db }
    let initialized = schemas.get(db)
    if (!initialized) {
      initialized = (async () => {
        await db.execute(`CREATE TABLE IF NOT EXISTS command_jobs (
          tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, job_id TEXT PRIMARY KEY,
          status TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, entries TEXT NOT NULL)`)
        await db.execute('CREATE INDEX IF NOT EXISTS command_jobs_session ON command_jobs(tenant_id,session_id)')
        await db.execute(`CREATE TABLE IF NOT EXISTS command_job_output (
          tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, job_id TEXT NOT NULL,
          seq INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL,
          PRIMARY KEY (job_id, seq))`)
        await db.execute('CREATE INDEX IF NOT EXISTS command_job_output_lookup ON command_job_output(tenant_id,session_id,job_id,seq)')
        // Older databases kept only a bounded JSON tail. Seed that tail once so upgrades do not erase it.
        const legacy = await db.execute('SELECT tenant_id,session_id,job_id,entries FROM command_jobs')
        for (const row of legacy.rows) {
          const entries = JSON.parse(String(row.entries)) as CommandOutputEntry[]
          if (entries.length) await db.batch(entries.map(entry => ({
            sql: 'INSERT OR IGNORE INTO command_job_output(tenant_id,session_id,job_id,seq,stream,text) VALUES(?,?,?,?,?,?)',
            args: [String(row.tenant_id), String(row.session_id), String(row.job_id), entry.seq, entry.stream, entry.text],
          })), 'write')
        }
        const previous = await db.execute("SELECT tenant_id,snapshot,entries FROM command_jobs WHERE status IN ('running','cancelling')")
        for (const row of previous.rows) {
          const job = JSON.parse(String(row.snapshot)) as CommandJobSnapshot
          job.status = 'interrupted'; job.version++; job.updatedAt = job.finishedAt = Date.now()
          job.exitCode = null; job.signal = null
          job.error = { code: 'ENGINE_RESTARTED', message: 'Engine restarted. This command was not reattached or rerun; its former process state is unknown.' }
          await this.save({ tenantId: String(row.tenant_id), job, entries: JSON.parse(String(row.entries)) }, db)
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
    const rows = await db.execute("SELECT job_id,tenant_id,session_id,snapshot FROM command_jobs WHERE status NOT IN ('running','cancelling') ORDER BY json_extract(snapshot,'$.updatedAt') DESC,job_id DESC")
    const sessions = new Map<string, number>()
    const remove: string[] = []
    let kept = 0
    for (const row of rows.rows) {
      const job = JSON.parse(String(row.snapshot)) as CommandJobSnapshot
      const key = JSON.stringify([row.tenant_id, row.session_id])
      const count = sessions.get(key) ?? 0
      if (job.updatedAt < oldest || kept >= limit || count >= sessionLimit) remove.push(String(row.job_id))
      else { kept++; sessions.set(key, count + 1) }
    }
    if (remove.length) await db.batch(remove.flatMap(jobId => [
      { sql: 'DELETE FROM command_job_output WHERE job_id=?', args: [jobId] },
      { sql: 'DELETE FROM command_jobs WHERE job_id=? AND status NOT IN (\'running\',\'cancelling\')', args: [jobId] },
    ]), 'write')
  }

  private saveStatement(stored: StoredJob) {
    return {
      sql: `INSERT INTO command_jobs(tenant_id,session_id,job_id,status,version,snapshot,entries) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,version=excluded.version,snapshot=excluded.snapshot,entries=excluded.entries
        WHERE excluded.version >= command_jobs.version`,
      args: [stored.tenantId, stored.job.sessionId, stored.job.jobId, stored.job.status, stored.job.version,
        JSON.stringify(stored.job), JSON.stringify(stored.entries)],
    }
  }

  private async save(stored: StoredJob, db = this.db): Promise<void> {
    await db.execute(this.saveStatement(stored))
  }

  private persist(live: LiveJob): Promise<void> {
    if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = undefined }
    if (live.persistRetryTimer) { clearTimeout(live.persistRetryTimer); live.persistRetryTimer = undefined }
    // Serialize immutable versions so a delayed running write cannot overwrite close.
    live.pendingWrite = clone({ tenantId: live.tenantId, job: live.job, entries: live.entries })
    if (!live.flushing) {
      live.flushing = (async () => {
        while (live.pendingWrite || live.pendingOutput.length) {
          const snapshot = live.pendingWrite
          live.pendingWrite = undefined
          const output = live.pendingOutput.splice(0)
          // Commit output and the matching cursor atomically so a crash cannot create a
          // snapshot that claims output was durable when its rows were not.
          if (output.length || snapshot) {
            try {
              await live.db.batch([
                ...output.map(entry => ({
                  sql: 'INSERT OR IGNORE INTO command_job_output(tenant_id,session_id,job_id,seq,stream,text) VALUES(?,?,?,?,?,?)',
                  args: [live.tenantId, live.job.sessionId, live.job.jobId, entry.seq, entry.stream, entry.text],
                })),
                ...(snapshot ? [this.saveStatement(snapshot)] : []),
              ], 'write')
              if (output.length) live.pendingOutputBytes -= output.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0)
              if (live.outputPaused && live.pendingOutputBytes <= this.pendingOutputLimit / 2) {
                live.child?.stdout?.resume(); live.child?.stderr?.resume(); live.outputPaused = false
              }
            } catch (error) {
              live.pendingOutput.unshift(...output)
              if (snapshot) live.pendingWrite = snapshot
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
    let release!: () => void
    const admission: Admission = { input, cancelled: false, done: new Promise<void>(done => { release = done }) }
    this.admissions.add(admission)
    try { return await this.startAdmitted(input, admission) }
    finally { this.admissions.delete(admission); release() }
  }

  private async startAdmitted(input: CommandJobLaunch, admission: Admission): Promise<CommandJobSnapshot> {
    await this.initialize()
    throwIfAborted(input.signal)
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
    const live: LiveJob = { db: this.db, tenantId: input.tenantId, job, entries: [], retainedBytes: 0, completion, resolve,
      closed: false, cleanupSignal: () => {}, writes: Promise.resolve(), pendingOutput: [], pendingOutputBytes: 0, outputPaused: false }
    try {
      await this.persist(live)
      throwIfAborted(input.signal)
      if (this.stopping || admission.cancelled) throw new Error('Command service or owner is stopping')
      this.active.set(job.jobId, live)
      const windows = process.platform === 'win32'
      const useCmd = windows && (WIN_BUILTINS.has(input.command.toLowerCase()) || /\.(cmd|bat)$/i.test(input.command))
      const child = spawn(useCmd ? 'cmd.exe' : input.command, useCmd ? ['/c', input.command, ...input.args] : input.args,
        { cwd: input.cwd, shell: false, windowsHide: true, detached: !windows, env: input.env, stdio: ['ignore', 'pipe', 'pipe'] })
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
      const abort = () => { void this.stop(live, 'cancelled', 'Command cancelled with its owner').catch(() => undefined) }
      input.signal?.addEventListener('abort', abort, { once: true })
      live.cleanupSignal = () => input.signal?.removeEventListener('abort', abort)
      if (input.signal?.aborted) abort()
      const launched = await new Promise<boolean>(done => { child.once('spawn', () => done(true)); child.once('error', () => done(false)) })
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

  private async lookup(scope: CommandJobScope, jobId: string): Promise<StoredJob | null> {
    await this.initialize()
    const live = this.active.get(jobId)
    if (live) return scopeMatches(live, scope) ? live : null
    const result = await this.db.execute({ sql: 'SELECT tenant_id,snapshot,entries FROM command_jobs WHERE tenant_id=? AND session_id=? AND job_id=?',
      args: [scope.tenantId, scope.sessionId, jobId] })
    if (!result.rows[0]) return null
    const row = result.rows[0]
    const stored = { tenantId: String(row.tenant_id), job: JSON.parse(String(row.snapshot)) as CommandJobSnapshot,
      entries: JSON.parse(String(row.entries)) as CommandOutputEntry[] }
    return scopeMatches(stored, scope) ? stored : null
  }

  async get(scope: CommandJobScope, jobId: string): Promise<CommandJobSnapshot | null> {
    const stored = await this.lookup(scope, jobId)
    return stored ? clone(stored.job) : null
  }

  async list(scope: CommandJobScope): Promise<CommandJobSnapshot[]> {
    await this.initialize()
    const result = await this.db.execute({ sql: 'SELECT tenant_id,snapshot FROM command_jobs WHERE tenant_id=? AND session_id=?', args: [scope.tenantId, scope.sessionId] })
    return result.rows.map(row => this.active.get(JSON.parse(String(row.snapshot)).jobId) ?? {
      tenantId: String(row.tenant_id), job: JSON.parse(String(row.snapshot)) as CommandJobSnapshot, entries: [],
    }).filter(stored => scopeMatches(stored, scope)).map(stored => clone(stored.job)).sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId))
  }

  async output(scope: CommandJobScope, jobId: string, options: { cursor?: number; maxBytes?: number } = {}): Promise<CommandJobOutput | null> {
    let stored = await this.lookup(scope, jobId)
    if (!stored) return null
    // Flush a live job before reading so the API has one durable, gap-free cursor.
    const live = this.active.get(jobId)
    if (live) {
      await this.persist(live)
      stored = await this.lookup(scope, jobId)
      if (!stored) return null
    }
    const cursor = options.cursor ?? 0
    const maxBytes = options.maxBytes ?? this.pageLimit
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stored.job.cursor) throw badRequest('Output cursor is invalid or ahead of this job')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > this.pageLimit) throw badRequest(`maxBytes must be between 4 and ${this.pageLimit}`)

    const firstResult = await this.db.execute({ sql: 'SELECT MIN(seq) AS first_seq FROM command_job_output WHERE tenant_id=? AND session_id=? AND job_id=?',
      args: [stored.tenantId, stored.job.sessionId, stored.job.jobId] })
    const firstValue = firstResult.rows[0]?.first_seq
    const earliestCursor = firstValue === null || firstValue === undefined ? 0 : Math.max(0, Number(firstValue) - 1)
    let bytes = 0
    const entries: CommandOutputEntry[] = []
    const result = await this.db.execute({ sql: `SELECT seq,stream,text FROM command_job_output
      WHERE tenant_id=? AND session_id=? AND job_id=? AND seq>? ORDER BY seq LIMIT 1024`,
      args: [stored.tenantId, stored.job.sessionId, stored.job.jobId, cursor] })
    // A legacy row may predate the output table; use its snapshot tail as a safe fallback.
    const source = result.rows.length
      ? result.rows.map(row => ({ seq: Number(row.seq), stream: String(row.stream) as CommandOutputEntry['stream'], text: String(row.text) }))
      : stored.entries.filter(entry => entry.seq > cursor)
    for (const entry of source) {
      const size = Buffer.byteLength(entry.text)
      if (bytes + size > maxBytes) {
        if (!entries.length) throw badRequest('maxBytes is smaller than the next complete output entry')
        break
      }
      entries.push(entry); bytes += size
    }
    const nextCursor = entries.at(-1)?.seq ?? cursor
    const more = nextCursor < stored.job.cursor
      ? await this.db.execute({ sql: 'SELECT 1 AS more FROM command_job_output WHERE tenant_id=? AND session_id=? AND job_id=? AND seq>? LIMIT 1',
        args: [stored.tenantId, stored.job.sessionId, stored.job.jobId, nextCursor] })
      : { rows: [] }
    return clone({ job: stored.job, entries, nextCursor, earliestCursor,
      truncated: cursor < earliestCursor, hasMore: more.rows.length > 0 })
  }

  async wait(scope: CommandJobScope, jobId: string): Promise<CommandJobSnapshot | null> {
    const stored = await this.lookup(scope, jobId)
    if (!stored) return null
    const live = this.active.get(jobId)
    return live ? live.completion : clone(stored.job)
  }

  async cancel(scope: CommandJobScope, jobId: string, reason = 'Stopped by user'): Promise<CommandJobSnapshot | null> {
    const stored = await this.lookup(scope, jobId)
    if (!stored) return null
    const live = this.active.get(jobId)
    return live ? this.stop(live, 'cancelled', reason) : clone(stored.job)
  }

  async cancelScope(scope: CommandJobScope, reason = 'Owner stopped'): Promise<CommandJobSnapshot[]> {
    await this.initialize()
    const admissions = [...this.admissions].filter(admission => scopeMatches({ tenantId: admission.input.tenantId,
      job: admission.input as unknown as CommandJobSnapshot, entries: [] }, scope))
    for (const admission of admissions) admission.cancelled = true
    await Promise.all(admissions.map(admission => admission.done))
    const jobs = [...this.active.values()].filter(job => job.db === this.db && scopeMatches(job, scope))
    return Promise.all(jobs.map(job => this.stop(job, 'cancelled', reason)))
  }

  async shutdown(reason = 'Engine shutting down'): Promise<void> {
    this.stopping = true
    for (const admission of this.admissions) admission.cancelled = true
    await Promise.all([...this.admissions].map(admission => admission.done))
    await Promise.all([...this.active.values()].map(job => this.stop(job, 'cancelled', reason)))
    for (const live of this.retrying) {
      if (live.persistRetryTimer) clearTimeout(live.persistRetryTimer)
      live.persistRetryTimer = undefined
    }
    this.retrying.clear()
  }
}

export const commandJobs = new CommandJobManager()
