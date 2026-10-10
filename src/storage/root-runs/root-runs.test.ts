import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../sqlite/db.js'
import { RootRunStore } from './index.js'
import { createConversationHistory } from '../conversation/factory.js'
import { withHistoryLock, bindHistoryGeneration, invalidateSessionHistory } from '../conversation/serialization.js'

let fixture: string
let db: Client
let store: RootRunStore
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-d3-runs-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  db = createClient({ url: `file:${path.join(fixture, 'agent.db')}` })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  store = new RootRunStore()
})
afterEach(() => {
  db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
})

const pending = { requestId: 'approve-1', toolCallId: 'approve-1', kind: 'permission' as const,
  toolName: 'execute_cmd', args: { command: 'node', args: ['--version'] }, question: 'Run command?' }

describe('durable root run identity and pending claims', () => {
  it('rejects competing turns and assigns distinct stable IDs to repeated user text', async () => {
    const first = await store.create('tenant', 'session', 'model-A', ['workspace-A'], { message: '继续', model: 'model-A' })
    await expect(store.create('tenant', 'session', 'model-B', [], { message: '继续' })).rejects.toThrow('already has')
    await store.update('tenant', first.runId, { status: 'succeeded' })
    const second = await store.create('tenant', 'session', 'model-A', [], { message: '继续' })
    expect(second.seq).toBeGreaterThan(first.seq)
    expect(new Set([first.runId, first.turnId, first.userMessageId, second.runId, second.turnId, second.userMessageId]).size).toBe(6)
    await store.deleteTurns('tenant', 'session', [second.turnId])
    expect((await store.list('tenant', 'session')).map(run => run.turnId)).toEqual([first.turnId])
  })

  it('atomically accepts one approval, rejects conflicting or foreign answers, and never persists credentials', async () => {
    const run = await store.create('tenant', 'session', 'model-A', ['workspace-A'], {
      model: 'model-A', modelApiKey: 'SECRET-1', extraHeaders: { authorization: 'SECRET-2' },
      metadata: { apiKey: 'SECRET-3', harmless: 'retained' }, workspacePaths: ['workspace-A'],
    })
    await store.pending('tenant', run.runId, pending)
    await expect(store.answer('other', 'session', run.runId, pending.requestId, pending.toolCallId, pending.toolName, 'approved')).rejects.toThrow('not found')
    await expect(store.answer('tenant', 'other', run.runId, pending.requestId, pending.toolCallId, pending.toolName, 'approved')).rejects.toThrow('not found')
    const claims = await Promise.all([1, 2, 3].map(() => store.answer('tenant', 'session', run.runId, pending.requestId, pending.toolCallId, pending.toolName, 'approved')))
    expect(claims.filter(claim => !claim.duplicate)).toHaveLength(1)
    await expect(store.answer('tenant', 'session', run.runId, pending.requestId, pending.toolCallId, pending.toolName, 'rejected')).rejects.toThrow('differently')
    expect((await store.get('tenant', run.runId))?.request).toEqual({ model: 'model-A', metadata: { harmless: 'retained' }, workspacePaths: ['workspace-A'] })
    expect(JSON.stringify((await db.execute('SELECT state FROM root_runs')).rows)).not.toContain('SECRET')
    expect((await store.list('tenant', 'session'))[0]).not.toHaveProperty('request')
  })

  it('survives reopening: waiting can be answered but prior running work is interrupted without reexecution', async () => {
    const running = await store.create('tenant', 'running', 'model-A', [], {})
    const waiting = await store.create('tenant', 'waiting', 'model-A', ['workspace-A'], { model: 'model-A', memoryScope: 'session', thinkingMode: 'medium', skills: [], mcpServers: ['mcp-A'], utilityModel: '' })
    await store.update('tenant', waiting.runId, { actualModelId: 'fallback-B' })
    await store.pending('tenant', waiting.runId, pending)
    db.close()
    db = createClient({ url: `file:${path.join(fixture, 'agent.db')}` })
    store = new RootRunStore()
    await store.initialize()
    expect(await store.get('tenant', running.runId)).toMatchObject({ status: 'interrupted', error: { code: 'ENGINE_RESTARTED' } })
    expect(await store.get('tenant', waiting.runId)).toMatchObject({ status: 'waiting', modelId: 'model-A', actualModelId: 'fallback-B',
      request: { model: 'model-A', memoryScope: 'session', thinkingMode: 'medium', skills: [], mcpServers: ['mcp-A'], utilityModel: '' }, workspacePaths: ['workspace-A'], pending: [{ status: 'pending' }] })
    const accepted = await store.answer('tenant', 'waiting', waiting.runId, pending.requestId, pending.toolCallId, pending.toolName, 'approved')
    expect(accepted).toMatchObject({ duplicate: false, run: { status: 'running', modelId: 'model-A', actualModelId: 'fallback-B',
      turnId: waiting.turnId, userMessageId: waiting.userMessageId,
      requestConfig: { memoryScope: 'session', thinkingMode: 'medium', skills: [], mcpServers: ['mcp-A'], utilityModel: '' } } })
  })

  it('publishes only safe requested composer values and preserves omitted versus explicitly empty resources', async () => {
    const run = await store.create('tenant', 'session', 'model-A', [], {
      agentId: 'agent-A', thinkingMode: false, subagentModel: 'sub-A', utilityModel: '',
      skills: [], mcpServers: ['mcp-A'], memoryScope: 'off',
      modelBaseUrl: 'https://SECRET-endpoint', systemPrompt: 'SECRET-system',
      inlineSkills: [{ name: 'SECRET-inline', content: 'SECRET-body' }],
      inlineAgents: [{ apiKey: 'SECRET-key', prompt: 'SECRET-prompt' }], metadata: { harmless: 'SECRET-metadata' },
    })
    expect(run.requestConfig).toEqual({ agentId: 'agent-A', thinkingMode: false, subagentModel: 'sub-A', utilityModel: '', skills: [], mcpServers: ['mcp-A'], memoryScope: 'off' })
    expect(run.requestConfig).not.toHaveProperty('knowledgeBases')
    expect(JSON.stringify(run)).not.toContain('SECRET')
    // A persisted unsolicited public config must not bypass the private-request whitelist.
    await store.update('tenant', run.runId, { requestConfig: { knowledgeBases: ['injected'] }, status: 'succeeded' })
    expect((await store.list('tenant', 'session'))[0].requestConfig).toEqual(run.requestConfig)
    const next = await store.create('tenant', 'session', 'model-A', [], { knowledgeBases: [], thinkingMode: true })
    expect(next.requestConfig).toEqual({ knowledgeBases: [], thinkingMode: true })
    expect(next.requestConfig).not.toHaveProperty('skills')
    expect(next.requestConfig).not.toHaveProperty('memoryScope')
  })

  it.each([true, false, 'low', 'medium', 'high'] as const)('retains exact thinking value %s through pending approval', async thinkingMode => {
    const run = await store.create('tenant', 'session', 'model-A', [], { thinkingMode, memoryScope: 'session' })
    await store.pending('tenant', run.runId, pending)
    const answered = await store.answer('tenant', 'session', run.runId, pending.requestId, pending.toolCallId, pending.toolName, 'approved')
    expect(answered.run.requestConfig).toEqual({ thinkingMode, memoryScope: 'session' })
    expect((await store.get('tenant', run.runId))?.request).toEqual({ thinkingMode, memoryScope: 'session' })
  })

  it('prevents an old waiting attempt from overwriting an immediate answer or cancellation', async () => {
    const run = await store.create('tenant', 'session', 'model-A', [], {})
    const attemptId = (await store.get('tenant', run.runId))!.attemptId
    await store.pending('tenant', run.runId, pending, attemptId)
    await store.answer('tenant', 'session', run.runId, pending.requestId, pending.toolCallId, pending.toolName, 'approved')
    expect(await store.update('tenant', run.runId, { status: 'waiting' }, attemptId)).toBeNull()
    expect((await store.get('tenant', run.runId))!.status).toBe('running')
    await store.update('tenant', run.runId, { status: 'cancelled' })
    expect(await store.update('tenant', run.runId, { status: 'waiting' })).toBeNull()
    expect((await store.get('tenant', run.runId))!.status).toBe('cancelled')
  })
})

