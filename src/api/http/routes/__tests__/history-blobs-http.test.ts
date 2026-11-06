import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { up as createTodoTables } from '../../../../storage/sqlite/migrations/006_add_todos_cron.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import { rootRunStore, type RootRun } from '../../../../storage/root-runs/index.js'
import type { AgentContext, Message } from '../../../../core/agent-context/types.js'
import { largeNativePng } from '../../../../core/utils/__tests__/fixtures/native-image.js'
import { searchHistoryTool } from '../../../../tools/get-context/search-history-tool.js'
import { persistedTurnProjection } from '../../chat-snapshot.js'
import { StreamBus, activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { conversationRoutes } from '../conversation.js'
import { chatRoutes } from '../chat.js'

vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'c3'.repeat(32) })
const ctx = { tenantId: 'blob-http-tenant', sessionId: 'blob-http-session' }
const image = largeNativePng()
const longText = 'BLOB_HTTP_EVIDENCE 原始正文与工具参数必须完整保留。\n'.repeat(800)
const toolOutput = JSON.stringify({ filename: 'original.png', mimeType: 'image/png', dataUrl: image.url, hasDataUrl: true, description: longText })
const displayedImage: Message['content'] = [{ type: 'text', text: longText }, { type: 'image_url', image_url: { url: image.url } }]
let fixture: string, db: LocalSqliteProcessClient, app: FastifyInstance
let history: ReturnType<typeof createConversationHistory>, run: RootRun
let bus: StreamBus | undefined

function assertNoStorageFields(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const item of value) assertNoStorageFields(item); return }
  const object = value as Record<string, unknown>
  expect(object).not.toHaveProperty('storageBlobs')
  expect(object).not.toHaveProperty('archiveReference')
  for (const item of Object.values(object)) assertNoStorageFields(item)
}

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-blob-http-'))
  vi.stubEnv('DATA_DIR', path.join(fixture, 'agent.db'))
  vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  vi.stubEnv('WORKSPACE_ROOT', path.join(fixture, 'workspaces'))
  db = new LocalSqliteProcessClient({ url: `file:${path.join(fixture, 'agent.db')}` })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await createTodoTables(db)
  history = createConversationHistory()
  run = await rootRunStore.create(ctx.tenantId, ctx.sessionId, 'fixture-model', [], {})
  await history.append({ id: run.userMessageId, role: 'user', content: displayedImage,
    modelInputContent: [{ type: 'text', text: 'PRIVATE_MODEL_CONTEXT ' + longText }, { type: 'image_url', image_url: { url: image.url } }],
    metadata: { caption: longText }, conversationId: run.turnId } as Message, ctx)
  await history.append({ id: 'tool-dispatch', role: 'assistant', content: '', reasoningContent: longText,
    toolCall: { id: 'image-call', name: 'read_file', args: { script: longText } }, conversationId: run.turnId } as Message, ctx)
  await history.append({ id: 'image-result', role: 'tool', content: toolOutput, toolCallId: 'image-call', toolName: 'read_file',
    metadata: { success: true }, conversationId: run.turnId } as Message, ctx)
  await history.append({ id: run.assistantMessageId, role: 'assistant', content: 'Completed: ' + longText, conversationId: run.turnId } as Message, ctx)
  run = (await rootRunStore.update(ctx.tenantId, run.runId, { status: 'succeeded' }))!
  // A new registered route history must recover from physical JSONL + gzip files, not the writer's cache.
  app = Fastify({ ajv: { customOptions: { allowUnionTypes: true } } })
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId: request.headers['x-tenant'] ?? ctx.tenantId } }) })
  await app.register(conversationRoutes)
  await app.register(chatRoutes)
  await app.ready()
})

