// Fastify protocol boundary contracts independent from the durable store implementation.
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { subagentRoutes } from '../subagent.js'
import * as stores from '../../../../core/subagent/store.js'
import * as runners from '../../../../core/subagent/runner.js'

const run = { schemaVersion: 2, view: 'summary', runId: 'child', tenantId: 'tenant-a',
  parentSessionId: 'parent', rootSessionId: 'root', lastSeq: 8, status: 'running' }
let app: FastifyInstance
const mockStore = {
  getRun: vi.fn(async () => { throw new Error('LIVE_PATH_USED_FULL_LEGACY_RUN') }),
  listRunsForParent: vi.fn(async () => { throw new Error('LIVE_PATH_USED_FULL_LEGACY_LIST') }),
  listEvents: vi.fn(async () => { throw new Error('LIVE_PATH_USED_FULL_LEGACY_EVENTS') }),
  getRunView: vi.fn(async () => run),
  listRunViewsPage: vi.fn(async () => ({ schemaVersion: 2, runs: [run], listComplete: false, hasMore: true, revision: 'revision', nextCursor: 'opaque' })),
  listToolsPage: vi.fn(async () => ({ schemaVersion: 2, runId: 'child', asOfSeq: 8, items: [], totalCount: 10, hasMore: true, nextCursor: 'tool-cursor' })),
  getToolDetail: vi.fn(async () => ({ schemaVersion: 2, runId: 'child', asOfSeq: 8, tool: { id: 'tool' }, detail: { encoding: 'json-utf8', text: '{}', offset: 0, totalBytes: 2, hasMore: false } })),
  listEventsPage: vi.fn(async () => ({ schemaVersion: 2, runId: 'child', events: [], nextSeq: 8, hasMore: false, checkpointRequired: true })),
}
const cancel = vi.fn(async () => ({ ...run, status: 'cancelling' }))

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(stores, 'getSubagentStore').mockReturnValue(mockStore as unknown as stores.SubagentStore)
  vi.spyOn(runners, 'getSubagentRunner').mockReturnValue({ cancel } as unknown as runners.SubagentRunner)
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => {
    ;(request as FastifyRequest & { authContext: { tenantId: string } }).authContext = { tenantId: 'tenant-a' }
  })
  await app.register(subagentRoutes)
})
afterEach(async () => { await app.close(); vi.restoreAllMocks() })

describe('Subagent HTTP protocol negotiation', () => {
  it('routes all negotiated live reads through bounded store methods with authenticated identity', async () => {
    for (const url of [
      '/subagent/runs?parentSessionId=parent&view=summary&limit=7&cursor=page',
      '/subagent/runs/child?view=summary',
      '/subagent/runs/child/tools?atSeq=8&limit=7&cursor=tools',
      '/subagent/runs/child/tools/tool?atSeq=8&offset=0&limitBytes=128',
      '/subagent/runs/child/events?format=delta&afterSeq=8&limit=7',
    ]) expect((await app.inject(url)).json().code).toBe(200)
    expect(mockStore.listRunViewsPage).toHaveBeenCalledWith('tenant-a', 'parent', { limit: 7, cursor: 'page' })
    expect(mockStore.listToolsPage).toHaveBeenCalledWith('tenant-a', 'child', { atSeq: 8, limit: 7, cursor: 'tools' })
    expect(mockStore.getToolDetail).toHaveBeenCalledWith('tenant-a', 'child', 'tool', { atSeq: 8, offset: 0, limitBytes: 128 })
    expect(mockStore.listEventsPage).toHaveBeenCalledWith('tenant-a', 'child', { afterSeq: 8, limit: 7 })
    expect(mockStore.getRun).not.toHaveBeenCalled()
    expect(mockStore.listRunsForParent).not.toHaveBeenCalled()
    expect(mockStore.listEvents).not.toHaveBeenCalled()
  })
  it('rejects a mismatched source before cancellation or durable page access', async () => {
    expect((await app.inject({ method: 'POST', url: '/subagent/runs/child/cancel?view=summary&parentSessionId=other' })).json().code).toBe(40400)
    expect((await app.inject('/subagent/runs/child/tools?atSeq=8&rootSessionId=other')).json().code).toBe(40400)
    expect(cancel).not.toHaveBeenCalled()
    expect(mockStore.listToolsPage).not.toHaveBeenCalled()
  })
  it('advertises the explicit capabilities contract and rejects unsupported selectors and unbounded pages', async () => {
    expect((await app.inject('/subagent/capabilities')).json().data).toEqual({
      schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'],
      toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true,
      activeDiscovery: true, lifecycleChanges: true, discoveryProtocol: 1,
    })
    for (const url of [
      '/subagent/runs?parentSessionId=parent&view=summary&limit=100000',
      '/subagent/runs/child/events?format=delta&afterSeq=-1',
      '/subagent/runs/child/events?format=other',
      '/subagent/runs/child/tools/tool?atSeq=8&limitBytes=1000000',
      '/subagent/runs/child?view=other',
    ]) expect((await app.inject(url)).json().code).toBe(40001)
  })
})
