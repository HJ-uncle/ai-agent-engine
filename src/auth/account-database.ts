import type { InStatement, ResultSet, Transaction } from '@libsql/client'
import { getDb } from '../storage/sqlite/db.js'

let tail: Promise<void> = Promise.resolve()

/** Local libsql opens a new SQLite connection for each transaction but does not queue BEGINs. */
export async function beginAccountTransaction(): Promise<Transaction> {
  const previous = tail
  let unlock!: () => void
  tail = new Promise<void>(resolve => { unlock = resolve })
  await previous
  try {
    const deadline = Date.now() + 5000
    let tx: Transaction
    for (;;) {
      try { tx = await getDb().transaction('write'); break }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || !String(error.code).startsWith('SQLITE_BUSY') || Date.now() >= deadline) throw error
        // An asynchronous pause lets another request finish its transaction instead of blocking the event loop.
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    let released = false
    return {
      execute: statement => tx.execute(statement), batch: statements => tx.batch(statements),
      executeMultiple: sql => tx.executeMultiple(sql), commit: () => tx.commit(), rollback: () => tx.rollback(),
      get closed() { return tx.closed },
      close() { try { tx.close() } finally { if (!released) { released = true; unlock() } } },
    }
  } catch (error) { unlock(); throw error }
}

export async function executeAccountWrite(statement: InStatement): Promise<ResultSet> {
  const tx = await beginAccountTransaction()
  try { const result = await tx.execute(statement); await tx.commit(); return result }
  finally { tx.close() }
}
