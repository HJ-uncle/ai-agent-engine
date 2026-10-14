// Covers tenant/run isolation and durable event cursors through the real Fastify handlers and SQLite store.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext } from '../../../../auth/types.js'
import type { SubagentEvent } from '../../../../core/subagent/types.js'
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

describe('Subagent negotiated bounded pages', () => {
  it('advertises an exact versioned capability contract before any client enables v2', async () => {
    const result = (await app.inject({ url: '/subagent/capabilities', headers: actorA })).json()
    expect(result).toMatchObject({ code: 200, data: {
      schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'],
      toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true,
    } })
  })
  async function toolsFixture(runId = 'run-a1') {
    for (const id of ['tool-1', 'tool-2']) {
      await store.appendSnapshot('tenant-a', runId, 'tool.started', current => ({
        toolCalls: [...current.toolCalls, { id, name: 'fixture', args: { text: '参数'.repeat(100) }, status: 'running', startedAt: 10 }],
      }))
    }
    return (await store.getRunView('tenant-a', runId))!.lastSeq
  }

  it('keeps legacy arrays explicit and negotiates bounded summaries with stable collection cursors', async () => {
    const first = (await app.inject({ url: '/subagent/runs?parentSessionId=shared-parent&view=summary&limit=1', headers: actorA })).json()
    expect(first.code).toBe(200)
    expect(first.data).toMatchObject({ schemaVersion: 2, hasMore: true, listComplete: false })
    expect(first.data.runs).toHaveLength(1)
    expect(first.data.runs[0]).toMatchObject({ schemaVersion: 2, view: 'summary', tenantId: 'tenant-a' })
    expect(typeof first.data.nextCursor).toBe('string')
    const next = (await app.inject({ url: '/subagent/runs?parentSessionId=shared-parent&view=summary&limit=1&cursor=' + encodeURIComponent(first.data.nextCursor), headers: actorA })).json()
    expect(next.code).toBe(200)
    expect(next.data.revision).toBe(first.data.revision)
    expect(next.data.hasMore).toBe(false)
    expect(new Set([...first.data.runs, ...next.data.runs].map((run: { runId: string }) => run.runId))).toEqual(new Set(['run-a1', 'run-a2']))
    const legacy = (await app.inject({ url: '/subagent/runs?parentSessionId=shared-parent&view=legacy', headers: actorA })).json()
    expect(Array.isArray(legacy.data)).toBe(true)
    expect(legacy.data.map((run: { schemaVersion: number }) => run.schemaVersion)).toEqual([1, 1])
    const crossTenant = (await app.inject({ url: '/subagent/runs?parentSessionId=shared-parent&view=summary&cursor=' + encodeURIComponent(first.data.nextCursor), headers: actorB })).json()
    expect(crossTenant.code).toBe(40001)
    const crossParent = (await app.inject({ url: '/subagent/runs?parentSessionId=other-parent&view=summary&cursor=' + encodeURIComponent(first.data.nextCursor), headers: actorA })).json()
    expect(crossParent.code).toBe(40001)
  })

  it('continues stable tool pages at the original watermark after new tools and completions arrive', async () => {
    const atSeq = await toolsFixture()
    await toolsFixture('run-a2')
    const first = (await app.inject({ url: '/subagent/runs/run-a1/tools?atSeq=' + atSeq + '&limit=1', headers: actorA })).json()
    expect(first.code).toBe(200)
    expect(first.data).toMatchObject({ schemaVersion: 2, runId: 'run-a1', asOfSeq: atSeq, totalCount: 2, hasMore: true })
    expect(first.data.items).toHaveLength(1)
    await store.appendSnapshot('tenant-a', 'run-a1', 'tool.completed', current => ({
      toolCalls: current.toolCalls.map(tool => tool.id === 'tool-1' ? { ...tool, status: 'succeeded', output: 'newer output' } : tool),
    }))
    await store.appendSnapshot('tenant-a', 'run-a1', 'tool.started', current => ({
      toolCalls: [...current.toolCalls, { id: 'future-tool', name: 'future', args: {}, status: 'running' }],
    }))
    const cursor = encodeURIComponent(first.data.nextCursor)
    const next = (await app.inject({ url: '/subagent/runs/run-a1/tools?atSeq=' + atSeq + '&limit=1&cursor=' + cursor, headers: actorA })).json()
    expect(next.code).toBe(200)
    expect(next.data).toMatchObject({ asOfSeq: atSeq, totalCount: 2, hasMore: false })
    const originalTools = [...first.data.items, ...next.data.items]
    expect(originalTools.map(tool => tool.id)).toEqual(['tool-1', 'tool-2'])
    expect(originalTools.map(tool => tool.status)).toEqual(['running', 'running'])
    expect((await app.inject({ url: '/subagent/runs/run-a2/tools?atSeq=' + atSeq + '&cursor=' + cursor, headers: actorA })).json().code).toBe(40001)
    expect((await app.inject({ url: '/subagent/runs/run-a1/tools?atSeq=' + (atSeq + 1) + '&cursor=' + cursor, headers: actorA })).json().code).toBe(40001)
    const exact = (await app.inject({ url: '/subagent/runs/run-a1?view=summary&atSeq=' + atSeq, headers: actorA })).json().data
    expect(exact.lastSeq).toBe(atSeq)
    expect(exact.coverage.toolCount).toBe(2)
    expect(exact.toolCalls.map((tool: { id: string }) => tool.id)).not.toContain('future-tool')
  })

  it('retrieves complete multi-byte tool details through bounded exact-sequence UTF-8 chunks', async () => {
    await toolsFixture()
    const output = '详情内容'.repeat(1000)
    const completed = await store.appendSnapshot('tenant-a', 'run-a1', 'tool.completed', current => ({
      toolCalls: current.toolCalls.map(tool => tool.id === 'tool-1' ? { ...tool, status: 'succeeded', output } : tool),
    }))
    const atSeq = completed!.seq
    const chunks: string[] = []
    let offset = 0
    for (let guard = 0; guard < 100; guard++) {
      const response = (await app.inject({ url: '/subagent/runs/run-a1/tools/tool-1?atSeq=' + atSeq + '&offset=' + offset + '&limitBytes=256', headers: actorA })).json()
      expect(response.code).toBe(200)
      expect(response.data).toMatchObject({ schemaVersion: 2, runId: 'run-a1', asOfSeq: atSeq, tool: { id: 'tool-1' } })
      const detail = response.data.detail
      expect(detail).toMatchObject({ encoding: 'json-utf8', offset })
      expect(Buffer.byteLength(detail.text, 'utf8')).toBeLessThanOrEqual(256)
      expect(detail.text).not.toContain('\uFFFD')
      chunks.push(detail.text)
      if (!detail.hasMore) {
        expect(Buffer.byteLength(chunks.join(''), 'utf8')).toBe(detail.totalBytes)
        const full = JSON.parse(chunks.join(''))
        expect(full.args).toEqual({ text: '参数'.repeat(100) })
        expect(full.output).toBe(output)
        return
      }
      expect(detail.nextOffset).toBeGreaterThan(offset)
      offset = detail.nextOffset
    }
    throw new Error('Tool detail chunk cursor did not finish within fixture size')
  })

  it('bounds delta replay, reports missing sequences and does not turn gaps into successful empty histories', async () => {
    await store.createRunDelta({ tenantId: 'tenant-a', runId: 'delta-replay', rootSessionId: 'delta-parent', parentSessionId: 'delta-parent',
      parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: 'delta-replay', task: 'delta task', description: 'delta', modelId: 'fixture' })
    await store.appendHeader('tenant-a', 'delta-replay', 'started', { status: 'running', startedAt: 20 })
    const first = (await app.inject({ url: '/subagent/runs/delta-replay/events?format=delta&limit=1', headers: actorA })).json()
    expect(first.code).toBe(200)
    expect(first.data).toMatchObject({ schemaVersion: 2, runId: 'delta-replay', nextSeq: 1, hasMore: true, checkpointRequired: false })
    expect(first.data.events).toHaveLength(1)
    expect(first.data.events[0]).toMatchObject({ schemaVersion: 2, runId: 'delta-replay', seq: 1, baseSeq: 0 })
    const next = (await app.inject({ url: '/subagent/runs/delta-replay/events?format=delta&afterSeq=1&limit=1', headers: actorA })).json().data
    expect(next).toMatchObject({ nextSeq: 2, hasMore: false, checkpointRequired: false })
    expect(next.events.map((event: { seq: number }) => event.seq)).toEqual([2])
    await db.execute({ sql: 'DELETE FROM subagent_events WHERE tenant_id=? AND run_id=? AND seq=?', args: ['tenant-a', 'delta-replay', 2] })
    const gap = (await app.inject({ url: '/subagent/runs/delta-replay/events?format=delta&afterSeq=1&limit=1', headers: actorA })).json()
    expect(gap.code).toBe(200)
    expect(gap.data).toMatchObject({ nextSeq: 1, checkpointRequired: true })
    expect(gap.data.events).toEqual([])
  })

  it('rejects source-mismatched cancellation before mutation and hides all foreign-tenant pages', async () => {
    const mismatch = await app.inject({ method: 'POST', url: '/subagent/runs/run-a1/cancel?view=summary&parentSessionId=other-parent', headers: actorA })
    expect(mismatch.json().code).toBe(40400)
    expect((await store.getRunView('tenant-a', 'run-a1'))!.status).toBe('running')
    for (const suffix of ['?view=summary', '/tools?atSeq=2', '/tools/tool-1?atSeq=2', '/events?format=delta']) {
      const response = (await app.inject({ url: '/subagent/runs/run-b1' + suffix, headers: actorA })).json()
      expect(response).toMatchObject({ code: 40400, data: null })
      expect(JSON.stringify(response)).not.toContain('private task')
    }
  })

  it.each([
    '/subagent/runs?parentSessionId=shared-parent&view=unknown',
    '/subagent/runs?parentSessionId=shared-parent&view=summary&limit=201',
    '/subagent/runs?parentSessionId=shared-parent&limit=1',
    '/subagent/runs/run-a1?view=summary&atSeq=2.5',
    '/subagent/runs/run-a1/tools?atSeq=-1',
    '/subagent/runs/run-a1/tools',
    '/subagent/runs/run-a1/tools?atSeq=2&cursor=forged',
    '/subagent/runs/run-a1/tools/tool-1?atSeq=2&limitBytes=131073',
    '/subagent/runs/run-a1/events?format=unknown',
    '/subagent/runs/run-a1/events?format=delta&afterSeq=9007199254740992',
    '/subagent/runs/run-a1/events?format=delta&limit=0',
  ])('rejects invalid negotiated query %s', async url => {
    expect((await app.inject({ url, headers: actorA })).json().code).toBe(40001)
  })
})

