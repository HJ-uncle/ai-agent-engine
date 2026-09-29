/**
 * D0 one-time development-state reset: keep model connections, not business history.
 * Host contract: node dist/storage/dev-migration.js --source-db ABS --dest-db ABS
 * The host must supply the already preserved ENCRYPTION_KEY in the environment.
 * This entry deliberately does not import env.ts, main.ts, or the global DB singleton.
 */
import { createDecipheriv, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient, type Client, type InValue, type Row } from '@libsql/client'
import { up as initModels } from './sqlite/migrations/007_add_models_management.js'
import { up as initSettings } from './sqlite/migrations/010_add_system_config.js'
import { up as initCapabilities } from './sqlite/migrations/014_add_model_capabilities.js'

const MIGRATION_ID = 'legacy-model-connections-v1'
const MODEL_COLUMNS = [
  'id', 'tenant_id', 'provider', 'model_id', 'api_key', 'base_url',
  'display_name', 'is_enabled', 'version', 'capabilities', 'created_at', 'updated_at',
] as const
const REQUIRED_SOURCE_COLUMNS = ['id', 'tenant_id', 'provider', 'model_id', 'api_key', 'base_url']
const SETTINGS_KEYS = new Set(['LLM_PROVIDER', 'LLM_PRIMARY_MODEL', 'LLM_MODEL'])

export interface DevModelMigrationOptions {
  sourceDbPath: string
  destinationDbPath: string
  /** The same key as the source. Never regenerated, saved, returned or logged here. */
  encryptionKey: string
}

export interface DevModelMigrationResult {
  status: 'migrated' | 'already-migrated' | 'source-missing'
  importedModels: number
  skippedModels: number
  importedSettings: number
}

export class DevModelMigrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DevModelMigrationError'
  }
}

function result(status: DevModelMigrationResult['status']): DevModelMigrationResult {
  return { status, importedModels: 0, skippedModels: 0, importedSettings: 0 }
}

function open(dbPath: string): Client {
  return createClient({ url: pathToFileURL(dbPath).href })
}

async function hasTable(db: Client, name: string): Promise<boolean> {
  const found = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [name] })
  return found.rows.length > 0
}

async function completed(db: Client): Promise<boolean> {
  if (!await hasTable(db, '_aether_dev_migrations')) return false
  const found = await db.execute({ sql: 'SELECT 1 FROM _aether_dev_migrations WHERE id=?', args: [MIGRATION_ID] })
  return found.rows.length > 0
}

function validatePaths(options: DevModelMigrationOptions): void {
  if (!path.isAbsolute(options.sourceDbPath) || !path.isAbsolute(options.destinationDbPath)) {
    throw new DevModelMigrationError('absolute-paths-required', 'Source and destination database paths must be absolute.')
  }
  const source = path.resolve(options.sourceDbPath)
  const destination = path.resolve(options.destinationDbPath)
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  if (normalize(source) === normalize(destination)) {
    throw new DevModelMigrationError('same-database', 'Source and destination must be different databases.')
  }
  if (fs.existsSync(source) && fs.existsSync(destination)) {
    const sourceStat = fs.statSync(source)
    const destinationStat = fs.statSync(destination)
    if (normalize(fs.realpathSync(source)) === normalize(fs.realpathSync(destination)) ||
        (sourceStat.ino !== 0 && sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino)) {
      throw new DevModelMigrationError('same-database', 'Source and destination must be different databases.')
    }
  }
}

/** Authenticate the existing GCM ciphertext without producing a plaintext string. */
function validateCiphertext(value: unknown, key: Buffer): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new DevModelMigrationError('invalid-model-credentials', 'A source model credential is not valid encrypted data; source was preserved.')
  }
  const [iv, tag, ciphertext] = value.split(':')
  let plaintext: Buffer | undefined
  let final: Buffer | undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'))
    decipher.setAuthTag(Buffer.from(tag, 'hex'))
    plaintext = decipher.update(Buffer.from(ciphertext, 'hex'))
    final = decipher.final()
  } catch {
    throw new DevModelMigrationError('unreadable-model-credentials', 'Source model credentials cannot be read with the preserved key; source was preserved.')
  } finally {
    plaintext?.fill(0)
    final?.fill(0)
  }
}

