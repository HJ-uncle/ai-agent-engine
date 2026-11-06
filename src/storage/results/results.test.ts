/** Real owned roots, private file snapshots and archived final answers; no model/network/UI. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pino } from 'pino'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as database from '../sqlite/db.js'
import { LocalSqliteProcessClient } from '../sqlite/local-process-client.js'
import { RootRunStore, type RootRun } from '../root-runs/index.js'
import { JSONLConversationHistory } from '../conversation/jsonl-history.js'
import { createAgentContext } from '../../core/agent-context/factory.js'
import type { AgentContext } from '../../core/agent-context/types.js'
import { ToolRegistry } from '../../core/tool-registry/index.js'
import { SubagentStore } from '../../core/subagent/store.js'
import { CollaborationRuntime } from '../../core/collaboration/runtime.js'
import { CollaborationStore } from '../../core/collaboration/store.js'
import { ExecutionOwners, type ExecutionOwner } from '../../core/collaboration/execution-owner.js'
import { WorkspaceManager, workspaceManager } from '../../workspace/index.js'
import { ReActStrategy } from '../../core/agent-loop/react.js'
import type { LLMAdapter } from '../../core/llm-adapter/types.js'
import { CurrentTurnProjection, decodeStreamChunk } from '../../core/stream-pipeline/stream-projection.js'
import { FinalResultStore, TOOL_RESULT_IMAGE_ASSETS } from './index.js'
import { resultToolImages } from './tool-images.js'

let dir: string, workspace: string, db: LocalSqliteProcessClient, roots: RootRunStore, root: RootRun
let service: ExecutionOwners, owner: ExecutionOwner, controller: AbortController, ctx: AgentContext, history: JSONLConversationHistory, store: FinalResultStore
const tenant = 'final-result-tenant'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9Y8AAAAASUVORK5CYII=', 'base64')
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`

async function admit(sessionId = 'result-session'): Promise<void> {
  root = await roots.create(tenant, sessionId, 'synthetic', [workspace], { memoryScope: 'off' })
  controller = new AbortController()
  owner = await service.admitRoot({ tenantId: tenant, rootRunId: root.runId, rootAttemptId: (await roots.get(tenant, root.runId))!.attemptId, controller })
  ctx = createAgentContext({ tenantId: tenant, sessionId, workspacePaths: [workspace], projectRoot: workspace,
    scratchDir: path.join(dir, 'scratch', sessionId),
    tools: new ToolRegistry(), history, logger: pino({ level: 'silent' }), executionOwner: owner, signal: controller.signal,
    rootRunId: root.runId, turnId: root.turnId, conversationId: root.turnId, assistantMessageId: root.assistantMessageId })
}
beforeEach(async () => {
  dir = path.resolve('.e2e-tmp', `final-results-${randomUUID()}`); workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace, { recursive: true })
  vi.stubEnv('DATA_DIR', path.join(dir, 'agent.db')); vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', workspace); vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(dir, 'bindings.json'))
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(dir, 'agent.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db)
  roots = new RootRunStore(); await roots.initialize()
  service = new ExecutionOwners(db, new CollaborationRuntime(new CollaborationStore(db), new SubagentStore(db)))
  history = new JSONLConversationHistory(); store = new FinalResultStore()
  const manager = new WorkspaceManager(path.join(dir, 'scratch'))
  manager.bind({ tenantId: tenant, sessionId: 'result-session' }, workspace)
  vi.spyOn(workspaceManager, 'resolveSafePath').mockImplementation((context, name) => manager.resolveSafePath(context, name))
  vi.spyOn(workspaceManager, 'getPaths').mockImplementation(context => manager.getPaths(context))
  await admit()
})
afterEach(async () => {
  const current = await roots.get(tenant, root.runId)
  if (current?.status === 'running') await roots.finishOwned(owner, { status: 'cancelled' })
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  expect((await db.closeWithReceipt()).healthy).toBe(true)
  if (!dir.startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})
function write(name: string, bytes: string | Buffer = PNG): string { const file = path.join(workspace, name); fs.writeFileSync(file, bytes); return file }
async function complete(text = '完成，可以使用。') {
  const result = await store.prepare(ctx, text, root.assistantMessageId)
  if (!result) throw new Error('Missing owned result')
  await history.append({ id: root.assistantMessageId, role: 'assistant', content: text, metadata: { rootRunId: root.runId, turnId: root.turnId, finalResult: result } }, ctx)
  await roots.finishOwned(owner, { status: 'succeeded', stopReason: 'completed' })
  return result
}
async function tool(id: string, output: unknown, metadata: Record<string, unknown> = {}) {
  await history.append({ id: `tool-result:${root.runId}:${id}`, role: 'tool', toolCallId: id, toolName: 'browser_screenshot', content: JSON.stringify(output),
    metadata: { rootRunId: root.runId, turnId: root.turnId, success: true, status: 'succeeded', ...metadata } }, ctx)
}

it('preserves exact image bytes after source deletion and store recreation, but not before final success', async () => {
  const file = write('成品.png'), [item] = await store.stage(ctx, [{ path: file }])
  await expect(store.readAsset(tenant, ctx.sessionId, root.runId, item.assetId, history)).rejects.toThrow('not available')
  fs.unlinkSync(file)
  const result = await complete()
  const restored = new FinalResultStore()
  const read = await restored.readAsset(tenant, ctx.sessionId, root.runId, item.assetId, new JSONLConversationHistory())
  expect(result.items).toEqual([item]); expect(item.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(read).toMatchObject({ path: file, encoding: 'base64', mimeType: 'image/png', totalSize: PNG.length, isBinary: true, sha256: item.sha256 })
  expect(Buffer.from(read.content, 'base64')).toEqual(PNG)
})

it('replaces the entire selection and explicitly clears it instead of accumulating file writes', async () => {
  await store.stage(ctx, [{ path: write('first.png') }, { path: write('second.txt', 'second') }])
  const replacement = await store.stage(ctx, [{ path: path.join(workspace, 'second.txt'), name: '交付.txt' }])
  expect(replacement.map(item => item.name)).toEqual(['交付.txt'])
  await store.stage(ctx, [])
  expect((await complete()).items).toEqual([])
})

it('keeps two versions of the same source path in different turns and does not carry files into plain text', async () => {
  const file = write('report.txt', 'version one'); await store.stage(ctx, [{ path: file }]); const first = await complete()
  await admit(); fs.writeFileSync(file, 'version two'); await store.stage(ctx, [{ path: file }]); const second = await complete()
  expect(first.items[0].sha256).not.toBe(second.items[0].sha256)
  expect(Buffer.from((await store.readAsset(tenant, ctx.sessionId, first.runId, first.items[0].assetId, history)).content, 'base64').toString()).toBe('version one')
  await admit(); const third = await complete('这是纯文字说明。')
  expect(third.items).toEqual([]); expect(third.text).toBe('这是纯文字说明。')
})

it('rejects cross tenant, session, run and unknown asset references', async () => {
  await store.stage(ctx, [{ path: write('result.png') }]); const result = await complete(), item = result.items[0]
  for (const [who, session, run, asset] of [[tenant + '-other', ctx.sessionId, root.runId, item.assetId], [tenant, 'another-session', root.runId, item.assetId],
    [tenant, ctx.sessionId, 'another-run', item.assetId], [tenant, ctx.sessionId, root.runId, 'another-asset']]) {
    await expect(store.readAsset(who, session, run, asset, history)).rejects.toThrow()
  }
})

it('revokes reads after the final assistant is deleted even if a successful root row remains', async () => {
  await store.stage(ctx, [{ path: write('result.png') }]); const result = await complete()
  await history.clear(ctx)
  expect((await roots.get(tenant, root.runId))?.status).toBe('succeeded')
  await expect(store.readAsset(tenant, ctx.sessionId, root.runId, result.items[0].assetId, history)).rejects.toThrow('no longer')
})

it('never publishes a staged or prepared manifest after cancellation and rejects late registration', async () => {
  const file = write('result.png'); const [item] = await store.stage(ctx, [{ path: file }])
  await store.prepare(ctx, '准备完成', root.assistantMessageId)
  controller.abort(new Error('User stop'))
  await roots.finishOwned(owner, { status: 'cancelled' })
  await expect(store.stage(ctx, [{ path: file }])).rejects.toThrow()
  await expect(store.readAsset(tenant, ctx.sessionId, root.runId, item.assetId, history)).rejects.toThrow('not available')
})

it('rejects forged scope, outside files, duplicate paths and over-limit files', async () => {
  const file = write('result.png')
  await expect(store.stage({ ...ctx, sessionId: 'foreign' }, [{ path: file }])).rejects.toThrow('mismatch')
  await expect(store.stage({ ...ctx, executionOwner: undefined }, [{ path: file }])).rejects.toThrow('active root')
  const outside = path.join(dir, 'outside.png'); fs.writeFileSync(outside, PNG)
  await expect(store.stage(ctx, [{ path: outside }])).rejects.toThrow()
  await expect(store.stage(ctx, [{ path: file }, { path: file }])).rejects.toThrow('once')
  const huge = write('huge.bin', ''); fs.truncateSync(huge, 32 * 1024 * 1024 + 1)
  await expect(store.stage(ctx, [{ path: huge }])).rejects.toThrow('32 MiB')
})

it('only an explicitly named successful same-turn tool image becomes a deliverable', async () => {
  await tool('process-shot', { dataUrl: PNG_URL })
  const empty = await store.prepare(ctx, '尚未选择图片', root.assistantMessageId)
  expect(empty?.items).toEqual([])
  await tool('chosen-shot', { content: [{ type: 'text', text: '生成成功' }, { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] })
  const [item] = await store.stage(ctx, [{ toolCallId: 'chosen-shot', imageIndex: 0, name: '最终页面.png' }])
  const result = await complete()
  expect(result.items).toEqual([item]); expect(item.path).toBe('tool-result/chosen-shot/0/最终页面.png')
  expect(Buffer.from((await store.readAsset(tenant, ctx.sessionId, root.runId, item.assetId, history)).content, 'base64')).toEqual(PNG)
})

it('rejects failed, foreign-turn and absent tool image receipts', async () => {
  await tool('failed', { dataUrl: PNG_URL }, { success: false })
  await tool('foreign', { dataUrl: PNG_URL }, { turnId: 'other-turn' })
  await tool('empty', { dataUrlStripped: true })
  for (const toolCallId of ['failed', 'foreign', 'empty', 'missing']) await expect(store.stage(ctx, [{ toolCallId }])).rejects.toThrow()
  expect(resultToolImages({ dataUrl: 'https://example.com/image.png' })).toEqual([])
  expect(resultToolImages({ dataUrl: 'data:image/png;base64,aGVsbG8=' })).toEqual([])
})

it('retains an explicitly selected tool image after its large text envelope is truncated', async () => {
  const retained = await store.retainToolImages(ctx, 'large-image', JSON.stringify({ content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] }))
  await tool('large-image', '[large tool output truncated]', { [TOOL_RESULT_IMAGE_ASSETS]: retained })
  const [item] = await store.stage(ctx, [{ toolCallId: 'large-image' }]); await complete()
  expect(Buffer.from((await store.readAsset(tenant, ctx.sessionId, root.runId, item.assetId, history)).content, 'base64')).toEqual(PNG)
})

it('retains the accepted selection across a permission park while rejecting the revoked attempt', async () => {
  const file = write('result.png'), [item] = await store.stage(ctx, [{ path: file }]), old = ctx
  const pending = { kind: 'ask' as const, requestId: 'answer', toolCallId: 'answer', toolName: 'ask_user', args: {}, question: 'Confirm' }
  await roots.finishOwned(owner, { status: 'waiting' }, pending)
  await roots.answer(tenant, root.sessionId, root.runId, pending.requestId, pending.toolCallId, pending.toolName, 'yes')
  controller = new AbortController()
  owner = await service.admitRoot({ tenantId: tenant, rootRunId: root.runId, rootAttemptId: (await roots.get(tenant, root.runId))!.attemptId, controller })
  ctx = { ...ctx, executionOwner: owner, signal: controller.signal }
  await expect(store.stage(old, [])).rejects.toThrow()
  expect((await complete()).items).toEqual([item])
})

it('emits an explicit pure-text final result only after the archived answer and successful root settlement', async () => {
  const llm = { model: 'synthetic', provider: 'mock', complete: vi.fn(), stream: async function* () {
    yield { content: '可以直接使用。', done: true, finishReason: 'stop' as const, promptTokens: 10, completionTokens: 5 }
  } } as unknown as LLMAdapter
  ctx.runObserver = { onOutcome: async outcome => {
    const archived = await history.getMessageById(root.assistantMessageId, tenant, ctx.sessionId)
    expect(archived?.metadata?.finalResult.text).toBe('可以直接使用。')
    expect(archived?.metadata?.finalResult.items).toEqual([])
    await roots.finishOwned(owner, { status: outcome.status === 'succeeded' ? 'succeeded' : 'failed' })
  } }
  const frames: string[] = []
  for await (const frame of new ReActStrategy(llm).run('给一个简短说明', ctx)) {
    if (frame.startsWith('\x00__final_result__')) expect((await roots.get(tenant, root.runId))?.status).toBe('succeeded')
    frames.push(frame)
  }
  const resultFrames = frames.filter(frame => frame.startsWith('\x00__final_result__'))
  expect(resultFrames).toHaveLength(1)
  const projection = new CurrentTurnProjection()
  projection.apply(decodeStreamChunk(resultFrames[0])!)
  expect(JSON.stringify(projection.snapshot())).toContain('可以直接使用。')
})

it('withholds the final frame and asset when cancellation wins the final assistant persistence race', async () => {
  const [item] = await store.stage(ctx, [{ path: write('result.png') }])
  const llm = { model: 'synthetic', provider: 'mock', complete: vi.fn(), stream: async function* () {
    yield { content: '候选最终回复', done: true, finishReason: 'stop' as const, promptTokens: 10, completionTokens: 5 }
  } } as unknown as LLMAdapter
  ctx.runObserver = { onOutcome: async () => {
    controller.abort(new Error('User stopped at settlement'))
    await roots.finishOwned(owner, { status: 'succeeded' })
  } }
  const frames: string[] = []
  for await (const frame of new ReActStrategy(llm).run('生成成品', ctx)) frames.push(frame)
  expect((await roots.get(tenant, root.runId))?.status).toBe('cancelled')
  expect(frames.filter(frame => frame.startsWith('\x00__final_result__'))).toEqual([])
  await expect(store.readAsset(tenant, ctx.sessionId, root.runId, item.assetId, history)).rejects.toThrow('not available')
})
