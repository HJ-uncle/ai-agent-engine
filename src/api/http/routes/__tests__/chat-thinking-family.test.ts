/** Actual chat route + model resolution + Anthropic SDK; fetch is wholly synthetic. */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { ModelsStore } from '../../../../storage/sqlite/models.js'
import { activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { chatRoutes } from '../chat.js'

vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'd3'.repeat(32) })
let directory: string, app: FastifyInstance, db: LocalSqliteProcessClient
let requests: Record<string, unknown>[]
const endpoint = 'https://fixture.aliyuncs.invalid/apps/anthropic'
beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true })
  directory = fs.mkdtempSync(path.resolve('.e2e-tmp/chat-thinking-family-'))
  for (const [name, value] of Object.entries({ DATA_DIR: path.join(directory, 'fixture.db'), WORKSPACE_ROOT: directory,
    MEMORY_DB_PATH: path.join(directory, 'memory.db'), AETHER_GLOBAL_DIR: path.join(directory, 'global'), SKILLS_ROOT: path.join(directory, 'skills'),
    ENABLE_LONG_TERM_MEMORY: 'false', OSM_MODE: 'off', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false',
    LLM_FALLBACK_MODEL: '', LLM_SUMMARIZE_MODEL: '', HISTORY_BACKEND: 'jsonl' })) vi.stubEnv(name, value)
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  await database.initDb()
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (_input, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    requests.push(body)
    const message = { id: 'synthetic-reply', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 } }
    if (!body.stream) return new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json' } })
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hello.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }))
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request, reply) => {
    Object.assign(request, { authContext: { tenantId: 'default' } })
    reply.raw.setTimeout = () => reply.raw
  })
  await app.register(chatRoutes)
})
afterEach(async () => {
  for (const [key, bus] of activeStreams) {
    if (bus.disconnectTimeout) clearTimeout(bus.disconnectTimeout)
    await bus.endOrdered()
    activeStreams.delete(key)
  }
  await app.close()
  await database.closeDb()
  expect((await db.closeWithReceipt()).healthy).toBe(true)
  await (await import('../../../../storage/memory/db.js')).closeMemoryDb()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('chat-thinking-family-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe('chat thinking family on an Aliyun Anthropic endpoint', () => {
  it.each([
    { model: 'deepseek-v4.1-flash-1017', provider: 'deepseek', thinkingMode: 'low' as const, expected: { reasoning_effort: 'low' } },
    { model: 'deepseek-v4.1-flash-1017', provider: 'anthropic', thinkingMode: 'low' as const, expected: { reasoning_effort: 'low' } },
    { model: 'private-deployment', provider: 'deepseek', thinkingMode: 'low' as const, expected: { reasoning_effort: 'low' } },
    { model: 'qwen3.8-flash', provider: 'qwen', thinkingMode: 'low' as const, expected: { enable_thinking: true } },
    { model: 'private-deployment', provider: 'custom', thinkingMode: 'low' as const, expected: { enable_thinking: true } },
    { model: 'deepseek-v4.1-flash-1017', provider: 'deepseek', thinkingMode: false as const, expected: { thinking: { type: 'disabled' } } },
  ])('sends the selected $model/$provider/$thinkingMode contract at the actual adapter boundary', async ({ model, provider, thinkingMode, expected }) => {
    await new ModelsStore().createModel({ tenantId: 'default', provider, modelId: model, apiKey: 'synthetic-fixture-key',
      baseUrl: endpoint, isEnabled: true, capabilities: { thinking: true, contextWindow: 128000 } })
    const response = await app.inject({ method: 'POST', url: '/chat',
      headers: { 'x-aether-tool-profile': 'code', 'x-aether-run-lifetime': 'durable' },
      payload: { sessionId: 'thinking-family-session', message: 'Hello.', model, thinkingMode,
        workspacePaths: [directory], memoryScope: 'off', skills: [], mcpServers: [], knowledgeBases: [] } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.body).toContain('Hello.')
    const rootRequest = requests.find(request => request.stream === true && request.model === model)
    expect(rootRequest).toBeDefined()
    const thinking = Object.fromEntries(Object.entries(rootRequest!).filter(([key]) => ['thinking', 'enable_thinking', 'reasoning_effort'].includes(key)))
    expect(thinking).toEqual(expected)
  })
})
