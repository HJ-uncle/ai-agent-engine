import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsRoutes } from '../settings.js'
import { closeDb, getDb, initDb } from '../../../../storage/sqlite/db.js'
import { systemConfigStore } from '../../../../storage/sqlite/system-config.js'
import type { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'

describe('independent memory embedding settings', () => {
  let directory: string
  let app: ReturnType<typeof Fastify>
  beforeEach(async () => {
    await closeDb()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-embedding-settings-'))
    vi.stubEnv('DATA_DIR', path.join(directory, 'agent.db'))
    for (const key of ['EMBEDDING_API_KEY', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'EMBEDDING_BASE_URL', 'EMBEDDING_SEND_DIMENSIONS']) vi.stubEnv(key, '')
    vi.stubEnv('AUTH_ENABLED', 'false')
    await initDb()
    app = Fastify()
    await app.register(settingsRoutes)
  })
  afterEach(async () => {
    await app.close()
    const previous = getDb() as LocalSqliteProcessClient
    closeDb(); await previous.whenClosed(); vi.unstubAllEnvs()
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('stores embedding keys encrypted and masks short keys without overwriting them on settings resubmission', async () => {
    const response = await app.inject({ method: 'PUT', url: '/settings', payload: {
      EMBEDDING_BASE_URL: 'https://embedding.example/v1', EMBEDDING_MODEL: 'semantic-v1', EMBEDDING_DIMENSIONS: 768, EMBEDDING_API_KEY: 'tiny',
    } })
    expect(response.statusCode).toBe(200)
    const row = await getDb().execute("SELECT value,is_secret FROM system_config WHERE key='EMBEDDING_API_KEY'")
    expect(row.rows[0].is_secret).toBe(1)
    expect(row.rows[0].value).not.toBe('tiny')
    const settings = (await app.inject({ method: 'GET', url: '/settings' })).json().data
    expect(settings).toMatchObject({ EMBEDDING_API_KEY: '...', EMBEDDING_MODEL: 'semantic-v1', EMBEDDING_DIMENSIONS: 768 })
    expect(await systemConfigStore.get('EMBEDDING_API_KEY')).toBe('tiny')
    await app.inject({ method: 'PUT', url: '/settings', payload: { EMBEDDING_API_KEY: settings.EMBEDDING_API_KEY } })
    expect(await systemConfigStore.get('EMBEDDING_API_KEY')).toBe('tiny')
  })

  it('rejects invalid dimensions and credential-bearing or non-HTTP endpoint addresses before persistence', async () => {
    for (const EMBEDDING_DIMENSIONS of [0, -1, 1.5, 'abc']) {
      expect((await app.inject({ method: 'PUT', url: '/settings', payload: { EMBEDDING_DIMENSIONS } })).statusCode).toBe(400)
    }
    for (const EMBEDDING_BASE_URL of ['file:///embedding', 'https://key:secret@example.com', 'https://example.com?api_key=secret']) {
      expect((await app.inject({ method: 'PUT', url: '/settings', payload: { EMBEDDING_BASE_URL } })).statusCode).toBe(400)
    }
    expect(await systemConfigStore.get('EMBEDDING_DIMENSIONS')).toBeNull()
    expect(await systemConfigStore.get('EMBEDDING_BASE_URL')).toBeNull()
  })
})
