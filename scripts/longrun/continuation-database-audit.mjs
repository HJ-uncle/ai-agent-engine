import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Use the same libSQL backend as the frozen runtime. Vanilla SQLite does not
// understand libSQL ANN indexes and cannot authoritatively validate memory DBs.
export function continuationDatabaseAudit(root, stage) {
  const databases = []
  let Database, backendError
  try { Database = createRequire(path.join(stage, 'package.json'))('libsql') }
  catch (error) { backendError = error.message }
  for (const relative of ['agent.db', 'knowledge.db', 'memory/memory.db']) {
    const file = path.join(root, relative), result = { file: relative, backend: 'native-libsql', passed: false }
    let db
    try {
      if (backendError) throw new Error('Frozen runtime database backend unavailable: ' + backendError)
      if (!fs.existsSync(file)) throw new Error('Database was not exercised')
      const uri = pathToFileURL(file); uri.searchParams.set('mode', 'ro')
      db = new Database(uri.href); db.exec('PRAGMA query_only=ON')
      result.queryOnly = db.prepare('PRAGMA query_only').get().query_only
      result.quickCheck = db.prepare('PRAGMA quick_check').all().map(row => Object.values(row)[0])
      result.integrityCheck = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0])
      result.foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all()
      result.nonterminal = []
      if (relative === 'agent.db') {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
        for (const [table, column] of [['root_runs', 'state'], ['subagent_runs', 'snapshot'], ['command_jobs', 'snapshot']]) {
          if (!tables.has(table)) throw new Error('Missing exercised state table: ' + table)
          // Select public lifecycle fields only. Do not read retained requests.
          const rows = db.prepare(`SELECT json_valid(${column}) AS valid, CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.status') END AS status FROM ${table}`).all()
          result.nonterminal.push(...rows.filter(row => !row.valid || !['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted', 'timed_out'].includes(row.status)).map(row => ({ table, ...row })))
        }
      }
      result.passed = result.queryOnly === 1 && JSON.stringify(result.quickCheck) === '["ok"]' && JSON.stringify(result.integrityCheck) === '["ok"]' && result.foreignKeyViolations.length === 0 && result.nonterminal.length === 0
    } catch (error) { result.error = error.message }
    finally { db?.close() }
    databases.push(result)
  }
  return { at: new Date().toISOString(), passed: databases.length === 3 && databases.every(result => result.passed), stage, databases }
}
