import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LLMAdapter, LLMAdapterOptions } from '../../core/llm-adapter/types.js'
import { hasValidInstanceToken } from '../instance-token.js'

let app: FastifyInstance
let baseUrl: string
let fixture: string
let closeDb: () => void
const token = 'd0-test-instance-token-not-a-production-secret'
const authenticated = { 'X-Aether-Instance-Token': token, 'X-Aether-Tool-Profile': 'code' }
const modelRequests: LLMAdapterOptions[] = []

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-instance-http-'))
  for (const [key, value] of Object.entries({
    DATA_DIR: path.join(fixture, 'agent.db'), WORKSPACE_ROOT: path.join(fixture, 'workspace'),
    AETHER_GLOBAL_DIR: path.join(fixture, 'global'), SKILLS_ROOT: path.join(fixture, 'skills'),
    PUBLIC_DIR: path.join(fixture, 'absent-public'), LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false',
    AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: token, ENABLE_LONG_TERM_MEMORY: 'false',
    ENCRYPTION_KEY: '1'.repeat(64), LLM_MODEL: 'd0-fixture', LLM_PRIMARY_MODEL: 'd0-fixture',
  })) vi.stubEnv(key, value)
  fs.mkdirSync(path.join(fixture, 'workspace'), { recursive: true })
  fs.mkdirSync(path.join(fixture, 'skills'), { recursive: true })
  // Only disable unrelated background schedulers and the model transport; routes/auth/profile/loop/storage are real.
  const { SQLiteTaskQueue } = await import('../../storage/task-queue/sqlite-queue.js')
  vi.spyOn(SQLiteTaskQueue.prototype, 'start').mockImplementation(() => {})
  const { cronScheduler } = await import('../../scheduler/cron-scheduler.js')
  vi.spyOn(cronScheduler, 'start').mockImplementation(() => {})
  const models = await import('../../core/llm-adapter/resolve-model.js')
  const adapter: LLMAdapter = {
    model: 'd0-fixture', provider: 'openai', countTokens: text => Math.ceil(text.length / 4),
    complete: async () => { throw new Error('Unexpected model completion') },
    async *stream(_messages, options) {
      if (options) modelRequests.push(options)
      yield { done: false, content: 'Authenticated code profile reached the model.' }
      yield { done: true, finishReason: 'stop', promptTokens: 10, completionTokens: 5, model: 'd0-fixture' }
    },
  }
  vi.spyOn(models, 'createAdapterFromResolved').mockReturnValue(adapter)
  const database = await import('../../storage/sqlite/db.js')
  closeDb = database.closeDb
  await database.initDb()
  const { buildServer } = await import('../../api/http/server.js')
  app = await buildServer()
  await app.ready()
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
}, 30_000)

afterAll(async () => {
  await app?.close()
  closeDb?.()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (fixture) {
    if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-instance-http-')) throw new Error('Unsafe fixture path')
    try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }) }
    catch (error) {
      // libsql can retain Windows native handles until the worker exits.
      if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
    }
  }
})

