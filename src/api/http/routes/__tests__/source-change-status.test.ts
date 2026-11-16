import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { captureSourceFiles, type SourceChangePendingAction } from '../../../../runtime/source-change-protocol.js'
import { chatRoutes } from '../chat.js'

const scratch = path.resolve('.e2e-tmp/source-change-status-tests')
let fixture: string
let db: LocalSqliteProcessClient
let app: FastifyInstance

beforeEach(async () => {
  fs.mkdirSync(scratch, { recursive: true })
  fixture = fs.mkdtempSync(path.join(scratch, 'case-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'engine.db'))
  vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'engine.db').replaceAll('\\', '/')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    Object.assign(request, { authContext: { tenantId: request.headers['x-tenant'] ?? 'tenant-a', method: 'none' } })
  })
  await app.register(chatRoutes, { prefix: '/api/v1' })
  await app.ready()
})

afterEach(async () => {
  await app?.close()
  if (db) await db.closeWithReceipt()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (fixture && path.dirname(fixture) === scratch && fs.existsSync(fixture)) fs.rmSync(fixture, { recursive: true, force: true })
  if (fs.existsSync(scratch) && !fs.lstatSync(scratch).isSymbolicLink() && fs.readdirSync(scratch).length === 0) fs.rmdirSync(scratch)
})

async function seedWaitingRun(): Promise<{ runId: string; sessionId: string; requestId: string }> {
  const file = path.join(fixture, 'source.ts')
  fs.writeFileSync(file, 'before')
  const before = captureSourceFiles([file], fixture)
  fs.writeFileSync(file, 'after')
  const after = captureSourceFiles([file], fixture)
  const action: SourceChangePendingAction = {
    type: 'source_change', protocolVersion: 1, phase: 'build', operation: 'execute_cmd', root: fixture,
    before, after, changes: [{ path: file, before: before.files[0], after: after.files[0], kind: 'modified' }],
    choices: ['pause', 'recheck', 'rebuild', 'skip'], defaultChoice: 'pause',
    reason: '源码版本变化', risk: 'external-source-change',
    wait: { mode: 'external-writer', reason: 'external-writer', startedAt: Date.now(), pollMs: 2_000, stableWindowMs: 250, blockers: [] },
  }
  const run = await rootRunStore.create('tenant-a', 'session-a', 'fixture-model', [fixture], {})
  const requestId = 'source-request'
  await rootRunStore.pending('tenant-a', run.runId, {
    requestId, toolCallId: 'source-tool-call', toolName: 'execute_cmd', args: { command: 'npm', args: ['run', 'build'] },
    kind: 'permission', question: action.reason, options: [...action.choices], pendingAction: action,
  })
  return { runId: run.runId, sessionId: run.sessionId, requestId }
}

describe('source-change status route', () => {
  it('is mounted under the API prefix and binds status to tenant, session, run and request', async () => {
    const target = await seedWaitingRun()
    const query = new URLSearchParams(target).toString()
    const valid = await app.inject({ method: 'GET', url: `/api/v1/chat/source-change-status?${query}`, headers: { 'x-tenant': 'tenant-a' } })
    expect(valid.statusCode, valid.body).toBe(200)
    expect(valid.json().data).toMatchObject({ ready: false, blockers: [] })
    expect(valid.json().data).not.toHaveProperty('pendingAction')

    for (const mismatch of [
      { sessionId: 'other-session' },
      { runId: 'other-run' },
      { requestId: 'other-request' },
    ]) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/chat/source-change-status?${new URLSearchParams({ ...target, ...mismatch })}`, headers: { 'x-tenant': 'tenant-a' } })
      expect(response.statusCode, response.body).toBe(404)
    }
    const foreignTenant = await app.inject({ method: 'GET', url: `/api/v1/chat/source-change-status?${query}`, headers: { 'x-tenant': 'tenant-b' } })
    expect(foreignTenant.statusCode, foreignTenant.body).toBe(404)
  })
})