function validateJsonObject(value: unknown): void {
  if (value === null || value === undefined) return
  try {
    const parsed = JSON.parse(String(value))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
  } catch {
    throw new DevModelMigrationError('invalid-model-capabilities', 'A source model capability override is invalid; source was preserved.')
  }
}

async function readSource(source: Client, key: Buffer): Promise<{ models: Row[]; settings: Row[] }> {
  // No source schema migration, journal-mode change, update, or delete is permitted.
  await source.execute('PRAGMA query_only = ON')
  const transaction = await source.transaction('read')
  try {
    const tables = await transaction.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('models','system_config')")
    const names = new Set(tables.rows.map(row => row.name))
    let models: Row[] = []
    if (names.has('models')) {
      const info = await transaction.execute('PRAGMA table_info(models)')
      const columns = new Set(info.rows.map(row => row.name))
      if (REQUIRED_SOURCE_COLUMNS.some(column => !columns.has(column))) {
        throw new DevModelMigrationError('unsupported-source-schema', 'Source model schema is incomplete; source was preserved.')
      }
      const defaults: Record<string, string> = { is_enabled: '0', created_at: 'unixepoch()', updated_at: 'unixepoch()' }
      const selected = MODEL_COLUMNS.map(column => columns.has(column) ? column : `${defaults[column] ?? 'NULL'} AS ${column}`)
      const active = columns.has('deleted_at') ? ' WHERE deleted_at IS NULL' : ''
      models = (await transaction.execute(`SELECT ${selected.join(', ')} FROM models${active}`)).rows
      for (const row of models) {
        if (REQUIRED_SOURCE_COLUMNS.some(column => typeof row[column] !== 'string')) {
          throw new DevModelMigrationError('invalid-source-model', 'A source model record is incomplete; source was preserved.')
        }
        validateCiphertext(row.api_key, key)
        validateJsonObject(row.capabilities)
      }
    }
    const modelIds = new Set(models.map(row => String(row.model_id)))
    const providers = new Set(models.map(row => String(row.provider)))
    const capabilityKeys = new Set([...modelIds].map(id => `MODEL_CAPABILITIES_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`))
    let settings: Row[] = []
    if (names.has('system_config')) {
      // Read only the explicit allowlist and capability namespace, never general secrets/settings.
      const candidates = await transaction.execute({
        sql: "SELECT key,value,is_secret,updated_at FROM system_config WHERE key IN (?,?,?) OR substr(key,1,19)='MODEL_CAPABILITIES_'",
        args: [...SETTINGS_KEYS],
      })
      settings = candidates.rows.filter(row => {
        if (Number(row.is_secret) !== 0 || typeof row.value !== 'string') return false
        if (capabilityKeys.has(String(row.key))) {
          validateJsonObject(row.value)
          return true
        }
        if (row.key === 'LLM_PROVIDER') return providers.has(row.value)
        return SETTINGS_KEYS.has(String(row.key)) && modelIds.has(row.value)
      })
    }
    await transaction.commit()
    return { models, settings }
  } finally {
    transaction.close()
  }
}

async function importModels(destination: Client, data: { models: Row[]; settings: Row[] }): Promise<DevModelMigrationResult> {
  // Existing schema migrations initialize only connection-related tables. Normal engine startup
  // initializes all other empty tables later; no history/index/account data is copied.
  await initModels(destination)
  await initSettings(destination)
  await initCapabilities(destination)
  await destination.execute('CREATE TABLE IF NOT EXISTS _aether_dev_migrations (id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)')
  const transaction = await destination.transaction('write')
  try {
    const marker = await transaction.execute({ sql: 'SELECT 1 FROM _aether_dev_migrations WHERE id=?', args: [MIGRATION_ID] })
    if (marker.rows.length) {
      await transaction.commit()
      return result('already-migrated')
    }
    const summary = result('migrated')
    for (const row of data.models) {
      const inserted = await transaction.execute({
        sql: `INSERT INTO models (${MODEL_COLUMNS.join(',')}) VALUES (${MODEL_COLUMNS.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`,
        args: MODEL_COLUMNS.map(column => row[column] as InValue),
      })
      if (inserted.rowsAffected) summary.importedModels++
      else summary.skippedModels++
    }
    for (const row of data.settings) {
      const inserted = await transaction.execute({
        sql: 'INSERT INTO system_config (key,value,is_secret,updated_at) VALUES (?,?,0,?) ON CONFLICT(key) DO NOTHING',
        args: [row.key, row.value, row.updated_at] as InValue[],
      })
      summary.importedSettings += inserted.rowsAffected
    }
    await transaction.execute({ sql: 'INSERT INTO _aether_dev_migrations (id,completed_at) VALUES (?,unixepoch())', args: [MIGRATION_ID] })
    await transaction.commit()
    return summary
  } catch (error) {
    await transaction.rollback().catch(() => undefined)
    throw error
  } finally {
    transaction.close()
  }
}