describe('D0 owned instance handshake and route gate', () => {
  it('keeps only health/meta public and returns cwd-independent identity without secrets', async () => {
    const first = await app.inject({ method: 'GET', url: '/meta' })
    expect(first.statusCode).toBe(200)
    const identity = first.json().data
    expect(identity).toMatchObject({ protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1 })
    expect(identity.buildId).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(identity.version).not.toBe('unknown')
    expect(identity.instanceId).toMatch(/^[a-f0-9-]{36}$/)
    expect(first.body).not.toContain(token)
    expect(Object.keys(identity).sort()).toEqual(['buildId', 'instanceId', 'protocolVersion', 'subagentSchemaVersion', 'toolProfiles', 'version'])
    const originalCwd = process.cwd()
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"version":"incorrect-cwd-package"}')
    try {
      process.chdir(fixture)
      expect((await app.inject({ method: 'GET', url: '/meta?probe=1' })).json().data).toEqual(identity)
      expect((await app.inject({ method: 'GET', url: '/health?probe=1' })).statusCode).toBe(200)
    } finally { process.chdir(originalCwd) }
  })

  it.each([
    ['GET', '/api/v1/tools'], ['GET', '/api/v1/models'], ['GET', '/api/v1/security/mode?sessionId=fixture'],
    ['GET', '/api/v1/chat/stream?sessionId=fixture'], ['POST', '/api/v1/chat'],
    ['POST', '/api/v1/chat/cancel'], ['GET', '/api/v1/subagent/runs?parentSessionId=fixture'],
    ['GET', '/metrics'], ['GET', '/openapi.json'], ['GET', '/auth/user'],
  ] as const)('rejects missing/wrong token on %s %s even with AUTH_ENABLED=false', async (method, url) => {
    for (const headers of [{}, { 'X-Aether-Instance-Token': 'incorrect' }]) {
      const response = await app.inject({ method, url, headers })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toMatchObject({ code: 40100, data: null })
      expect(response.body).not.toContain(token)
    }
  })

  it('accepts the token without widening the HTTP code profile', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/tools', headers: authenticated })
    expect(response.statusCode).toBe(200)
    expect(response.json().code).toBe(200)
    const names = response.json().data.map((tool: { name: string }) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['read_file', 'execute_cmd', 'subagent']))
    expect(names).not.toContain('remember')
    expect(names).not.toContain('agent_list')
  })

  it('accepts authenticated POST chat SSE and retains code tools in the actual model request', async () => {
    // Use a real loopback response: LightMyRequest has no ServerResponse.setTimeout used by the SSE sink.
    const response = await fetch(`${baseUrl}/api/v1/chat`, { method: 'POST',
      headers: { ...authenticated, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'd0-chat-fixture', message: 'Describe the fixture.', model: 'd0-fixture',
        modelApiKey: 'fixture-only', modelProvider: 'openai', workspacePaths: [path.join(fixture, 'workspace')] }),
      signal: AbortSignal.timeout(10_000) })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(body).toContain('event: done')
    expect(body).toContain('Authenticated code')
    expect(modelRequests).toHaveLength(1)
    const names = modelRequests[0].tools?.map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['read_file', 'execute_cmd', 'subagent']))
    expect(names).not.toContain('remember')
    expect(names).not.toContain('agent_list')
    expect(body).not.toContain(token)
  })

  it('preserves standalone behavior only when the instance token is unset', async () => {
    vi.stubEnv('AETHER_INSTANCE_TOKEN', undefined)
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/chat/status?sessionId=standalone-fixture' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ code: 200, data: { running: false } })
    } finally { vi.stubEnv('AETHER_INSTANCE_TOKEN', token) }
    expect(hasValidInstanceToken({ 'x-aether-instance-token': [token, token] }, token)).toBe(false)
    expect(hasValidInstanceToken({}, '')).toBe(false)
  })

  it('cancels an accepted approval before its execution starts without running the command or model', async () => {
    const { rootRunStore } = await import('../../storage/root-runs/index.js')
    const sessionId = 'd3-cancel-accepted-approval'
    const marker = path.join(fixture, 'workspace', 'must-not-execute.txt')
    const run = await rootRunStore.create('default', sessionId, 'd0-fixture', [path.join(fixture, 'workspace')], {
      model: 'd0-fixture', modelProvider: 'openai', toolProfile: 'code',
    })
    await rootRunStore.pending('default', run.runId, { requestId: 'command-approval', toolCallId: 'command-approval',
      toolName: 'execute_cmd', kind: 'permission', args: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`] } })
    let accepted!: () => void
    let release!: () => void
    const claimed = new Promise<void>(resolve => { accepted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalAnswer = rootRunStore.answer.bind(rootRunStore)
    const spy = vi.spyOn(rootRunStore, 'answer').mockImplementation(async (...args) => {
      const answer = await originalAnswer(...args)
      accepted(); await gate
      return answer
    })
    const requestCount = modelRequests.length
    try {
      const answerResponse = fetch(`${baseUrl}/api/v1/chat`, { method: 'POST',
        headers: { ...authenticated, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: '', toolResponse: { runId: run.runId, requestId: 'command-approval',
          toolCallId: 'command-approval', name: 'execute_cmd', output: 'approved' } }), signal: AbortSignal.timeout(15_000) })
      await claimed
      const cancel = await app.inject({ method: 'POST', url: '/api/v1/chat/cancel', headers: authenticated, payload: { sessionId } })
      expect(cancel.json().data.cancelled).toBe(true)
      release()
      const response = await answerResponse
      const body = await response.text()
      expect(body).toContain('"status":"cancelled"')
      expect(body).not.toContain('toolResult')
      expect((await rootRunStore.get('default', run.runId))?.status).toBe('cancelled')
      expect(modelRequests).toHaveLength(requestCount)
      expect(fs.existsSync(marker)).toBe(false)
      const { createConversationHistory } = await import('../../storage/conversation/factory.js')
      expect(await createConversationHistory().getFullHistory({ tenantId: 'default', sessionId })).toEqual([])
    } finally { release(); spy.mockRestore() }
  })

  it('honors stop while a chat is preparing before its run or controller exists', async () => {
    const { rootRunStore } = await import('../../storage/root-runs/index.js')
    const sessionId = 'd3-cancel-preparing'
    let entered!: () => void
    let release!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalCreate = rootRunStore.create.bind(rootRunStore)
    const spy = vi.spyOn(rootRunStore, 'create').mockImplementation(async (...args) => {
      entered(); await gate
      return originalCreate(...args)
    })
    const requestCount = modelRequests.length
    try {
      const response = fetch(`${baseUrl}/api/v1/chat`, { method: 'POST',
        headers: { ...authenticated, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: 'Must not start after stop', model: 'd0-fixture', modelProvider: 'openai' }),
        signal: AbortSignal.timeout(15_000) })
      await preparing
      await app.inject({ method: 'POST', url: '/api/v1/chat/cancel', headers: authenticated, payload: { sessionId } })
      release()
      expect(await (await response).text()).toContain('"status":"cancelled"')
      expect(modelRequests).toHaveLength(requestCount)
      expect((await rootRunStore.list('default', sessionId))[0].status).toBe('cancelled')
    } finally { release(); spy.mockRestore() }
  })

  it('waits for a claimed turn snapshot without blocking cancellation or returning the previous finished bus', async () => {
    const { rootRunStore } = await import('../../storage/root-runs/index.js')
    const { StreamBus, activeStreams } = await import('../../core/stream-pipeline/stream-bus.js')
    const sessionId = 'd4-cancel-during-snapshot-admission'
    const key = `default:${sessionId}`
    const previous = await rootRunStore.create('default', sessionId, 'd0-fixture', [], {})
    const previousFinished = await rootRunStore.update('default', previous.runId, { status: 'succeeded' })
    const previousBus = new StreamBus(new AbortController())
    previousBus.push('\x00__run__' + JSON.stringify(previousFinished))
    previousBus.push('Previous finished answer must not become the current turn')
    previousBus.end()
    activeStreams.set(key, previousBus)

    let entered!: () => void
    let release!: () => void
    let createdRunId!: string
    const claimed = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalCreate = rootRunStore.create.bind(rootRunStore)
    const spy = vi.spyOn(rootRunStore, 'create').mockImplementation(async (...args) => {
      const run = await originalCreate(...args)
      createdRunId = run.runId
      entered()
      await gate
      return run
    })
    const requestCount = modelRequests.length
    let snapshotSettled = false
    let snapshotEntered!: () => void
    const snapshotReceived = new Promise<void>(resolve => { snapshotEntered = resolve })
    const onRequest = (request: import('node:http').IncomingMessage) => {
      if (request.url === `/api/v1/chat/snapshot?sessionId=${sessionId}`) snapshotEntered()
    }
    app.server.on('request', onRequest)
    let chatResponse: Promise<Response> | undefined
    let snapshotResponse: Promise<Response> | undefined
    try {
      chatResponse = fetch(`${baseUrl}/api/v1/chat`, { method: 'POST',
        headers: { ...authenticated, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: 'Cancel the newly claimed turn', model: 'd0-fixture', modelProvider: 'openai' }),
        signal: AbortSignal.timeout(10_000) })
      await claimed
      snapshotResponse = fetch(`${baseUrl}/api/v1/chat/snapshot?sessionId=${sessionId}`, {
        headers: authenticated, signal: AbortSignal.timeout(10_000),
      }).then(response => { snapshotSettled = true; return response })
      await snapshotReceived

      // Cancellation must pass while the snapshot awaits admission; holding a history
      // lock during this wait would deadlock until the explicit gate below is released.
      const cancel = await fetch(`${baseUrl}/api/v1/chat/cancel`, { method: 'POST',
        headers: { ...authenticated, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(3_000) })
      expect(cancel.status).toBe(200)
      expect(await cancel.json()).toMatchObject({ data: { cancelled: true } })
      expect(snapshotSettled).toBe(false)
      expect((await rootRunStore.get('default', createdRunId))?.status).toBe('cancelled')

      release()
      const stream = await chatResponse
      expect(await stream.text()).toContain('"status":"cancelled"')
      const snapshot = await snapshotResponse
      expect(snapshot.status).toBe(200)
      const state = (await snapshot.json()).data
      expect(state.run).toMatchObject({ runId: createdRunId, status: 'cancelled' })
      expect(state.run.runId).not.toBe(previous.runId)
      expect(state.runs).toHaveLength(2)
      expect(state.projection.some((payload: { content?: string }) => payload.content?.includes('Previous finished answer'))).toBe(false)
      expect(modelRequests).toHaveLength(requestCount)
    } finally {
      release()
      spy.mockRestore()
      app.server.off('request', onRequest)
      await Promise.allSettled([chatResponse, snapshotResponse].filter(Boolean))
      const retained = activeStreams.get(key)
      if (retained?.disconnectTimeout) clearTimeout(retained.disconnectTimeout)
      retained?.abortController.abort()
      retained?.end()
      activeStreams.delete(key)
    }
  }, 15_000)
})
