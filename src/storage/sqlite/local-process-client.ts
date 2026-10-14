import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { Client, Config, InArgs, InStatement, Replicated, ResultSet, Row, Transaction, TransactionMode, Value } from '@libsql/client'
import { LOCAL_SQLITE_PROCESS } from './local-process-runtime.js'

interface WireResult {
  columns: string[]; columnTypes: string[]; rows: Value[][]; rowsAffected: number; lastInsertRowid: bigint | undefined
}
interface WireError { name: string; message: string; code?: string; extendedCode?: string; rawCode?: number; statementIndex?: number }
interface Reply { id?: number; value?: unknown; error?: WireError; fatal?: WireError; txClosed?: boolean;
  closeControl?: { token?: string; nativeClosed: boolean; errors: string[] } }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; tx?: ProcessTransaction }

function failure(message: string, code: string): Error { return Object.assign(new Error(message), { code }) }
function fromError(error: WireError): Error { return Object.assign(new Error(error.message), error) }
function resultSet(value: WireResult): ResultSet {
  const rows = value.rows.map(values => {
    const row = {} as Row
    Object.defineProperty(row, 'length', { value: values.length })
    values.forEach((item, index) => {
      Object.defineProperty(row, index, { value: item })
      const name = value.columns[index]
      if (!Object.hasOwn(row, name)) Object.defineProperty(row, name, { value: item, enumerable: true, configurable: true, writable: true })
    })
    return row
  })
  return {
    ...value, rows,
    toJSON() {
      return { columns: value.columns, columnTypes: value.columnTypes, rows: value.rows.map(row => row.map(item =>
        typeof item === 'bigint' ? String(item) : item instanceof ArrayBuffer ? Buffer.from(item).toString('base64') : item)),
      rowsAffected: value.rowsAffected, lastInsertRowid: value.lastInsertRowid === undefined ? null : String(value.lastInsertRowid) }
    },
  }
}

export interface LocalSqliteOptions {
  cacheKb?: number; mmapBytes?: number; busyTimeoutMs?: number; closeTimeoutMs?: number
  /** A replacement must not open its native connection before the old handle closes. */
  readyAfter?: Promise<void>
}
export interface SqliteCloseReceipt {
  readonly sourceEpoch: number
  readonly pid: number | null
  readonly requested: boolean
  readonly acknowledged: boolean
  readonly nativeClosed: boolean
  readonly exited: boolean
  readonly stdioClosed: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly forcedKill: boolean
  readonly pendingOperationsAtRequest: number
  readonly transactionsAtRequest: number
  readonly healthy: boolean
  readonly errors: readonly string[]
}
export interface SqliteDatabaseCloseReceipt {
  readonly healthy: boolean
  readonly receipts: readonly SqliteCloseReceipt[]
  readonly errors: readonly string[]
}
/** Retired epochs survive replacement clients without retaining native handles. */
export class SqliteCloseLedger {
  private readonly completed = new Map<number, SqliteCloseReceipt>()
  private readonly pending = new Map<LocalSqliteProcessClient, Promise<void>>()

  retire(client: LocalSqliteProcessClient): Promise<SqliteDatabaseCloseReceipt> {
    if (!this.pending.has(client)) {
      const retiring = client.closeWithReceipt().then(() => {
        for (const receipt of client.getCloseReceipts()) this.completed.set(receipt.sourceEpoch, receipt)
        this.pending.delete(client)
      })
      this.pending.set(client, retiring)
    }
    return Promise.all([...this.pending.values()]).then(() => {
      const receipts = Object.freeze([...this.completed.values()].sort((a, b) => a.sourceEpoch - b.sourceEpoch))
      const unhealthy = receipts.filter(receipt => !receipt.healthy)
      return Object.freeze({ healthy: unhealthy.length === 0, receipts,
        errors: Object.freeze(unhealthy.flatMap(receipt => [
          `SQLite epoch ${receipt.sourceEpoch} closed without healthy lifecycle evidence`, ...receipt.errors,
        ])),
      })
    })
  }
}
interface ProcessLifecycle {
  child: ChildProcess; epoch: number; token: string; requested: boolean; acknowledged: boolean; nativeClosed: boolean
  exited: boolean; stdioClosed: boolean; exitCode: number | null; signal: NodeJS.Signals | null; forcedKill: boolean
  pendingOperationsAtRequest: number; transactionsAtRequest: number; errors: string[]
  handleClosed: Promise<void>; resolveHandleClosed(): void
  receipt: Promise<SqliteCloseReceipt>; joinedReceipt: Promise<SqliteCloseReceipt>; resolveReceipt(value: SqliteCloseReceipt): void
  killTimer?: ReturnType<typeof setTimeout>
}
let nextSourceEpoch = 0
const clientEpochs = new WeakMap<Client, () => number>()
/** Only constructed local clients are branded; a copied shape/prototype is not authority. */
export function getLocalSqliteEpoch(client: Client): number | undefined { return clientEpochs.get(client)?.() }
const nonnegative = (value: number | undefined, fallback: number) => Number.isSafeInteger(value) && value! >= 0 ? value! : fallback

