import { randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'

const REPAIR_NAME = 'cron-timeout-integer-literal-v1'
const CRON_SCHEMA_QUERY = "SELECT sql FROM sqlite_schema WHERE type='table' AND name='cron_jobs'"
const LEGACY_TIMEOUT_CHECK = [
  'timeout_seconds', 'integer', 'check', '(', 'timeout_seconds', 'is', 'null',
  'or', '(', 'typeof', '(', 'timeout_seconds', ')', '=', '"integer"',
  'and', 'timeout_seconds', 'between', '1', 'and', '86400', ')', ')',
]

/** Match the known old CHECK as SQL tokens, never inside a string or comment. */
function correctedCronSchema(sql: string): string | null {
  const tokens = Array.from(sql.matchAll(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[^\s]/g))
    .filter(token => !token[0].startsWith('--') && !token[0].startsWith('/*'))
  const matches: number[] = []
  for (let index = 0; index + LEGACY_TIMEOUT_CHECK.length <= tokens.length; index++) {
    if (LEGACY_TIMEOUT_CHECK.every((value, offset) => offset === 14
      ? tokens[index + offset][0] === value
      : tokens[index + offset][0].toLowerCase() === value)) matches.push(index)
  }
  if (matches.length !== 1) return null
  const literal = tokens[matches[0] + 14]
  return sql.slice(0, literal.index) + "'integer'" + sql.slice(literal.index! + literal[0].length)
}

async function schemaSql(db: Client | Transaction): Promise<string | null> {
  const value = (await db.execute(CRON_SCHEMA_QUERY)).rows[0]?.sql
  return typeof value === 'string' ? value : null
}

function schemaVersion(value: unknown): number {
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 0 || version >= 2147483647) throw new Error('Cannot safely advance SQLite schema version')
  return version
}

/**
 * Old ALTER ADD COLUMN accepted a double-quoted string in this CHECK, but a
 * later ALTER reparses every table with stricter quoting. Repair before any
 * migration, preserving rows, rootpages, indexes, triggers and foreign keys.
 */
export async function repairLegacyCronTimeoutSchema(db: Client): Promise<void> {
  const candidate = await schemaSql(db)
  if (!candidate || !correctedCronSchema(candidate)) return

  const transaction = await db.transaction('write')
  let primaryError: unknown
  try {
    // The writer lock and reread prevent an intervening migration from being
    // overwritten with the stale SQL obtained by the inexpensive first probe.
    const original = await schemaSql(transaction)
    const corrected = original && correctedCronSchema(original)
    if (!original || !corrected) return
    const columns = (await transaction.execute('PRAGMA table_xinfo(cron_jobs)')).rows
    if (columns.some(row => String(row.name).toLowerCase() === 'integer')) return
    if (!columns.some(row => row.name === 'timeout_seconds' && String(row.type).toUpperCase() === 'INTEGER')) return

    const originalVersion = schemaVersion((await transaction.execute('PRAGMA schema_version')).rows[0]?.schema_version)
    await transaction.execute(`CREATE TABLE IF NOT EXISTS _aether_schema_repairs (
      id TEXT PRIMARY KEY,
      repair_name TEXT NOT NULL,
      table_name TEXT NOT NULL,
      original_sql TEXT NOT NULL,
      original_schema_version INTEGER NOT NULL,
      repaired_at INTEGER NOT NULL
    )`)
    await transaction.execute({
      sql: 'INSERT INTO _aether_schema_repairs (id,repair_name,table_name,original_sql,original_schema_version,repaired_at) VALUES(?,?,?,?,?,?)',
      args: [randomUUID(), REPAIR_NAME, 'cron_jobs', original, originalVersion, Date.now()],
    })
    const version = schemaVersion((await transaction.execute('PRAGMA schema_version')).rows[0]?.schema_version)
    await transaction.execute('PRAGMA writable_schema=ON')
    const result = await transaction.execute({
      sql: "UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='cron_jobs' AND sql=?",
      args: [corrected, original],
    })
    if (result.rowsAffected !== 1) throw new Error('Cron schema changed during compatibility repair')
    await transaction.execute(`PRAGMA schema_version=${version + 1}`)
    // RESET also invalidates this connection's parsed schema. Validate the
    // repaired definition and existing cron rows before making it durable.
    await transaction.execute('PRAGMA writable_schema=RESET')
    await transaction.execute('SELECT * FROM cron_jobs LIMIT 0')
    const integrity = await transaction.execute('PRAGMA integrity_check(cron_jobs)')
    if (integrity.rows.length !== 1 || integrity.rows[0].integrity_check !== 'ok') throw new Error('Cron schema compatibility validation failed')
    await transaction.commit()
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError: unknown
    try {
      if (!transaction.closed) {
        try { await transaction.execute('PRAGMA writable_schema=OFF') }
        finally { await transaction.rollback() }
      }
    } catch (error) {
      cleanupError = error
    } finally {
      transaction.close()
      try {
        // A failed validation may have cached the tentative new definition;
        // reload after rollback as well as after commit, with writes disabled.
        await db.execute('PRAGMA writable_schema=RESET')
      } catch (error) {
        cleanupError ??= error
      }
    }
    // If rollback or disabling schema writes cannot be confirmed, discard
    // the only physical connection. Keep the original failure diagnosable.
    if (cleanupError) {
      db.close()
      if (!primaryError) throw cleanupError
    }
  }
}
