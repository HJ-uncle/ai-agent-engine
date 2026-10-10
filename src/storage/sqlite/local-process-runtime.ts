/** Fixed child-process program, emitted by tsc without a loader or copied asset. */
export const LOCAL_SQLITE_PROCESS = String.raw`
let db
let nativeDb
let Sqlite3Transaction
let intMode
let pragmas = []
let configured = false
let active = null
let busy = false
let closing = false
const queue = []
const error = (message, code) => Object.assign(new Error(message), { code })
const wireError = value => ({
  name: value?.name || 'Error', message: value?.message || String(value), code: value?.code,
  extendedCode: value?.extendedCode, rawCode: value?.rawCode, statementIndex: value?.statementIndex,
})
const send = value => { if (process.connected) process.send(value, () => {}) }
function shutdown() {
  closing = true
  try { active?.tx.close() } catch {}
  active = null
  try { db?.close(); if (nativeDb?.open) nativeDb.close() } catch {}
  // The process owns its only native connection and closes it explicitly.
  process.exit(0)
}
process.on('disconnect', shutdown)
const result = value => ({
  columns: value.columns, columnTypes: value.columnTypes, rowsAffected: value.rowsAffected,
  lastInsertRowid: value.lastInsertRowid,
  rows: value.rows.map(row => Array.from({ length: row.length }, (_, index) => row[index])),
})
async function configure() {
  if (configured) return
  // One physical connection is reused by statements and interactive transactions.
  for (const sql of pragmas) await db.execute(sql)
  configured = true
}
function finishTransaction() { active = null }
async function handle(request) {
  const { op, args = [], txId } = request
  if (op === 'close') {
    closing = true
    for (const waiting of queue.splice(0)) send({ id: waiting.id, error: wireError(error('The client is closed', 'CLIENT_CLOSED')) })
    try { active?.tx.close() } finally { active = null; db?.close() }
    return
  }
  if (txId) {
    if (!active || active.id !== txId) throw error('The transaction is closed', 'TRANSACTION_CLOSED')
    const tx = active.tx
    try {
      if (op === 'execute') return result(await tx.execute(...args))
      if (op === 'batch') return (await tx.batch(...args)).map(result)
      if (op === 'executeMultiple') return await tx.executeMultiple(...args)
      if (op === 'commit') return await tx.commit()
      if (op === 'rollback') return await tx.rollback()
      if (op === 'txClose') return tx.close()
      throw error('Unknown transaction operation', 'CLIENT_INVALID_OPERATION')
    } finally { if (tx.closed) finishTransaction() }
  }
  await configure()
  if (op === 'execute') return result(await db.execute(...args))
  if (op === 'batch') return (await db.batch(...args)).map(result)
  if (op === 'migrate') return (await db.migrate(...args)).map(result)
  if (op === 'executeMultiple') return await db.executeMultiple(...args)
  if (op === 'sync') return await db.sync()
  if (op === 'transaction') {
    const mode = args[0] ?? 'write'
    const begin = { write: 'BEGIN IMMEDIATE', read: 'BEGIN TRANSACTION READONLY', deferred: 'BEGIN DEFERRED' }[mode]
    if (!begin) throw error('Unknown transaction mode', 'UNKNOWN_TRANSACTION_MODE')
    await db.execute(begin)
    // Client.transaction() detaches the connection and leaves its release to GC.
    // Keep ownership here and reuse the driver's transaction/result/error adapters.
    const tx = new Sqlite3Transaction(nativeDb, intMode)
    active = { id: request.id, tx }
    return request.id
  }
  throw error('Unknown client operation', 'CLIENT_INVALID_OPERATION')
}
async function drain() {
  if (busy || closing) return
  // Let the transaction owner bypass unrelated queued writes to reach COMMIT.
  const index = active ? queue.findIndex(item => item.op === 'close' || item.txId === active.id) : 0
  if (index < 0 || !queue.length) return
  busy = true
  const request = queue.splice(index, 1)[0]
  try {
    const value = await handle(request)
    send({ id: request.id, value, txClosed: request.txId ? active?.id !== request.txId : undefined })
  } catch (cause) {
    send({ id: request.id, error: wireError(cause), txClosed: request.txId ? active?.id !== request.txId : undefined })
  } finally {
    busy = false
    if (closing) shutdown()
    else void drain()
  }
}
process.on('message', request => {
  if (request.op === 'init') {
    if (db || closing) return
    try {
      const { modulePath, config, pragmas: settings } = request.args[0]
      const { createRequire } = require('node:module')
      const requireClient = createRequire(modulePath)
      const { Sqlite3Client, Sqlite3Transaction: Transaction } = require(modulePath)
      const NativeDatabase = requireClient('libsql')
      const { expandConfig, isInMemoryConfig } = requireClient('@libsql/core/config')
      if (typeof Sqlite3Client !== 'function' || typeof Transaction !== 'function') {
        throw error('Installed libsql client does not expose its SQLite adapters', 'CLIENT_INCOMPATIBLE')
      }
      const expanded = expandConfig(config, true)
      if (expanded.scheme !== 'file') throw error('Local SQLite requires a file: URL', 'URL_SCHEME_NOT_SUPPORTED')
      const authority = expanded.authority
      if (authority && (!['', 'localhost'].includes(authority.host.toLowerCase()) ||
          authority.port !== undefined || authority.userinfo !== undefined)) {
        throw error('Invalid host, port, or credentials in file URL', 'URL_INVALID')
      }
      const memory = isInMemoryConfig(expanded)
      if (memory && expanded.syncUrl) throw error('Embedded replica requires a file database', 'URL_INVALID')
      const filename = memory ? expanded.scheme + ':' + expanded.path : expanded.path
      const options = { authToken: expanded.authToken, encryptionKey: expanded.encryptionKey,
        remoteEncryptionKey: expanded.remoteEncryptionKey, syncUrl: expanded.syncUrl,
        syncPeriod: expanded.syncInterval, readYourWrites: expanded.readYourWrites,
        offline: expanded.offline, timeout: expanded.timeout }
      nativeDb = new NativeDatabase(filename, options)
      intMode = expanded.intMode
      db = new Sqlite3Client(filename, options, nativeDb, intMode)
      Sqlite3Transaction = Transaction
      pragmas = settings
    } catch (cause) {
      if (process.connected) process.send({ fatal: wireError(cause) }, shutdown)
      else shutdown()
    }
    return
  }
  if (closing) { send({ id: request.id, error: wireError(error('The client is closed', 'CLIENT_CLOSED')) }); return }
  queue.push(request)
  void drain()
})
`
