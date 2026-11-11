import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'

const parent = path.resolve('.e2e-tmp', 'knowledge-tests')
/** Real connection ownership matters: libsql's file::memory: does not survive transaction() handoff. */
export function knowledgeFixture() {
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'fixture-'))
  const db = new LocalSqliteProcessClient({ url: pathToFileURL(path.join(root, 'knowledge.db')).href })
  return { root, db, async close() {
    const receipt = await db.closeWithReceipt()
    if (!receipt.healthy) throw new Error('Knowledge fixture database did not close cleanly')
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe knowledge fixture cleanup')
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } }
}