afterEach(async () => {
  if (bus?.disconnectTimeout) clearTimeout(bus.disconnectTimeout)
  bus?.abortController.abort(); bus?.end(); bus = undefined
  activeStreams.delete(`${ctx.tenantId}:${ctx.sessionId}`)
  await app?.close()
  db?.close()
  if (db) await db.whenClosed()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  const resolved = path.resolve(fixture)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-blob-http-')) throw new Error('Unsafe blob HTTP fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function get(route: string) {
  const response = await app.inject({ method: 'GET', url: `${route}${route.includes('?') ? '&' : '?'}sessionId=${ctx.sessionId}` })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().code).toBe(200)
  assertNoStorageFields(response.json())
  expect(response.body).not.toContain('PRIVATE_MODEL_CONTEXT')
  return response.json()
}

function transcriptRows(): any[] {
  return fs.readFileSync(path.join(fixture, 'sessions', ctx.tenantId, ctx.sessionId + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

function assertPublicBodies(messages: Message[]) {
  expect(messages.find(message => message.id === run.userMessageId)?.content).toEqual(displayedImage)
  expect(messages.find(message => message.id === run.userMessageId)).not.toHaveProperty('modelInputContent')
  expect(messages.find(message => message.id === 'tool-dispatch')).toMatchObject({ reasoningContent: longText, toolCall: { args: { script: longText } } })
  expect(messages.find(message => message.id === 'image-result')?.content).toBe(toolOutput)
  expect(messages.find(message => message.id === run.assistantMessageId)?.content).toBe('Completed: ' + longText)
}

describe('public HTTP history over real externalized JSONL', () => {
  it('hydrates history, complete/paged archives and snapshots without exposing private references', async () => {
    const physical = transcriptRows()
    const user = physical.find(row => row.uuid === run.userMessageId)
    expect(user.storageBlobs.refs.length).toBeGreaterThan(0)
    expect(user.payload.content[1].image_url.url).toBeNull()
    expect(fs.readdirSync(path.join(fixture, 'blobs'), { recursive: true }).some(file => String(file).endsWith('.gz'))).toBe(true)
    assertPublicBodies((await get('/conversation/history')).data)
    assertPublicBodies((await get('/conversation/archive')).data)
    assertPublicBodies((await get('/conversation/archive?current=1&pageSize=20')).data)
    const snapshot = (await get('/chat/snapshot')).data
    expect(snapshot.source).toBe('persisted')
    assertPublicBodies(snapshot.history)
    const turn = await app.inject({ method: 'GET', url: `/conversations/${run.turnId}` })
    expect(turn.statusCode).toBe(200)
    expect(turn.json().code).toBe(200)
    assertNoStorageFields(turn.json())
    expect(turn.json().data.find((message: Message) => message.id === run.userMessageId).content).toEqual(displayedImage)
    // This older turn API intentionally keeps its existing provider-snapshot field contract.
    expect(turn.json().data.find((message: Message) => message.id === run.userMessageId).modelInputContent[1].image_url.url).toBe(image.url)
    const foreign = await app.inject({ method: 'GET', url: `/conversation/archive?sessionId=${ctx.sessionId}`, headers: { 'x-tenant': 'another-tenant' } })
    expect(foreign.json().data).toEqual([])
    expect(foreign.body).not.toContain(image.base64)
  })

  it('keeps compacted original images retrievable through archive/search and recovered tool-result projections', async () => {
    expect((await history.microCompactToolResults!(ctx, { keepRecent: 0 })).cleared).toBe(1)
    expect(transcriptRows().some(row => row.archiveReference?.messageId === 'image-result')).toBe(true)
    const current = (await get('/conversation/history')).data as Message[]
    expect(current.find(message => message.id === 'image-result')?.content).not.toBe(toolOutput)
    const archive = (await get('/conversation/archive?current=1&pageSize=20')).data as Message[]
    expect(archive.find(message => message.id === 'image-result')?.content).toBe(toolOutput)
    // Search is a builtin tool, not a separate HTTP route. Exercise that actual public tool contract.
    const coldHistory = createConversationHistory()
    const toolCtx = { ...ctx, history: coldHistory } as AgentContext
    const search = await searchHistoryTool.execute({ query: 'BLOB_HTTP_EVIDENCE' }, toolCtx)
    expect(search.success).toBe(true)
    expect(JSON.parse(search.output).messages.some((message: any) => message.messageId === 'image-result')).toBe(true)
    assertNoStorageFields(JSON.parse(search.output))
    const recovered = await searchHistoryTool.execute({ messageId: 'image-result', imageIndex: 0 }, toolCtx)
    expect(recovered.success).toBe(true)
    expect(JSON.parse(recovered.output).dataUrl).toBe(image.url)
    expect(Buffer.from(JSON.parse(recovered.output).dataUrl.split(',')[1], 'base64')).toEqual(image.buffer)
    assertNoStorageFields(JSON.parse(recovered.output))
    const projection = persistedTurnProjection((await coldHistory.getArchive!(ctx)).messages, run)
    expect((projection.find(frame => (frame.toolResult as any)?.toolCallId === 'image-call')?.toolResult as any)?.output).toBe(toolOutput)
    assertNoStorageFields(projection)
    bus = new StreamBus(new AbortController())
    activeStreams.set(`${ctx.tenantId}:${ctx.sessionId}`, bus)
    bus.push('\x00__run__' + JSON.stringify(run))
    bus.push('\x00__tool_result__' + JSON.stringify({ toolCallId: 'search-image', name: 'search_history', output: recovered.output }))
    bus.end()
    const snapshot = (await get('/chat/snapshot')).data
    expect(snapshot.source).toBe('live')
    const output = snapshot.projection.find((frame: any) => frame.toolResult?.toolCallId === 'search-image').toolResult.output
    expect(JSON.parse(output).dataUrl).toBe(image.url)
  })

  it('keeps an already hydrated cache exact, while cold/archive/search reads fail explicitly on damaged blobs', async () => {
    // Prime both body and usage caches before changing only a blob, leaving JSONL revision unchanged.
    await get('/conversation/history')
    await get('/chat/snapshot')
    const original = await history.getFullHistory(ctx)
    const user = transcriptRows().find(row => row.uuid === run.userMessageId)
    const reference = user.storageBlobs.refs.find((ref: any) => JSON.stringify(ref.path) === JSON.stringify(['payload', 'content', 1, 'image_url', 'url']))
    const file = path.join(fixture, 'blobs', user.storageBlobs.tenant, reference.hash.slice(0, 2), reference.hash + '.gz')
    fs.writeFileSync(file, 'damaged evidence')
    expect(await history.getFullHistory(ctx)).toEqual(original)
    assertPublicBodies((await get('/conversation/history')).data)
    assertPublicBodies((await get('/chat/snapshot')).data.history)
    const archived = await app.inject({ method: 'GET', url: `/conversation/archive?sessionId=${ctx.sessionId}&current=1&pageSize=20` })
    expect(archived.statusCode).toBe(500)
    expect(archived.json()).not.toHaveProperty('data')
    await expect(createConversationHistory().getFullHistory(ctx)).rejects.toThrow()
    const search = await searchHistoryTool.execute({ messageId: run.userMessageId, imageIndex: 0 }, { ...ctx, history: createConversationHistory() } as AgentContext)
    expect(search.success).toBe(false)
    expect(search.output).toMatch(/^History search failed:/)
  })
})