/** Native SQLite runs in its own process, isolated from host native modules and GC. */
export class LocalSqliteProcessClient implements Client {
  readonly protocol = 'file'
  closed = false
  private child!: ChildProcess
  private pending = new Map<number, Pending>()
  private transactions = new Set<ProcessTransaction>()
  private sequence = 0
  private lifecycle!: ProcessLifecycle
  private sourceEpoch = 0
  private readonly receipts: SqliteCloseReceipt[] = []
  private readiness: Promise<void> = Promise.resolve()
  private readonly config: Config
  private readonly pragmas: string[]
  private readonly closeTimeoutMs: number

  /** Changes synchronously on close as well as reconnect; object identity alone is insufficient. */
  get dataSourceEpoch(): number { return this.sourceEpoch }

  constructor(config: Config, options: LocalSqliteOptions = {}) {
    if (!config.url.startsWith('file:')) throw new Error('LocalSqliteProcessClient requires a file: database URL')
    this.config = { ...config, timeout: nonnegative(options.busyTimeoutMs ?? config.timeout, 5000) }
    clientEpochs.set(this, () => this.sourceEpoch)
    // fetch only configures HTTP clients and cannot cross process IPC.
    delete this.config.fetch
    this.closeTimeoutMs = Math.max(1, nonnegative(options.closeTimeoutMs, 10_000))
    this.pragmas = [
      'PRAGMA journal_mode=WAL', 'PRAGMA synchronous=NORMAL',
      `PRAGMA cache_size=-${nonnegative(options.cacheKb, 20000)}`, 'PRAGMA temp_store=MEMORY',
      `PRAGMA mmap_size=${nonnegative(options.mmapBytes, 268435456)}`,
      `PRAGMA busy_timeout=${this.config.timeout}`, 'PRAGMA foreign_keys=ON',
    ]
    this.start(options.readyAfter)
  }

