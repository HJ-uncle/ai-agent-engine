// Covers tenant/run isolation and durable event cursors through the real Fastify handlers and SQLite store.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext } from '../../../../auth/types.js'
import * as stores from '../../../../core/subagent/store.js'
import * as runners from '../../../../core/subagent/runner.js'
import { subagentRoutes } from '../subagent.js'

let app: FastifyInstance
let db: Client
let store: stores.SubagentStore
let fixtureDir: string
const actorA = { 'x-fixture-actor': 'alice' }
const actorB = { 'x-fixture-actor': 'bob' }

beforeEach(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-subagent-routes-'))
  db = createClient({ url: `file:${path.join(fixtureDir, 'runs.db').replace(/\\/g, '/')}` })
  store = new stores.SubagentStore(db)
  vi.spyOn(stores, 'getSubagentStore').mockReturnValue(store)
  vi.spyOn(runners, 'getSubagentRunner').mockReturnValue(new runners.SubagentRunner(store))
  for (const [tenantId, runId, parentSessionId] of [
    ['tenant-a', 'run-a1', 'shared-parent'],
    ['tenant-a', 'run-a2', 'shared-parent'],
    ['tenant-a', 'run-a3', 'other-parent'],
    ['tenant-b', 'run-b1', 'shared-parent'],
  ]) {
    await store.createRun({ tenantId, runId, rootSessionId: parentSessionId, parentSessionId,
      parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: runId,
      task: `private task ${runId}`, description: 'same description', modelId: 'fixture' })
    await store.appendSnapshot(tenantId, runId, 'started', { status: 'running', startedAt: Date.now() })
  }
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request) => {
    // Test actors substitute only authentication; handlers still obtain identity from authContext.
    const actor = request.headers['x-fixture-actor'] === 'bob' ? 'bob' : 'alice'
    const authenticated = request as FastifyRequest & { authContext: AuthContext }
    authenticated.authContext = { userId: actor, tenantId: actor === 'bob' ? 'tenant-b' : 'tenant-a', method: 'jwt' }
  })
  await app.register(subagentRoutes)
})

afterEach(async () => {
  await app?.close()
  vi.restoreAllMocks()
  db.close()
  if (path.dirname(fixtureDir) !== path.resolve(os.tmpdir()) || !path.basename(fixtureDir).startsWith('aether-subagent-routes-')) throw new Error('Unsafe fixture cleanup path')
  try { fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }) }
  catch (error) {
    // Windows libsql may release detached native transaction handles only when the test worker exits.
    if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
  }
})

describe('Subagent HTTP tenant isolation', () => {
  it('lists only the authenticated tenant and requested parent, ignoring identity in the query', async () => {
    const resultA = await app.inject({ method: 'GET', url: '/subagent/runs?parentSessionId=shared-parent&tenantId=tenant-b', headers: actorA })
    expect(resultA.statusCode).toBe(200)
    expect(resultA.json().data.map((run: { runId: string }) => run.runId).sort()).toEqual(['run-a1', 'run-a2'])
    const resultB = await app.inject({ method: 'GET', url: '/subagent/runs?parentSessionId=shared-parent', headers: actorB })
    expect(resultB.json().data.map((run: { runId: string }) => run.runId)).toEqual(['run-b1'])
  })

  it('returns the exact requested run when sibling descriptions are identical', async () => {
    for (const runId of ['run-a1', 'run-a2']) {
      const response = await app.inject({ method: 'GET', url: `/subagent/runs/${runId}`, headers: actorA })
      expect(response.json()).toMatchObject({ code: 200, data: { runId, task: `private task ${runId}`, tenantId: 'tenant-a' } })
    }
  })

  it('replays only this run after the supplied cursor without including sibling events', async () => {
    await store.appendSnapshot('tenant-a', 'run-a1', 'output.updated', { partialOutput: 'a1 private output' })
    const response = await app.inject({ method: 'GET', url: '/subagent/runs/run-a1/events?afterSeq=1', headers: actorA })
    expect(response.json().data.map((event: { runId: string; seq: number; kind: string }) => [event.runId, event.seq, event.kind]))
      .toEqual([['run-a1', 2, 'started'], ['run-a1', 3, 'output.updated']])
    const empty = await app.inject({ method: 'GET', url: '/subagent/runs/run-a1/events?afterSeq=3', headers: actorA })
    expect(empty.json().data).toEqual([])
  })

  it.each([
    ['GET', ''], ['GET', '/events'], ['POST', '/cancel'],
  ] as const)('%s %s rejects another tenant without revealing or changing its run', async (method, suffix) => {
    const response = await app.inject({ method, url: `/subagent/runs/run-b1${suffix}?tenantId=tenant-b`, headers: actorA })
    // This API uses a standard business-error envelope, including for not-found responses.
    expect(response.json()).toMatchObject({ code: 40400, message: 'Subagent run not found', data: null })
    expect(response.body).not.toContain('private task')
    expect((await store.getRun('tenant-b', 'run-b1'))?.status).toBe('running')
    expect((await store.listEvents('tenant-b', 'run-b1')).map((event) => event.kind)).toEqual(['created', 'started'])
  })

  it.each([
    ['GET', ''], ['GET', '/events'], ['POST', '/cancel'],
  ] as const)('%s %s returns the same not-found envelope for an absent run', async (method, suffix) => {
    const response = await app.inject({ method, url: `/subagent/runs/missing-run${suffix}`, headers: actorA })
    expect(response.json()).toMatchObject({ code: 40400, message: 'Subagent run not found', data: null })
  })

  it('cancels only the named run and persists its event while siblings remain running', async () => {
    const response = await app.inject({ method: 'POST', url: '/subagent/runs/run-a1/cancel', headers: actorA })
    expect(response.json()).toMatchObject({ code: 200, data: { runId: 'run-a1', status: 'cancelling' } })
    expect((await store.getRun('tenant-a', 'run-a1'))?.status).toBe('cancelling')
    expect((await store.listEvents('tenant-a', 'run-a1')).at(-1)?.kind).toBe('cancelling')
    expect((await store.getRun('tenant-a', 'run-a2'))?.status).toBe('running')
    expect((await store.getRun('tenant-b', 'run-b1'))?.status).toBe('running')
  })
})
