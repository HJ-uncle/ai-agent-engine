import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, closeDb, getDb } from '../../../../storage/sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { closeMemoryDb } from '../../../../storage/memory/db.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { ReActStrategy } from '../../../../core/agent-loop/index.js'
import { StreamBus, activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { chatRoutes, unregisterActiveChat } from '../chat.js'
import type { Message } from '../../../../core/agent-context/types.js'

const tenantId = 'usage-continuation-tenant', sessionId = 'usage-continuation-session'
const ctx = { tenantId, sessionId }
let fixture: string, base: string, app: FastifyInstance
let history: ReturnType<typeof createConversationHistory>
type StoredMessage = Message & { conversationId?: string }
const append = (message: StoredMessage, target = ctx) => history.append(message, target)

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-chat-usage-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  vi.stubEnv('MEMORY_DB_PATH', path.join(fixture, 'memory.db'))
  vi.stubEnv('MCP_CONFIG_PATH', path.join(fixture, 'mcp.json'))
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(fixture, 'global'))
  vi.stubEnv('SKILLS_ROOT', path.join(fixture, 'skills'))
  vi.stubEnv('WORKSPACE_ROOT', fixture)
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  vi.stubEnv('LLM_PRIMARY_MODEL', 'fixture-model')
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key')
  vi.stubEnv('QA_LOG_ENABLED', 'false')
  fs.mkdirSync(path.join(fixture, 'skills'))
  await initDb()
  history = createConversationHistory()
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId } }) })
  await app.register(chatRoutes)
  base = await app.listen({ host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  const bus = activeStreams.get(`${tenantId}:${sessionId}`)
  if (bus?.disconnectTimeout) clearTimeout(bus.disconnectTimeout)
  bus?.abortController.abort(); bus?.end()
  if (bus) unregisterActiveChat(tenantId, sessionId, bus.abortController)
  activeStreams.delete(`${tenantId}:${sessionId}`)
  await app?.close()
  const db = getDb() as LocalSqliteProcessClient
  closeDb()
  await Promise.all([closeMemoryDb(), db.whenClosed()])
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-chat-usage-')) {
    throw new Error('Unsafe chat usage cleanup')
  }
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function usages(body: string): Array<Record<string, unknown>> {
  return body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
    .filter(frame => frame.usage).map(frame => frame.usage)
}

describe('HTTP durable turn usage across approval attempts', () => {
  it.each([false, true])('keeps persisted billing across a resumed attempt (old stream retained: %s)', async retained => {
    const old = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [fixture], {})
    await rootRunStore.update(tenantId, old.runId, { status: 'succeeded' })
    await append({ id: 'unrelated-old-turn', role: 'assistant', content: 'prior turn', conversationId: old.turnId,
      usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } }, ctx)
    const run = await rootRunStore.create(tenantId, sessionId, 'fixture-model', [fixture], {
      toolProfile: 'code', memoryScope: 'off', model: 'fixture-model', skills: [], mcpServers: [], knowledgeBases: [],
    })
    await append({ id: run.userMessageId, role: 'user', content: 'continue task', conversationId: run.turnId, tokens: 3 }, ctx)
    await append({ id: 'prior-call-a', role: 'assistant', content: 'first step', conversationId: run.turnId,
      usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 } }, ctx)
    await append({ id: 'prior-call-b', role: 'assistant', content: 'needs approval', conversationId: run.turnId,
      usage: { promptTokens: 15, completionTokens: 3, totalTokens: 18, currentPromptTokens: 22_000, contextWindow: 100_000 } }, ctx)
    await history.compress(ctx, async () => 'earlier work retained in archive', 1)
    const waiting = await rootRunStore.pending(tenantId, run.runId, {
      requestId: 'approval-request', toolCallId: 'ask-tool', toolName: 'ask_user', kind: 'ask', args: {}, question: 'Continue?',
    })
    if (retained) {
      const bus = new StreamBus(new AbortController())
      // A divergent seeded projection must never become a second billing source.
      bus.push('\x00__usage__' + JSON.stringify({ promptTokens: 35, completionTokens: 7, totalTokens: 42,
        currentPromptTokens: 22_000, contextWindow: 100_000 }))
      bus.push('\x00__run__' + JSON.stringify(waiting))
      bus.end()
      activeStreams.set(`${tenantId}:${sessionId}`, bus)
    }
    const strategy = vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_prompt, agentCtx) {
      yield '\x00__usage__' + JSON.stringify({ modelId: 'fixture-model' })
      await agentCtx.history.append({ id: 'resumed-call-a', role: 'assistant', content: 'resumed first step',
        conversationId: agentCtx.turnId, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } } as StoredMessage, agentCtx)
      yield '\x00__usage__' + JSON.stringify({ promptTokens: 10, completionTokens: 2, totalTokens: 12,
        currentPromptTokens: 12_000, contextWindow: 100_000, modelId: 'fixture-model' })
      await agentCtx.history.append({ id: agentCtx.assistantMessageId, role: 'assistant', content: 'resumed task complete',
        conversationId: agentCtx.turnId, usage: { promptTokens: 15, completionTokens: 3, totalTokens: 18,
          currentPromptTokens: 10_000, contextWindow: 100_000 } } as StoredMessage, agentCtx)
      await agentCtx.runObserver?.onOutcome?.({ status: 'succeeded', stopReason: 'completed' })
      yield '\x00__usage__' + JSON.stringify({ promptTokens: 25, completionTokens: 5, totalTokens: 30,
        currentPromptTokens: 10_000, contextWindow: 100_000, modelId: 'fixture-model', conversationId: agentCtx.assistantMessageId })
      yield 'resumed task complete'
    })
    const response = await fetch(base + '/chat', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-aether-tool-profile': 'code',
    }, body: JSON.stringify({ message: '', sessionId, toolResponse: {
      runId: run.runId, requestId: 'approval-request', toolCallId: 'ask-tool', name: 'ask_user', output: 'continue',
    } }), signal: AbortSignal.timeout(10_000) })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    const frames = usages(body), numeric = frames.filter(frame => typeof frame.promptTokens === 'number')
    expect(numeric).toHaveLength(2)
    expect(numeric[0]).toMatchObject({ promptTokens: 45, completionTokens: 9, totalTokens: 54, currentPromptTokens: 12_000 })
    expect(numeric[1]).toMatchObject({ promptTokens: 60, completionTokens: 12, totalTokens: 72,
      currentPromptTokens: 10_000, contextWindow: 100_000, contextModelId: 'fixture-model' })
    expect(frames[0].contextModelId).toBeUndefined()
    for (const frame of frames) expect(frame).toMatchObject({ sessionId, runId: run.runId, turnId: run.turnId,
      usageScope: 'turn', attemptId: expect.any(String) })
    expect(new Set(frames.map(frame => frame.attemptId)).size).toBe(1)
    expect(await history.getSessionUsage(ctx, run.turnId)).toMatchObject({ promptTokens: 60, completionTokens: 12, totalTokens: 72 })
    const snapshot = (await app.inject(`/chat/snapshot?sessionId=${sessionId}`)).json().data
    expect(snapshot.projection.find((frame: Record<string, unknown>) => frame.usage)?.usage).toMatchObject(numeric[1])
    expect(strategy).toHaveBeenCalledOnce()
    // Re-sending the same answer replays durable state without another model call or usage addition.
    const duplicate = await fetch(base + '/chat', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-aether-tool-profile': 'code',
    }, body: JSON.stringify({ sessionId, toolResponse: {
      runId: run.runId, requestId: 'approval-request', toolCallId: 'ask-tool', name: 'ask_user', output: 'continue',
    } }), signal: AbortSignal.timeout(10_000) })
    expect(duplicate.status, await duplicate.text()).toBe(200)
    expect(strategy).toHaveBeenCalledOnce()
    expect(await history.getSessionUsage(ctx, run.turnId)).toMatchObject({ totalTokens: 72 })
  }, 20_000)
})