describe('history serialization across instances', () => {
  it('serializes compaction, concurrent appends and truncate across separately created consumers', async () => {
    // No source database rows; JSONL is the configured backend.
    const historyA = createConversationHistory()
    const historyB = createConversationHistory()
    const ctx = { tenantId: 'tenant', sessionId: 'session' }
    for (let i = 0; i < 8; i++) await historyA.append({ id: `m${i}`, role: 'user', content: `message ${i}`, tokens: 10 }, ctx)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const compact = historyA.compress(ctx, async () => { entered(); await gate; return 'Keep the critical constraint' }, 4)
    await started
    const append = historyB.append({ id: 'new', role: 'user', content: 'new after compact', tokens: 10 }, ctx)
    release()
    await Promise.all([compact, append])
    expect((await historyB.getFullHistory(ctx)).map(message => message.id)).toContain('new')
    const last = await historyA.getMessageById('new', ctx.tenantId)
    await withHistoryLock(ctx.tenantId, async () => {
      await historyA.deleteMessagesAfterId(last!.dbId, ctx.sessionId, ctx.tenantId)
      await historyA.deleteMessage('new', ctx.tenantId)
    })
    expect((await historyB.getFullHistory(ctx)).map(message => message.id)).not.toContain('new')
    expect((await historyB.getFullHistory(ctx)).some(message => String(message.content).includes('critical constraint'))).toBe(true)
  })

  it('does not append a queued write after cancellation and history clear', async () => {
    const history = bindHistoryGeneration(createConversationHistory(), 'tenant', 'session')
    const controller = new AbortController()
    const ctx = { tenantId: 'tenant', sessionId: 'session', signal: controller.signal }
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocker = withHistoryLock(ctx.tenantId, async () => { entered(); await gate })
    await started
    const append = history.append({ id: 'late', role: 'assistant', content: 'late' }, ctx)
    const check = expect(append).rejects.toThrow('may no longer append')
    invalidateSessionHistory(ctx.tenantId, ctx.sessionId)
    controller.abort(); release()
    await blocker; await check
    expect(await history.getFullHistory(ctx)).toEqual([])
  })
})