export async function migrateDevModels(options: DevModelMigrationOptions): Promise<DevModelMigrationResult> {
  let source: Client | undefined
  let destination: Client | undefined
  let temporary: string | undefined
  let key: Buffer | undefined
  try {
    validatePaths(options)
    if (!/^[0-9a-f]{64}$/i.test(options.encryptionKey)) {
      throw new DevModelMigrationError('invalid-encryption-key', 'A preserved 64-character hexadecimal ENCRYPTION_KEY is required.')
    }
    key = Buffer.from(options.encryptionKey, 'hex')
    if (!fs.existsSync(options.sourceDbPath)) return result('source-missing')
    if (!fs.statSync(options.sourceDbPath).isFile()) {
      throw new DevModelMigrationError('invalid-source-path', 'Source database must be a regular file.')
    }
    if (fs.existsSync(options.destinationDbPath)) {
      destination = open(options.destinationDbPath)
      if (await completed(destination)) return result('already-migrated')
    }
    source = open(options.sourceDbPath)
    const data = await readSource(source, key)
    source.close()
    source = undefined
    if (destination) return await importModels(destination, data)

    fs.mkdirSync(path.dirname(options.destinationDbPath), { recursive: true })
    temporary = `${options.destinationDbPath}.migration-${randomUUID()}.tmp`
    destination = open(temporary)
    // The published main file must be self-contained. Never publish a DB whose latest
    // committed pages still live in a WAL sidecar under the staging filename.
    await destination.execute('PRAGMA journal_mode = DELETE')
    const summary = await importModels(destination, data)
    destination.close()
    destination = undefined
    // Hard-link publication is atomic and exclusive on the same filesystem. An interrupted
    // migration never exposes a half-populated new state DB or overwrites another initializer.
    try {
      fs.linkSync(temporary, options.destinationDbPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      destination = open(options.destinationDbPath)
      return await importModels(destination, data)
    }
    return summary
  } catch (error) {
    if (error instanceof DevModelMigrationError) throw error
    // SQLite errors can embed bound values. Never forward them to the host's logs.
    throw new DevModelMigrationError('migration-failed', 'Model migration failed; the source database was preserved and migration can be retried.')
  } finally {
    source?.close()
    destination?.close()
    key?.fill(0)
    if (temporary) {
      // Only exact files owned by this invocation; no directory cleanup or source deletion.
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        // Windows libsql can retain a detached native transaction handle until process exit;
        // an isolated staging link may remain, but the published DB is complete and marked.
        try { fs.unlinkSync(temporary + suffix) } catch { /* never delete or replace the destination */ }
      }
    }
  }
}

export function parseDevMigrationArgs(args: string[]): Pick<DevModelMigrationOptions, 'sourceDbPath' | 'destinationDbPath'> {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!['--source-db', '--dest-db'].includes(flag) || !value || values.has(flag)) {
      throw new DevModelMigrationError('invalid-arguments', 'Usage: dev-migration.js --source-db ABSOLUTE_PATH --dest-db ABSOLUTE_PATH')
    }
    values.set(flag, value)
  }
  if (values.size !== 2) throw new DevModelMigrationError('invalid-arguments', 'Source and destination database arguments are required.')
  return { sourceDbPath: values.get('--source-db')!, destinationDbPath: values.get('--dest-db')! }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const summary = await migrateDevModels({ ...parseDevMigrationArgs(process.argv.slice(2)), encryptionKey: process.env.ENCRYPTION_KEY ?? '' })
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } catch (error) {
    const failure = error instanceof DevModelMigrationError ? error : new DevModelMigrationError('migration-failed', 'Model migration failed; source was preserved.')
    process.stderr.write(`${JSON.stringify({ status: 'error', code: failure.code, message: failure.message })}\n`)
    process.exitCode = 1
  }
}