  private start(after: Promise<void> = Promise.resolve()): void {
    // Explicit argv prevents inheriting host eval/TS loader/test-runner flags.
    // Config travels only over IPC; database credentials never enter argv.
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    delete env.NODE_OPTIONS
    const child = spawn(process.execPath, ['--input-type=commonjs', '--eval', LOCAL_SQLITE_PROCESS], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced', windowsHide: true, env,
    })
    this.child = child
    this.readiness = after
    const epoch = this.sourceEpoch = ++nextSourceEpoch
    let resolveHandleClosed!: () => void
    let resolveReceipt!: (value: SqliteCloseReceipt) => void
    const handleClosed = new Promise<void>(resolve => { resolveHandleClosed = resolve })
    const receipt = new Promise<SqliteCloseReceipt>(resolve => { resolveReceipt = resolve })
    const state: ProcessLifecycle = {
      child, epoch, token: randomUUID(), requested: false, acknowledged: false, nativeClosed: false,
      exited: false, stdioClosed: false, exitCode: null, signal: null, forcedKill: false,
      pendingOperationsAtRequest: 0, transactionsAtRequest: 0, errors: [],
      handleClosed,
      resolveHandleClosed: () => resolveHandleClosed(),
      receipt,
      joinedReceipt: Promise.all([after.catch(() => {}), receipt]).then(([, value]) => value),
      resolveReceipt: value => resolveReceipt(value),
    }
    // A second reconnect may close its not-yet-initialized process first. Keep
    // the whole predecessor barrier, rather than just the latest close event.
    this.lifecycle = state
    child.once('close', (code, signal) => {
      state.stdioClosed = true
      state.exitCode = code
      state.signal = signal
      clearTimeout(state.killTimer)
      const healthy = state.requested && state.acknowledged && state.nativeClosed && state.exited &&
        code === 0 && signal === null && !state.forcedKill && state.errors.length === 0 &&
        state.pendingOperationsAtRequest === 0 && state.transactionsAtRequest === 0
      const receipt: SqliteCloseReceipt = Object.freeze({
        sourceEpoch: state.epoch, pid: child.pid ?? null, requested: state.requested,
        acknowledged: state.acknowledged, nativeClosed: state.nativeClosed, exited: state.exited,
        stdioClosed: true, exitCode: code, signal, forcedKill: state.forcedKill,
        pendingOperationsAtRequest: state.pendingOperationsAtRequest, transactionsAtRequest: state.transactionsAtRequest,
        healthy, errors: Object.freeze([...state.errors]),
      })
      this.receipts.push(receipt)
      state.resolveReceipt(receipt)
      state.resolveHandleClosed()
    })
    child.on('message', (reply: Reply) => {
      // Reconnect changes this.child, but the previous process still owns its
      // close receipt. Its ACK must never be attributed to the replacement.
      if (reply.id === 0 && reply.closeControl) {
        if (state.requested && reply.closeControl.token === state.token) {
          if (typeof reply.closeControl.nativeClosed !== 'boolean' || !Array.isArray(reply.closeControl.errors) ||
              reply.closeControl.errors.some(error => typeof error !== 'string')) {
            state.errors.push('SQLite close control ACK had an invalid shape')
            return
          }
          state.acknowledged = true
          state.nativeClosed = reply.closeControl.nativeClosed
          state.errors.push(...reply.closeControl.errors)
        }
        return
      }
      if (reply.fatal) state.errors.push(reply.fatal.message)
      if (this.child !== child) return
      if (reply.fatal) { this.closed = true; this.sourceEpoch = ++nextSourceEpoch; this.failAll(fromError(reply.fatal)); return }
      const pending = this.pending.get(reply.id!)
      if (!pending) return
      this.pending.delete(reply.id!)
      if (pending.tx && reply.txClosed) { pending.tx.closed = true; this.transactions.delete(pending.tx) }
      if (reply.error) pending.reject(fromError(reply.error))
      else pending.resolve(reply.value)
      if (!this.pending.size && !state.requested) this.unref(child)
    })
    child.on('error', error => {
      state.errors.push(error.message)
      if (this.child === child) { this.closed = true; this.sourceEpoch = ++nextSourceEpoch; this.failAll(error) }
    })
    child.on('exit', (code, signal) => {
      state.exited = true
      state.exitCode = code
      state.signal = signal
      if (this.child === child) {
        this.closed = true
        this.sourceEpoch = ++nextSourceEpoch
        this.failAll(failure(`SQLite process exited (${signal ?? code})`, 'CLIENT_CLOSED'))
      }
    })
    const initializationFailed = (error: Error | null) => {
      if (!error) return
      state.errors.push(error.message)
      if (this.child === child) { this.closed = true; this.sourceEpoch = ++nextSourceEpoch; this.failAll(error) }
      this.forceKill(state)
    }
    void after.then(() => {
      if (this.child !== child || this.closed || !child.connected) return
      try {
        child.send({ op: 'init', args: [{ modulePath: createRequire(import.meta.url).resolve('@libsql/client/sqlite3'),
          config: this.config, pragmas: this.pragmas }] }, initializationFailed)
      } catch (error) { initializationFailed(error as Error) }
    }, error => initializationFailed(error instanceof Error ? error : new Error(String(error))))
    this.unref(child)
  }

  private ref(child: ChildProcess): void { child.ref(); child.channel?.ref() }
  private unref(child: ChildProcess): void { child.unref(); child.channel?.unref() }
  private failAll(error: Error): void {
    for (const waiting of this.pending.values()) waiting.reject(error)
    this.pending.clear()
    for (const tx of this.transactions) tx.closed = true
    this.transactions.clear()
  }

  call(op: string, args: unknown[] = [], tx?: ProcessTransaction): Promise<unknown> {
    if (this.closed) return Promise.reject(failure('The client is closed', 'CLIENT_CLOSED'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, tx })
      const child = this.child
      const readiness = this.readiness
      this.ref(child)
      void readiness.then(() => {
        if (!this.pending.has(id)) return
        const failed = (error: Error | null) => {
          if (!error || !this.pending.has(id)) return
          this.pending.delete(id)
          if (!this.pending.size) this.unref(child)
          reject(error)
        }
        try { child.send({ id, op, args, ...(tx ? { txId: tx.id } : {}) }, failed) }
        catch (error) { failed(error as Error) }
      }, error => {
        if (!this.pending.delete(id)) return
        reject(error)
      })
    })
  }
  execute(stmt: InStatement): Promise<ResultSet>
  execute(sql: string, args?: InArgs): Promise<ResultSet>
  async execute(stmt: InStatement, args?: InArgs): Promise<ResultSet> { return resultSet(await this.call('execute', [stmt, args]) as WireResult) }
  async batch(stmts: Array<InStatement | [string, InArgs?]>, mode?: TransactionMode): Promise<ResultSet[]> { return (await this.call('batch', [stmts, mode]) as WireResult[]).map(resultSet) }
  async migrate(stmts: InStatement[]): Promise<ResultSet[]> { return (await this.call('migrate', [stmts]) as WireResult[]).map(resultSet) }
  async executeMultiple(sql: string): Promise<void> { await this.call('executeMultiple', [sql]) }
  async transaction(mode?: TransactionMode): Promise<Transaction> {
    const tx = new ProcessTransaction(this, await this.call('transaction', [mode]) as number)
    this.transactions.add(tx)
    return tx
  }
  async sync(): Promise<Replicated> { return await this.call('sync') as Replicated }

  close(): void {
    const state = this.lifecycle
    if (state.requested || state.stdioClosed) return
    state.requested = true
    state.pendingOperationsAtRequest = this.pending.size
    state.transactionsAtRequest = this.transactions.size
    this.closed = true
    this.sourceEpoch = ++nextSourceEpoch
    this.failAll(failure('The client is closed', 'CLIENT_CLOSED'))
    const child = state.child
    this.ref(child)
    // A separate control message survives immediate reconnect. If native code
    // never returns, bound shutdown rather than retain an orphan forever.
    state.killTimer = setTimeout(() => this.forceKill(state), this.closeTimeoutMs)
    state.killTimer.unref()
    try {
      if (child.connected) child.send({ id: 0, op: 'close', closeToken: state.token }, error => {
        if (error) { state.errors.push(error.message); this.forceKill(state) }
      })
      else this.forceKill(state)
    } catch (error) { state.errors.push(error instanceof Error ? error.message : String(error)); this.forceKill(state) }
  }
  private forceKill(state: ProcessLifecycle): void {
    if (state.stdioClosed || state.exited) return
    state.forcedKill = true
    try { if (!state.child.kill()) state.errors.push('SQLite process termination was not accepted') }
    catch (error) { state.errors.push(error instanceof Error ? error.message : String(error)) }
  }
  /** Always resolves a receipt, including abnormal exits; callers must inspect healthy. */
  closeWithReceipt(): Promise<SqliteCloseReceipt> {
    const state = this.lifecycle
    this.close()
    return state.joinedReceipt
  }
  /** Prior failures remain visible after an explicit reconnect. */
  getCloseReceipts(): readonly SqliteCloseReceipt[] { return Object.freeze([...this.receipts]) }
  reconnect(): void {
    // New requests wait for the previous process to release its native connection.
    this.close()
    const prior = Promise.all([this.readiness.catch(() => {}), this.lifecycle.handleClosed]).then(() => {})
    this.closed = false
    this.start(prior)
  }

  /** Handle/stdio join only; neither this promise nor an exit code alone proves a close ACK. */
  whenClosed(): Promise<void> { return Promise.all([this.readiness.catch(() => {}), this.lifecycle.handleClosed]).then(() => {}) }
}

class ProcessTransaction implements Transaction {
  closed = false
  constructor(private readonly client: LocalSqliteProcessClient, readonly id: number) {}
  private async invoke(op: string, args: unknown[] = []): Promise<unknown> {
    if (this.closed) throw failure('The transaction is closed', 'TRANSACTION_CLOSED')
    return this.client.call(op, args, this)
  }
  execute(stmt: InStatement): Promise<ResultSet>
  execute(sql: string, args?: InArgs): Promise<ResultSet>
  async execute(stmt: InStatement, args?: InArgs): Promise<ResultSet> { return resultSet(await this.invoke('execute', [stmt, args]) as WireResult) }
  async batch(stmts: InStatement[]): Promise<ResultSet[]> { return (await this.invoke('batch', [stmts]) as WireResult[]).map(resultSet) }
  async executeMultiple(sql: string): Promise<void> { await this.invoke('executeMultiple', [sql]) }
  async commit(): Promise<void> { await this.invoke('commit') }
  async rollback(): Promise<void> { await this.invoke('rollback') }
  close(): void {
    if (this.closed) return
    this.closed = true
    void this.client.call('txClose', [], this).catch(() => {})
  }
}
