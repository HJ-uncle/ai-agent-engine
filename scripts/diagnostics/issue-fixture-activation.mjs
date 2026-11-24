/** Acceptance fixtures only. Never accepts a production database, creates a DB, or prints a code. */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export async function issueIsolatedActivation(filename) {
  const dbFile=realpathSync(filename), roots=[join(root,'.e2e-tmp'),resolve(root,'../aether-code/.e2e-tmp')]
  if (!statSync(dbFile).isFile() || !roots.some(base => {
    if (!existsSync(base)) return false
    const target=realpathSync(base), rel=relative(target,dbFile)
    return target===resolve(base) && !!rel && !isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+sep)
  })) throw new Error('Registration fixture requires an existing isolated .e2e-tmp database')
  const { LocalSqliteProcessClient } = await import(pathToFileURL(join(root,'dist/storage/sqlite/local-process-client.js')).href)
  const { issueActivationCode } = await import(pathToFileURL(join(root,'dist/auth/account-activation.js')).href)
  const db = new LocalSqliteProcessClient({url:'file:'+encodeURIComponent(dbFile)},{cacheKb:512,mmapBytes:0})
  try {
    const tx=await db.transaction('write')
    try { const grant=await issueActivationCode(tx,'fixture-admin'); await tx.commit(); return grant.code } finally {tx.close()}
  } finally { await db.closeWithReceipt() }
}
