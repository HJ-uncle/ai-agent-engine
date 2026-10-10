import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsRoutes } from '../settings.js'
import { closeDb, getDb, initDb } from '../../../../storage/sqlite/db.js'
import { systemConfigStore } from '../../../../storage/sqlite/system-config.js'
import type { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'

const OPTIONAL_LIMITS = ['MAX_ITERATIONS', 'TOKEN_BUDGET', 'CMD_TIMEOUT_MS']

describe('settings reflect actual runtime limits', () => {
  let directory: string
  let app: ReturnType<typeof Fastify>
  beforeEach(async () => {
    await closeDb()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-runtime-settings-'))
    vi.stubEnv('DATA_DIR', path.join(directory, 'agent.db'))
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('OSM_MODE', 'off')
    for (const key of [...OPTIONAL_LIMITS, 'COMPRESS_THRESHOLD_RATIO']) vi.stubEnv(key, '')
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
  async function settings() { return (await app.inject({ method: 'GET', url: '/settings' })).json().data }

  it('shows unset limits and actual profile-dependent command defaults instead of imposing old fallbacks', async () => {
    expect(await settings()).toMatchObject({
      MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null, COMPRESS_THRESHOLD_RATIO: 0.92,
      runtimeLimits: {
        code: { maxIterations: null, tokenBudget: null, commandTimeoutMs: null },
        otherProfiles: { maxIterations: null, tokenBudget: null, commandTimeoutMs: null,
          commandDefaults: { foregroundStandard: 30_000, foregroundFullAccess: 120_000, background: 600_000 } },
        compression: { configuredRatio: 0.92, effectiveRatio: 0.92 },
      },
    })
  })

  it('keeps explicit operator values while exposing their actual OSM and Code applicability', async () => {
    const saved = await app.inject({ method: 'PUT', url: '/settings', payload: {
      MAX_ITERATIONS: 50, TOKEN_BUDGET: 80_000, CMD_TIMEOUT_MS: 5_000, COMPRESS_THRESHOLD_RATIO: 0.5, OSM_MODE: 'balanced',
    } })
    expect(saved.statusCode).toBe(200)
    expect(await settings()).toMatchObject({
      MAX_ITERATIONS: 50, TOKEN_BUDGET: 80_000, CMD_TIMEOUT_MS: 5_000, COMPRESS_THRESHOLD_RATIO: 0.5,
      runtimeLimits: {
        code: { maxIterations: null, tokenBudget: null, commandTimeoutMs: null },
        otherProfiles: { maxIterations: 100, tokenBudget: 160_000, commandTimeoutMs: 5_000 },
        compression: { configuredRatio: 0.5, effectiveRatio: 0.5 },
      },
    })
    expect(await systemConfigStore.get('MAX_ITERATIONS')).toBe('50')
  })

  it('lets a settings round trip keep unlimited defaults and never persists read-only applicability metadata', async () => {
    const current = await settings()
    const saved = await app.inject({ method: 'PUT', url: '/settings', payload: {
      MAX_ITERATIONS: current.MAX_ITERATIONS, TOKEN_BUDGET: current.TOKEN_BUDGET,
      CMD_TIMEOUT_MS: current.CMD_TIMEOUT_MS, COMPRESS_THRESHOLD_RATIO: current.COMPRESS_THRESHOLD_RATIO,
      runtimeLimits: current.runtimeLimits, managedKeys: current.managedKeys,
    } })
    expect(saved.statusCode).toBe(200)
    for (const key of OPTIONAL_LIMITS) {
      expect(await systemConfigStore.get(key)).toBeNull()
      expect(process.env[key]).toBeUndefined()
    }
    expect(await systemConfigStore.get('runtimeLimits')).toBeNull()
    expect(await systemConfigStore.get('managedKeys')).toBeNull()
    expect(await settings()).toMatchObject({ MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null })
  })

  it('resets only deliberately cleared limits while preserving other explicit settings', async () => {
    await app.inject({ method: 'PUT', url: '/settings', payload: { MAX_ITERATIONS: 37, TOKEN_BUDGET: 52_000, CMD_TIMEOUT_MS: 9_000 } })
    await app.inject({ method: 'PUT', url: '/settings', payload: { MAX_ITERATIONS: null, CMD_TIMEOUT_MS: null } })
    expect(await settings()).toMatchObject({ MAX_ITERATIONS: null, TOKEN_BUDGET: 52_000, CMD_TIMEOUT_MS: null })
    expect(await systemConfigStore.get('TOKEN_BUDGET')).toBe('52000')
    expect(process.env.TOKEN_BUDGET).toBe('52000')
    expect(await systemConfigStore.get('MAX_ITERATIONS')).toBeNull()
  })

  it('reports effective OSM compression overrides and the same defensive ratio clamp as ReAct', async () => {
    vi.stubEnv('OSM_MODE', 'max')
    expect((await settings()).runtimeLimits.compression).toEqual({ configuredRatio: 0.92, effectiveRatio: 0.7 })
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('COMPRESS_THRESHOLD_RATIO', '2')
    expect((await settings()).runtimeLimits.compression).toEqual({ configuredRatio: 2, effectiveRatio: 0.95 })
    vi.stubEnv('COMPRESS_THRESHOLD_RATIO', 'invalid')
    expect((await settings()).runtimeLimits.compression).toEqual({ configuredRatio: 0.92, effectiveRatio: 0.92 })
  })
})
