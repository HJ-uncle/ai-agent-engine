import { afterEach, describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient, type Client, type InValue } from '@libsql/client'
import { migrateDevModels, parseDevMigrationArgs } from '../dev-migration.js'
import { up as initModels } from '../sqlite/migrations/007_add_models_management.js'
import { up as initSettings } from '../sqlite/migrations/010_add_system_config.js'
import { up as initCapabilities } from '../sqlite/migrations/014_add_model_capabilities.js'

// Synthetic test-only material. Tests never load env.ts, encryption.ts or real app state.
const KEY = 'a1'.repeat(32)
const SECRET = 'synthetic-model-api-key-for-migration'
const roots: string[] = []
const clients = new Set<Client>()

function encrypt(value = SECRET): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`
}

function decrypt(value: string): string {
  const [iv, tag, encrypted] = value.split(':')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8')
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-dev-migration-'))
  roots.push(root)
  return { root, sourceDbPath: path.join(root, 'legacy.db'), destinationDbPath: path.join(root, 'state', 'agent.db'), encryptionKey: KEY }
}

function connect(file: string): Client {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const client = createClient({ url: pathToFileURL(file).href })
  clients.add(client)
  return client
}

async function schema(file: string): Promise<Client> {
  const db = connect(file)
  await initModels(db)
  await initSettings(db)
  await initCapabilities(db)
  return db
}

async function model(db: Client, fields: Record<string, InValue> = {}): Promise<string> {
  const encrypted = encrypt()
  const row = { id: 'model-one', tenant_id: 'default', provider: 'custom', model_id: 'first', api_key: encrypted,
    base_url: 'https://synthetic.example/v1', display_name: 'Synthetic model', is_enabled: 1, version: 'test',
    capabilities: JSON.stringify({ vision: true, contextWindow: 123456, parallelTools: false }), created_at: 123, updated_at: 456, deleted_at: null, ...fields }
  const columns = Object.keys(row)
  await db.execute({ sql: `INSERT INTO models (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, args: Object.values(row) })
  return String(row.api_key)
}

afterEach(() => {
  for (const db of clients) db.close()
  clients.clear()
  for (const root of roots.splice(0)) {
    // Resolve every recursive-cleanup target and keep it inside this test's temporary namespace.
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-dev-migration-')) throw new Error('Unsafe fixture cleanup')
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }) }
    catch (error) {
      // Native Windows libsql transaction handles may remain alive until the worker exits.
      // As in the route/storage suites, do not confuse that release timing with failed assertions.
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  }
})

