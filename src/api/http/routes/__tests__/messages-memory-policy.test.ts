/** Legacy edit/regenerate use current durable scopes and isolate retained streams by tenant. No provider is called. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { messagesRoutes } from '../messages.js'
import { initDb, closeDb } from '../../../../storage/sqlite/db.js'
import { closeMemoryDb } from '../../../../storage/memory/db.js'
import { setMemoryPreferences, setSessionMemoryEnabled, getSessionMemorySettings } from '../../../../storage/memory/settings.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { ReActStrategy } from '../../../../core/agent-loop/index.js'
import type { AgentContext, Message } from '../../../../core/agent-context/types.js'
import { ToolRegistry } from '../../../../core/tool-registry/index.js'
import { StreamBus, activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { resolveCapabilities } from '../../../../core/model-capabilities/index.js'
import * as resolver from '../../../../core/llm-adapter/resolve-model.js'
import * as factory from '../../../../tools/registry-factory.js'
import * as memoryRuntime from '../../../../middleware/memory/index.js'

const tenants = ['legacy-memory-a', 'legacy-memory-b']
const sessionId = 'same-legacy-session'
let directory: string, app: FastifyInstance, contexts: AgentContext[]
beforeEach(async () => {
  directory = path.resolve('.e2e-tmp', 'legacy-memory-' + randomUUID()); fs.mkdirSync(directory, { recursive: true })
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(directory, 'agent.db'), MEMORY_DB_PATH: path.join(directory, 'memory.db'),
    WORKSPACE_ROOT: path.join(directory, 'scratch'), AETHER_GLOBAL_DIR: path.join(directory, 'global'), SKILLS_ROOT: path.join(directory, 'skills'),
    HISTORY_BACKEND: 'sqlite', ENABLE_LONG_TERM_MEMORY: 'true', OSM_MODE: 'off', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false' })) vi.stubEnv(key, value)
  await initDb(); contexts = []
  vi.spyOn(factory, 'createToolRegistry').mockResolvedValue({ registry: new ToolRegistry(), externalSkills: [], toolCategories: { builtinTools: [], mcpTools: [], skillTools: [] } })
  vi.spyOn(resolver, 'resolveModelConfig').mockResolvedValue({ model: 'fixture', provider: 'fixture', capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }) })
  vi.spyOn(resolver, 'createAdapterFromResolved').mockImplementation(() => ({ model: 'fixture', provider: 'fixture', countTokens: text => Math.ceil(text.length / 4),
    complete: async () => { throw new Error('NO_PROVIDER_EXPECTED') }, async *stream() { throw new Error('NO_PROVIDER_EXPECTED') } }))
  vi.spyOn(memoryRuntime, 'buildMemoryRecallBlock').mockResolvedValue('')
  vi.spyOn(memoryRuntime, 'extractAndStoreMemories').mockResolvedValue({ extracted: 0, stored: 0, errors: [] })
  vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_prompt, ctx) { contexts.push(ctx); yield 'CURRENT LEGACY POLICY' })
  const history = createConversationHistory()
  for (const tenantId of tenants) {
    await setMemoryPreferences(tenantId, { globalEnabled: false, sessionDefaultEnabled: false })
    await setSessionMemoryEnabled(tenantId, sessionId, false)
    const userMessage: Message & { conversationId: string } = { id: `user-${tenantId}`, role: 'user', content: 'Original', conversationId: `turn-${tenantId}`, metadata: { memoryScope: 'global', memoryScopes: ['global', 'session'] } }
    const assistantMessage: Message & { conversationId: string } = { id: `assistant-${tenantId}`, role: 'assistant', content: 'Previous output', conversationId: `turn-${tenantId}` }
    await history.append(userMessage, { tenantId, sessionId })
    await history.append(assistantMessage, { tenantId, sessionId })
  }
  app = Fastify(); app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request, reply) => {
    Object.assign(request, { authContext: { tenantId: request.headers['x-fixture-tenant'] ?? tenants[0] } })
    reply.raw.setTimeout = () => reply.raw
  })
  await app.register(messagesRoutes)
})
afterEach(async () => {
  for (const tenantId of tenants) { const key = `${tenantId}:${sessionId}`; activeStreams.get(key)?.end(); activeStreams.delete(key) }
  await app?.close()
  for (const receipt of await Promise.all([closeDb(), closeMemoryDb()])) if (receipt) expect(receipt.healthy).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
function regenerate(tenantId = tenants[0]) {
  return app.inject({ method: 'POST', url: `/messages/assistant-${tenantId}/regenerate`, headers: { 'x-fixture-tenant': tenantId },
    payload: { memoryScopes: ['global', 'session'], metadata: { memoryScope: 'global', memoryScopes: ['global', 'session'] } } })
}

it.each(['edit', 'regenerate'])('%s ignores forged array and old metadata policy while honoring current disabled settings', async operation => {
  const result = operation === 'edit'
    ? await app.inject({ method: 'PUT', url: `/messages/user-${tenants[0]}`, payload: { content: 'Edited', memoryScopes: ['global', 'session'] } })
    : await regenerate()
  expect(result.statusCode, result.body).toBe(200); expect(result.body).toContain('CURRENT LEGACY POLICY')
  expect(contexts).toHaveLength(1); expect(contexts[0]).toMatchObject({ tenantId: tenants[0], sessionId, memoryScope: 'off', memoryScopes: [] })
  expect(factory.createToolRegistry).toHaveBeenCalledWith(expect.objectContaining({ memoryScope: 'off', memoryScopes: [] }))
  expect(memoryRuntime.buildMemoryRecallBlock).not.toHaveBeenCalled(); expect(memoryRuntime.extractAndStoreMemories).not.toHaveBeenCalled()
  expect(await getSessionMemorySettings(tenants[0], sessionId)).toMatchObject({ sessionOverride: false, globalEnabled: false, effectiveScopes: [] })
})
it('retains equal-named sessions independently and an old expiry cannot evict a successor', async () => {
  const timers = vi.spyOn(globalThis, 'setTimeout')
  try {
    expect((await regenerate()).statusCode).toBe(200)
    expect((await regenerate(tenants[1])).statusCode).toBe(200)
    const firstKey = `${tenants[0]}:${sessionId}`, secondKey = `${tenants[1]}:${sessionId}`
    const first = activeStreams.get(firstKey), second = activeStreams.get(secondKey)
    expect(first).toBeDefined(); expect(second).toBeDefined(); expect(first).not.toBe(second)
    expect(activeStreams.has(sessionId)).toBe(false)
    const successor = new StreamBus(new AbortController())
    activeStreams.set(firstKey, successor)
    const expiries = timers.mock.calls.filter(call => call[1] === 60000)
    expect(expiries).toHaveLength(2)
    const expireFirst = expiries[0][0], expireSecond = expiries[1][0]
    if (typeof expireFirst !== 'function' || typeof expireSecond !== 'function') throw new Error('Stream expiry callbacks required')
    expireFirst(); expect(activeStreams.get(firstKey)).toBe(successor); expect(activeStreams.get(secondKey)).toBe(second)
    expireSecond(); expect(activeStreams.has(secondKey)).toBe(false); expect(activeStreams.get(firstKey)).toBe(successor)
  } finally {
    timers.mock.calls.forEach((call, index) => {
      const result = timers.mock.results[index]
      if (call[1] === 60000 && result.type === 'return') clearTimeout(result.value)
    })
  }
})