describe('Subagent modern SQLite persistence through HTTP', () => {
  async function modern(runId = 'modern-a1', tools = 2) {
    await store.createRunDelta({ tenantId: 'tenant-a', runId, rootSessionId: 'modern-parent', parentSessionId: 'modern-parent',
      parentConversationId: 'modern-turn', parentMessageId: 'modern-message', parentToolCallId: runId,
      task: 'modern private task', description: 'modern', modelId: 'fixture' })
    await store.appendHeader('tenant-a', runId, 'started', { status: 'running', startedAt: 20 })
    for (let index = 1; index <= tools; index++) {
      await store.upsertTool('tenant-a', runId, 'tool.started', { id: 'modern-tool-' + index, name: 'fixture', args: {
        text: '完整参数'.repeat(800), index,
      }, status: 'running', startedAt: index + 20 })
    }
    return (await store.getRunView('tenant-a', runId))!.lastSeq
  }

  it('pages modern delta tools at a fixed watermark while later completion and creation stay hidden', async () => {
    const atSeq = await modern()
    const first = (await app.inject({ url: '/subagent/runs/modern-a1/tools?atSeq=' + atSeq + '&limit=1', headers: actorA })).json()
    expect(first).toMatchObject({ code: 200, data: { schemaVersion: 2, asOfSeq: atSeq, totalCount: 2, hasMore: true } })
    await store.upsertTool('tenant-a', 'modern-a1', 'tool.completed', { id: 'modern-tool-1', name: 'fixture', status: 'succeeded', output: 'later completion' })
    await store.upsertTool('tenant-a', 'modern-a1', 'tool.started', { id: 'modern-tool-3', name: 'fixture', status: 'running', args: { future: true } })
    const next = (await app.inject({ url: '/subagent/runs/modern-a1/tools?atSeq=' + atSeq + '&limit=1&cursor=' + encodeURIComponent(first.data.nextCursor), headers: actorA })).json()
    expect(next).toMatchObject({ code: 200, data: { asOfSeq: atSeq, totalCount: 2, hasMore: false } })
    expect([...first.data.items, ...next.data.items].map(tool => [tool.id, tool.status])).toEqual([['modern-tool-1', 'running'], ['modern-tool-2', 'running']])
    const exact = (await app.inject({ url: '/subagent/runs/modern-a1?view=summary&atSeq=' + atSeq, headers: actorA })).json().data
    expect(exact).toMatchObject({ lastSeq: atSeq, coverage: { toolCount: 2, activeToolCount: 2 } })
    expect(exact.toolCalls.map((tool: { id: string }) => tool.id)).not.toContain('modern-tool-3')
    expect((await app.inject({ url: '/subagent/runs/modern-a1?view=summary', headers: actorA })).json().data.coverage.toolCount).toBe(3)
    const raw = await db.execute({ sql: 'SELECT event FROM subagent_events WHERE tenant_id=? AND run_id=? ORDER BY seq', args: ['tenant-a', 'modern-a1'] })
    const encoded = raw.rows.map(row => JSON.parse(String(row.event)))
    expect(encoded.every(event => event.schemaVersion === 2 && event.snapshot === undefined)).toBe(true)
    expect(encoded.at(-1).toolUpsert.id).toBe('modern-tool-3')
    expect(String(raw.rows.at(-1)?.event)).not.toContain('modern-tool-2')
  })

  it('keeps full modern arguments and historical output in explicit bounded detail chunks', async () => {
    await modern('modern-detail', 1)
    const output = '完整输出'.repeat(1800)
    const done = await store.upsertTool('tenant-a', 'modern-detail', 'tool.completed', {
      id: 'modern-tool-1', name: 'fixture', status: 'succeeded', output,
    })
    const atSeq = done!.event.seq
    await store.upsertTool('tenant-a', 'modern-detail', 'tool.completed', {
      id: 'modern-tool-1', name: 'fixture', status: 'succeeded', output: 'future output',
    })
    let offset = 0
    const chunks: string[] = []
    for (let guard = 0; guard < 32; guard++) {
      const result = (await app.inject({ url: '/subagent/runs/modern-detail/tools/modern-tool-1?atSeq=' + atSeq + '&offset=' + offset + '&limitBytes=2048', headers: actorA })).json()
      expect(result.code).toBe(200)
      const detail = result.data.detail
      expect(detail.offset).toBe(offset)
      expect(Buffer.byteLength(detail.text)).toBeLessThanOrEqual(2048)
      expect(detail.text).not.toContain('\uFFFD')
      chunks.push(detail.text)
      if (!detail.hasMore) {
        expect(Buffer.byteLength(chunks.join(''))).toBe(detail.totalBytes)
        expect(JSON.parse(chunks.join(''))).toMatchObject({
          args: { text: '完整参数'.repeat(800), index: 1 }, output,
        })
        return
      }
      expect(detail.nextOffset).toBe(offset + Buffer.byteLength(detail.text))
      offset = detail.nextOffset
    }
    throw new Error('Modern detail page failed to finish')
  })

  it('returns a checkpoint requirement for future or deleted exact watermarks, preserving tenant privacy', async () => {
    const atSeq = await modern('modern-missing', 1)
    const future = (await app.inject({ url: '/subagent/runs/modern-missing/tools/modern-tool-1?atSeq=' + (atSeq + 1), headers: actorA })).json()
    expect(future).toMatchObject({ code: 40901, data: { checkpointRequired: true } })
    await db.execute({ sql: 'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?', args: ['tenant-a', 'modern-missing', atSeq] })
    const missing = (await app.inject({ url: '/subagent/runs/modern-missing?view=summary&atSeq=' + atSeq, headers: actorA })).json()
    expect(missing).toMatchObject({ code: 40901, data: { checkpointRequired: true } })
    const foreign = (await app.inject({ url: '/subagent/runs/modern-missing/tools/modern-tool-1?atSeq=' + atSeq, headers: actorB })).json()
    expect(foreign).toMatchObject({ code: 40400, data: null })
  })

  it('preserves explicit legacy complete snapshots while modern events remain versioned deltas in SQLite', async () => {
    const atSeq = await modern('modern-legacy', 2)
    const legacy = (await app.inject({ url: '/subagent/runs/modern-legacy/events?format=legacy', headers: actorA })).json()
    expect(legacy.code).toBe(200)
    expect(legacy.data).toHaveLength(atSeq)
    expect(legacy.data.map((event: SubagentEvent) => [event.schemaVersion, event.seq, event.snapshot?.lastSeq, event.snapshot?.toolCalls.length]))
      .toEqual([[1, 1, 1, 0], [1, 2, 2, 0], [1, 3, 3, 1], [1, 4, 4, 2]])
    const raw = await db.execute({ sql: 'SELECT json_extract(event,\'$.schemaVersion\') AS version FROM subagent_events WHERE tenant_id=? AND run_id=? ORDER BY seq', args: ['tenant-a', 'modern-legacy'] })
    expect(raw.rows.map(row => Number(row.version))).toEqual([2, 2, 2, 2])
  })
})