describe('D0 minimal model-state migration', () => {
  it('copies encrypted model connections and only related non-secret settings into a fresh state DB', async () => {
    const input = fixture()
    const source = await schema(input.sourceDbPath)
    const ciphertext = await model(source)
    await model(source, { id: 'disabled', model_id: 'second', is_enabled: 0 })
    await model(source, { id: 'deleted', model_id: 'removed', deleted_at: 789 })
    for (const [key, value, secret] of [
      ['LLM_PROVIDER', 'custom', 0], ['LLM_PRIMARY_MODEL', 'first', 0],
      ['MODEL_CAPABILITIES_FIRST', '{"thinking":false}', 0],
      ['MODEL_CAPABILITIES_UNUSED', '{"vision":true}', 0],
      ['OPENAI_API_KEY', encrypt('excluded-synthetic-secret'), 1], ['WORKSPACE_ROOT', '/old/workspace', 0],
    ] as const) await source.execute({ sql: 'INSERT INTO system_config (key,value,is_secret) VALUES (?,?,?)', args: [key, value, secret] })
    for (const table of ['conversations', 'file_changes', 'memories', 'users']) {
      await source.execute(`CREATE TABLE ${table} (content TEXT)`)
      await source.execute({ sql: `INSERT INTO ${table} VALUES (?)`, args: ['excluded synthetic history'] })
    }
    const sourceBytes = fs.readFileSync(input.sourceDbPath)
    const summary = await migrateDevModels(input)
    expect(summary).toEqual({ status: 'migrated', importedModels: 2, skippedModels: 0, importedSettings: 3 })
    const destination = connect(input.destinationDbPath)
    const rows = (await destination.execute('SELECT * FROM models ORDER BY id')).rows
    const migrated = rows.find(row => row.id === 'model-one')!
    expect(migrated.api_key).toBe(ciphertext)
    expect(decrypt(String(migrated.api_key))).toBe(SECRET)
    expect(migrated).toMatchObject({ provider: 'custom', model_id: 'first', base_url: 'https://synthetic.example/v1', is_enabled: 1, created_at: 123, updated_at: 456 })
    expect(JSON.parse(String(migrated.capabilities))).toEqual({ vision: true, contextWindow: 123456, parallelTools: false })
    expect(rows.find(row => row.id === 'disabled')?.is_enabled).toBe(0)
    expect((await destination.execute('SELECT key FROM system_config ORDER BY key')).rows.map(row => row.key)).toEqual(['LLM_PRIMARY_MODEL', 'LLM_PROVIDER', 'MODEL_CAPABILITIES_FIRST'])
    const tables = (await destination.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(row => row.name)
    for (const name of ['conversations', 'file_changes', 'memories', 'users']) expect(tables).not.toContain(name)
    expect(fs.readFileSync(input.sourceDbPath).equals(sourceBytes)).toBe(true)
    expect((await destination.execute('PRAGMA journal_mode')).rows[0].journal_mode).toBe('delete')
    expect(fs.existsSync(input.destinationDbPath + '-wal')).toBe(false)
    if (process.platform !== 'win32') {
      expect(fs.readdirSync(path.dirname(input.destinationDbPath)).filter(name => name.includes('.migration-'))).toEqual([])
    }
  })

  it('uses a completion marker and never replaces models or settings already in the target', async () => {
    const input = fixture()
    const source = await schema(input.sourceDbPath)
    await model(source)
    const destination = await schema(input.destinationDbPath)
    const originalKey = await model(destination, { id: 'target-id', display_name: 'Keep current settings', capabilities: '{"audio":true}' })
    await destination.execute("INSERT INTO system_config(key,value) VALUES ('LLM_PROVIDER','existing-provider')")
    await source.execute("INSERT INTO system_config(key,value) VALUES ('LLM_PROVIDER','custom')")
    expect(await migrateDevModels(input)).toEqual({ status: 'migrated', importedModels: 0, skippedModels: 1, importedSettings: 0 })
    expect((await destination.execute('SELECT * FROM models')).rows[0]).toMatchObject({ id: 'target-id', api_key: originalKey, display_name: 'Keep current settings', capabilities: '{"audio":true}' })
    await model(source, { id: 'later', model_id: 'later' })
    expect((await migrateDevModels(input)).status).toBe('already-migrated')
    expect((await destination.execute('SELECT * FROM models')).rows).toHaveLength(1)
    expect((await destination.execute('SELECT value FROM system_config')).rows[0].value).toBe('existing-provider')
  })

  it('preserves existing history and rolls back all imported rows and the marker when an insert fails', async () => {
    const input = fixture()
    const source = await schema(input.sourceDbPath)
    await model(source)
    await model(source, { id: 'model-two', model_id: 'second' })
    const destination = await schema(input.destinationDbPath)
    await destination.execute('CREATE TABLE conversations (content TEXT)')
    await destination.execute("INSERT INTO conversations VALUES ('new-state history')")
    await destination.execute("CREATE TRIGGER fail_second BEFORE INSERT ON models WHEN NEW.model_id='second' BEGIN SELECT RAISE(ABORT, 'synthetic-sensitive-error-details'); END")
    await expect(migrateDevModels(input)).rejects.toMatchObject({ code: 'migration-failed' })
    expect((await destination.execute('SELECT * FROM models')).rows).toHaveLength(0)
    expect((await destination.execute('SELECT * FROM _aether_dev_migrations')).rows).toHaveLength(0)
    expect((await destination.execute('SELECT content FROM conversations')).rows[0].content).toBe('new-state history')
    await destination.execute('DROP TRIGGER fail_second')
    expect((await migrateDevModels(input)).importedModels).toBe(2)
  })

  it('rejects an incorrect preserved key before publishing a target and can retry safely', async () => {
    const input = fixture()
    const source = await schema(input.sourceDbPath)
    await model(source)
    await expect(migrateDevModels({ ...input, encryptionKey: 'b2'.repeat(32) })).rejects.toMatchObject({ code: 'unreadable-model-credentials' })
    expect(fs.existsSync(input.destinationDbPath)).toBe(false)
    expect(fs.existsSync(input.sourceDbPath)).toBe(true)
    expect((await migrateDevModels(input)).importedModels).toBe(1)
  })

  it('fails closed on malformed credentials or capability overrides without logging row contents', async () => {
    const input = fixture()
    const source = await schema(input.sourceDbPath)
    await model(source, { api_key: 'do-not-echo-this-synthetic-credential' })
    await expect(migrateDevModels(input)).rejects.toMatchObject({ code: 'invalid-model-credentials' })
    await source.execute({ sql: 'UPDATE models SET api_key=?,capabilities=?', args: [encrypt(), 'do-not-echo-this-override'] })
    await expect(migrateDevModels(input)).rejects.toMatchObject({ code: 'invalid-model-capabilities' })
    expect(fs.existsSync(input.destinationDbPath)).toBe(false)
  })

  it('handles the earlier model schema without optional capability columns', async () => {
    const input = fixture()
    const source = connect(input.sourceDbPath)
    await source.execute('CREATE TABLE models(id TEXT, tenant_id TEXT, provider TEXT, model_id TEXT, api_key TEXT, base_url TEXT)')
    await source.execute({ sql: 'INSERT INTO models VALUES (?,?,?,?,?,?)', args: ['old', 'default', 'custom', 'old-model', encrypt(), 'https://synthetic.example/v1'] })
    expect((await migrateDevModels(input)).importedModels).toBe(1)
    expect((await connect(input.destinationDbPath).execute('SELECT * FROM models')).rows[0]).toMatchObject({ id: 'old', is_enabled: 0, capabilities: null })
  })

  it('requires absolute distinct databases and an explicit key; missing sources create nothing', async () => {
    const input = fixture()
    await expect(migrateDevModels({ ...input, sourceDbPath: 'relative.db' })).rejects.toMatchObject({ code: 'absolute-paths-required' })
    await expect(migrateDevModels({ ...input, destinationDbPath: input.sourceDbPath })).rejects.toMatchObject({ code: 'same-database' })
    await expect(migrateDevModels({ ...input, encryptionKey: '' })).rejects.toMatchObject({ code: 'invalid-encryption-key' })
    expect((await migrateDevModels(input)).status).toBe('source-missing')
    expect(fs.existsSync(input.destinationDbPath)).toBe(false)
    const source = await schema(input.sourceDbPath)
    await model(source)
    fs.mkdirSync(path.dirname(input.destinationDbPath), { recursive: true })
    fs.linkSync(input.sourceDbPath, input.destinationDbPath)
    await expect(migrateDevModels(input)).rejects.toMatchObject({ code: 'same-database' })
  })

  it('exposes a standalone CLI with only counts on stdout and sanitized errors on stderr', async () => {
    const input = fixture()
    await model(await schema(input.sourceDbPath))
    const script = fileURLToPath(new URL('../dev-migration.ts', import.meta.url))
    const args = ['--import', 'tsx', script, '--source-db', input.sourceDbPath, '--dest-db', input.destinationDbPath]
    const environment = { ...process.env, ENCRYPTION_KEY: KEY }
    const output = execFileSync(process.execPath, args, { env: environment, encoding: 'utf8', windowsHide: true })
    expect(JSON.parse(output)).toEqual({ status: 'migrated', importedModels: 1, skippedModels: 0, importedSettings: 0 })
    expect(output).not.toContain(SECRET)
    expect(output).not.toContain(input.sourceDbPath)
    // Exercise the normal engine initializer and credential reader against the published DB,
    // with the exact preserved synthetic key, in an isolated process/global DB singleton.
    const dbModule = new URL('../sqlite/db.ts', import.meta.url).href
    const modelsModule = new URL('../sqlite/models.ts', import.meta.url).href
    const readScript = `const {initDb,closeDb}=await import(${JSON.stringify(dbModule)}); const {ModelsStore}=await import(${JSON.stringify(modelsModule)}); await initDb(); const rows=await new ModelsStore().getModels('default'); process.stdout.write(JSON.stringify({count:rows.length,readable:rows.every(row=>row.apiKey.length>0)})); closeDb();`
    const readOutput = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', readScript], {
      env: { ...environment, DATA_DIR: input.destinationDbPath }, encoding: 'utf8', windowsHide: true,
    })
    expect(JSON.parse(readOutput)).toEqual({ count: 1, readable: true })
    expect(readOutput).not.toContain(SECRET)
    const failed = spawnSync(process.execPath, ['--import', 'tsx', script, '--key', SECRET], { env: environment, encoding: 'utf8', windowsHide: true })
    expect(failed.status).toBe(1)
    expect(failed.stdout).toBe('')
    expect(JSON.parse(failed.stderr).code).toBe('invalid-arguments')
    expect(failed.stderr).not.toContain(SECRET)
    expect(failed.stderr).not.toContain(KEY)
  })

  it('rejects duplicate or unknown CLI flags without reflecting their values', () => {
    expect(() => parseDevMigrationArgs(['--source-db', '/first', '--source-db', '/second'])).toThrow('Usage:')
    expect(() => parseDevMigrationArgs(['--source-db'])).toThrow('Usage:')
    expect(() => parseDevMigrationArgs([])).toThrow('required')
  })
})
