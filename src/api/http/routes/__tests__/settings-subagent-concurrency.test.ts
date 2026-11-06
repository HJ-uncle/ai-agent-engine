import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsRoutes } from '../settings.js'
import { closeDb, getDb, initDb } from '../../../../storage/sqlite/db.js'
import { systemConfigStore } from '../../../../storage/sqlite/system-config.js'
import { getSubagentRunner } from '../../../../core/subagent/runner.js'
import { MANAGED_KEYS } from '../../../../core/aether-config.js'
import type { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'

describe('subagent concurrency settings reach the live runner', () => {
  let directory: string
  let app: ReturnType<typeof Fastify>
  beforeEach(async () => {
    await closeDb()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-subagent-settings-'))
    vi.stubEnv('DATA_DIR', path.join(directory, 'agent.db'))
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('SUBAGENT_CONCURRENCY_LIMIT', '')
    await initDb()
    getSubagentRunner()
    app = Fastify(); await app.register(settingsRoutes)
  })
  afterEach(async () => {
    MANAGED_KEYS.delete('SUBAGENT_CONCURRENCY_LIMIT')
    await app.close()
    const db = getDb() as LocalSqliteProcessClient
    closeDb(); await db.whenClosed(); vi.unstubAllEnvs()
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('aether-subagent-settings-')) throw new Error('Unsafe fixture cleanup')
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  async function settings() { return (await app.inject({ method: 'GET', url: '/settings' })).json().data }

  it('exposes the default and persists hot updates without constructing a new runner', async () => {
    const runner = getSubagentRunner()
    expect(await settings()).toMatchObject({ SUBAGENT_CONCURRENCY_LIMIT: 5,
      subagentConcurrency: { defaultLimit: 5, min: 1, max: 16, effectiveLimit: 5, hotReload: true, scope: 'parent-session' } })
    expect((await app.inject({ method: 'PUT', url: '/settings', payload: { SUBAGENT_CONCURRENCY_LIMIT: 7 } })).statusCode).toBe(200)
    expect(await systemConfigStore.get('SUBAGENT_CONCURRENCY_LIMIT')).toBe('7')
    expect(process.env.SUBAGENT_CONCURRENCY_LIMIT).toBe('7')
    expect(getSubagentRunner()).toBe(runner)
    expect(runner.concurrencyLimit).toBe(7)
    expect((await settings()).subagentConcurrency.effectiveLimit).toBe(7)
    expect((await app.inject({ method: 'PUT', url: '/settings', payload: { SUBAGENT_CONCURRENCY_LIMIT: 2 } })).statusCode).toBe(200)
    expect(runner.concurrencyLimit).toBe(2)
  })

  it('does not overwrite managed values or make them live through the hot-update path', async () => {
    MANAGED_KEYS.add('SUBAGENT_CONCURRENCY_LIMIT')
    expect((await app.inject({ method: 'PUT', url: '/settings', payload: { SUBAGENT_CONCURRENCY_LIMIT: 9 } })).statusCode).toBe(200)
    expect(getSubagentRunner().concurrencyLimit).toBe(5)
    expect(await systemConfigStore.get('SUBAGENT_CONCURRENCY_LIMIT')).toBeNull()
  })

  it.each([0, -1, 17, 1.2, true, null, '', '1e1', 'invalid'])('rejects invalid value %s before any persistence', async value => {
    const result = await app.inject({ method: 'PUT', url: '/settings', payload: { SUBAGENT_CONCURRENCY_LIMIT: value, TOOL_CONCURRENCY_LIMIT: 3 } })
    expect(result.statusCode).toBe(400)
    expect(await systemConfigStore.get('SUBAGENT_CONCURRENCY_LIMIT')).toBeNull()
    expect(await systemConfigStore.get('TOOL_CONCURRENCY_LIMIT')).toBeNull()
    expect(getSubagentRunner().concurrencyLimit).toBe(5)
  })
})
