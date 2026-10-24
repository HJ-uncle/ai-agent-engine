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
    for (const key of [...OPTIONAL_LIMITS, 'COMPRESS_THRESHOLD_RATIO', 'CONTEXT_WINDOW_BUDGET']) vi.stubEnv(key, '')
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

  it('shows unlimited runtime state instead of imposing old fallbacks', async () => {
    expect(await settings()).toMatchObject({
      MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null, COMPRESS_THRESHOLD_RATIO: 0.92,
      runtimeLimits: {
        unlimited: true, ignoredByRuntime: true,
        code: { maxIterations: null, tokenBudget: null, commandTimeoutMs: null, unlimited: true },
        otherProfiles: { maxIterations: null, tokenBudget: null, commandTimeoutMs: null, unlimited: true,
          commandDefaults: { foregroundStandard: null, foregroundFullAccess: null, background: null } },
        legacy: { ignoredByRuntime: true, configured: { MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null } },
        compression: { configuredRatio: 0.92, effectiveRatio: 0.92 },
      },
    })
  })

  it('marks legacy values from startup environment as ignored instead of effective caps', async () => {
    vi.stubEnv('MAX_ITERATIONS', '4')
    vi.stubEnv('TOKEN_BUDGET', '900')
    vi.stubEnv('CMD_TIMEOUT_MS', '1200')
    expect(await settings()).toMatchObject({
      MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null,
      runtimeLimits: {
        unlimited: true, ignoredByRuntime: true,
        code: { maxIterations: null, tokenBudget: null, commandTimeoutMs: null, unlimited: true },
        otherProfiles: { maxIterations: null, tokenBudget: null, commandTimeoutMs: null, unlimited: true },
        legacy: { ignoredByRuntime: true, configured: { MAX_ITERATIONS: 4, TOKEN_BUDGET: 900, CMD_TIMEOUT_MS: 1200 } },
      },
    })
  })

  it('keeps explicit operator values while exposing their actual OSM and Code applicability', async () => {
    const saved = await app.inject({ method: 'PUT', url: '/settings', payload: {
      MAX_ITERATIONS: 50, TOKEN_BUDGET: 80_000, CMD_TIMEOUT_MS: 5_000, COMPRESS_THRESHOLD_RATIO: 0.5, OSM_MODE: 'balanced',
    } })
    expect(saved.statusCode).toBe(200)
    expect(await settings()).toMatchObject({
      MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null, COMPRESS_THRESHOLD_RATIO: 0.5,
      runtimeLimits: {
        unlimited: true, ignoredByRuntime: true,
        code: { maxIterations: null, tokenBudget: null, commandTimeoutMs: null, unlimited: true },
        otherProfiles: { maxIterations: null, tokenBudget: null, commandTimeoutMs: null, unlimited: true,
          commandDefaults: { foregroundStandard: null, foregroundFullAccess: null, background: null } },
        legacy: { ignoredByRuntime: true, configured: { MAX_ITERATIONS: 50, TOKEN_BUDGET: 80_000, CMD_TIMEOUT_MS: 5_000 } },
        compression: { configuredRatio: 0.5, effectiveRatio: 0.5 },
      },
    })
    expect(await systemConfigStore.get('MAX_ITERATIONS')).toBe('50')
    expect(process.env.MAX_ITERATIONS).toBe('')
    expect(process.env.TOKEN_BUDGET).toBe('')
    expect(process.env.CMD_TIMEOUT_MS).toBe('')
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
    expect(await settings()).toMatchObject({ MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null })
    expect(await systemConfigStore.get('TOKEN_BUDGET')).toBe('52000')
    expect(process.env.TOKEN_BUDGET).toBe('')
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

  it('persists the independent context policy, applies it immediately and restores 268K on reset', async () => {
    expect(await settings()).toMatchObject({ CONTEXT_WINDOW_BUDGET: 268_000,
      runtimeLimits: { contextWindow: { defaultBudget: 268_000, effectiveBudget: 268_000, boundedByModel: true } } })
    expect((await app.inject({ method: 'PUT', url: '/settings', payload: { CONTEXT_WINDOW_BUDGET: 192_000 } })).statusCode).toBe(200)
    expect(await systemConfigStore.get('CONTEXT_WINDOW_BUDGET')).toBe('192000')
    expect(process.env.CONTEXT_WINDOW_BUDGET).toBe('192000')
    expect(await settings()).toMatchObject({ CONTEXT_WINDOW_BUDGET: 192_000,
      runtimeLimits: { contextWindow: { configuredBudget: 192_000, effectiveBudget: 192_000 } } })
    for (const value of [null, '']) {
      expect((await app.inject({ method: 'PUT', url: '/settings', payload: { CONTEXT_WINDOW_BUDGET: value } })).statusCode).toBe(200)
      expect(await systemConfigStore.get('CONTEXT_WINDOW_BUDGET')).toBeNull()
      expect(process.env.CONTEXT_WINDOW_BUDGET).toBeUndefined()
      expect((await settings()).CONTEXT_WINDOW_BUDGET).toBe(268_000)
    }
  })

  it.each([0, -1, 1.2, true, '1e6', 'invalid', Number.MAX_SAFE_INTEGER + 1])('rejects invalid context policy %s before persistence', async value => {
    const response = await app.inject({ method: 'PUT', url: '/settings', payload: { CONTEXT_WINDOW_BUDGET: value, TOOL_CONCURRENCY_LIMIT: 3 } })
    expect(response.statusCode).toBe(400)
    expect(await systemConfigStore.get('CONTEXT_WINDOW_BUDGET')).toBeNull()
    expect(await systemConfigStore.get('TOOL_CONCURRENCY_LIMIT')).toBeNull()
  })
})
