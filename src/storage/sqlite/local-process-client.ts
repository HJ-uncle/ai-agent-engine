import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Client, Config, InArgs, InStatement, Replicated, ResultSet, Row, Transaction, TransactionMode, Value } from '@libsql/client'
import { LOCAL_SQLITE_PROCESS } from './local-process-runtime.js'

interface WireResult {
  columns: string[]; columnTypes: string[]; rows: Value[][]; rowsAffected: number; lastInsertRowid: bigint | undefined
}
interface WireError { name: string; message: string; code?: string; extendedCode?: string; rawCode?: number; statementIndex?: number }
interface Reply { id?: number; value?: unknown; error?: WireError; fatal?: WireError; txClosed?: boolean }
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

export interface LocalSqliteOptions { cacheKb?: number; mmapBytes?: number; busyTimeoutMs?: number }
const nonnegative = (value: number | undefined, fallback: number) => Number.isSafeInteger(value) && value! >= 0 ? value! : fallback

/** Native SQLite runs in its own process, isolated from host native modules and GC. */
export class LocalSqliteProcessClient implements Client {
  readonly protocol = 'file'
  closed = false
  private child!: ChildProcess
  private pending = new Map<number, Pending>()
  private transactions = new Set<ProcessTransaction>()
  private sequence = 0
  private closeCompletion: Promise<void> = Promise.resolve()
  private readiness: Promise<void> = Promise.resolve()
  private readonly config: Config
  private readonly pragmas: string[]

  constructor(config: Config, options: LocalSqliteOptions = {}) {
    if (!config.url.startsWith('file:')) throw new Error('LocalSqliteProcessClient requires a file: database URL')
    this.config = { ...config, timeout: nonnegative(options.busyTimeoutMs ?? config.timeout, 5000) }
    // fetch only configures HTTP clients and cannot cross process IPC.
    delete this.config.fetch
    this.pragmas = [
      'PRAGMA journal_mode=WAL', 'PRAGMA synchronous=NORMAL',
      `PRAGMA cache_size=-${nonnegative(options.cacheKb, 20000)}`, 'PRAGMA temp_store=MEMORY',
      `PRAGMA mmap_size=${nonnegative(options.mmapBytes, 268435456)}`,
      `PRAGMA busy_timeout=${this.config.timeout}`, 'PRAGMA foreign_keys=ON',
    ]
    this.start()
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
    this.closeCompletion = new Promise(resolve => child.once('close', () => resolve()))
    child.on('message', (reply: Reply) => {
      if (this.child !== child) return
      if (reply.fatal) { this.closed = true; this.failAll(fromError(reply.fatal)); return }
      const pending = this.pending.get(reply.id!)
      if (!pending) return
      this.pending.delete(reply.id!)
      if (pending.tx && reply.txClosed) { pending.tx.closed = true; this.transactions.delete(pending.tx) }
      if (reply.error) pending.reject(fromError(reply.error))
      else pending.resolve(reply.value)
      if (!this.pending.size) this.unref(child)
    })
    child.on('error', error => { if (this.child === child) { this.closed = true; this.failAll(error) } })
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.closed = true
        this.failAll(failure(`SQLite process exited (${signal ?? code})`, 'CLIENT_CLOSED'))
      }
    })
    const initializationFailed = (error: Error | null) => {
      if (!error) return
      if (this.child === child) { this.closed = true; this.failAll(error) }
      child.kill()
    }
    void after.then(() => {
      if (this.child !== child || this.closed || !child.connected) return
      try {
        child.send({ op: 'init', args: [{ modulePath: createRequire(import.meta.url).resolve('@libsql/client/sqlite3'),
          config: this.config, pragmas: this.pragmas }] }, initializationFailed)
      } catch (error) { initializationFailed(error as Error) }
    })
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
      this.ref(child)
      void this.readiness.then(() => {
        if (!this.pending.has(id)) return
        const failed = (error: Error | null) => {
          if (!error || !this.pending.has(id)) return
          this.pending.delete(id)
          if (!this.pending.size) this.unref(child)
          reject(error)
        }
        try { child.send({ id, op, args, ...(tx ? { txId: tx.id } : {}) }, failed) }
        catch (error) { failed(error as Error) }
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
    if (this.closed) return
    this.closed = true
    this.failAll(failure('The client is closed', 'CLIENT_CLOSED'))
    const child = this.child
    this.ref(child)
    // A separate control message survives immediate reconnect. If native code
    // never returns, bound shutdown rather than retain an orphan forever.
    const killTimer = setTimeout(() => child.kill(), 10_000)
    killTimer.unref()
    child.once('close', () => clearTimeout(killTimer))
    try {
      if (child.connected) child.send({ id: 0, op: 'close' }, error => { if (error) child.kill() })
      else child.kill()
    } catch { child.kill() }
  }
  reconnect(): void {
    // New requests wait for the previous process to release its native connection.
    if (!this.closed) this.close()
    this.closed = false
    const prior = Promise.all([this.readiness, this.closeCompletion]).then(() => {})
    this.start(prior)
  }

  /** Allows shutdown/tests to join the synchronous Client.close() without changing its interface. */
  whenClosed(): Promise<void> { return Promise.all([this.readiness, this.closeCompletion]).then(() => {}) }
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
