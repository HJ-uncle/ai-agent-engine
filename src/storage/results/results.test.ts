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
import { SubagentRunner } from '../../core/subagent/runner.js'
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
let service: ExecutionOwners, owner: ExecutionOwner, controller: AbortController, ctx: AgentContext, history: JSONLConversationHistory, store: FinalResultStore, manager: WorkspaceManager
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
  manager = new WorkspaceManager(path.join(dir, 'scratch'))
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

async function inChild<T>(action: (child: AgentContext) => Promise<T>, readOnly = false): Promise<T> {
  const parentToolCallId = randomUUID(), parentMessageId = randomUUID()
  await history.append({ id: parentMessageId, role: 'assistant', content: '', conversationId: root.turnId,
    toolCall: { id: parentToolCallId, name: 'subagent', args: {} } }, ctx)
  let result!: T, thrown: unknown
  const run = await new SubagentRunner(new SubagentStore(db)).run({ tenantId: tenant, rootSessionId: ctx.sessionId,
    parentSessionId: ctx.sessionId, parentConversationId: root.turnId, parentMessageId, parentToolCallId,
    task: 'Prepare an artifact', description: 'Fixture producer', modelId: 'synthetic',
    continuation: { readOnly, systemPrompt: '', toolNames: ['report_artifacts'], workspacePaths: ctx.workspacePaths ?? [], projectRoot: ctx.projectRoot },
  }, ctx, async execution => {
    const child = createAgentContext({ tenantId: tenant, sessionId: execution.snapshot.childSessionId,
      parentSessionId: ctx.sessionId, rootSessionId: ctx.sessionId, rootRunId: root.runId, turnId: root.turnId, runId: execution.snapshot.runId,
      tools: new ToolRegistry(), history, logger: pino({ level: 'silent' }), workspacePaths: ctx.workspacePaths, projectRoot: ctx.projectRoot,
      scratchDir: path.join(dir, 'scratch', execution.snapshot.childSessionId),
      executionOwner: execution.executionOwner, signal: execution.signal })
    child.currentToolCallId = 'report-call'
    manager.inheritChildWorkspace(child, ctx, [...(ctx.workspacePaths ?? []), ...(ctx.projectRoot ? [ctx.projectRoot] : [])])
    try { result = await action(child); await execution.observer.onOutcome({ status: 'succeeded', output: 'Candidate artifacts prepared' }) }
    catch (error) { thrown = error; await execution.observer.onOutcome({ status: 'failed', error: { code: 'FIXTURE_ACTION', message: String(error), retryable: false } }) }
  })
  if (thrown) throw thrown
  expect(run.status).toBe('succeeded')
  return result
}

it('adopts immutable child artifact bytes and truthful producer identity after source changes', async () => {
  const file = write('child-report.txt', 'verified child version')
  const report = await inChild(child => store.report(child, [{ path: file }]))
  const source = report.items[0]
  fs.writeFileSync(file, 'unverified newer bytes')
  const [adopted] = await store.stage(ctx, [{ childSessionId: report.childSessionId, runId: report.runId, artifactId: source.assetId }])
  expect(adopted).toMatchObject({ producerChildSessionId: report.childSessionId, producerRunId: report.runId,
    producerArtifactId: source.assetId, sha256: source.sha256 })
  expect(adopted.assetId).not.toBe(source.assetId)
  await complete()
  const bytes = await store.readAsset(tenant, ctx.sessionId, root.runId, adopted.assetId, history)
  expect(Buffer.from(bytes.content, 'base64').toString()).toBe('verified child version')
})

it('keeps a reported artifact across database reopen and later parent turns without its source file', async () => {
  const file = write('child-memory.txt', 'retained after restart')
  const report = await inChild(child => store.report(child, [{ path: file }]))
  await complete('The file is a candidate, not yet delivered.')
  fs.unlinkSync(file)
  expect((await db.closeWithReceipt()).healthy).toBe(true)
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(dir, 'agent.db').replaceAll('\\', '/') })
  roots = new RootRunStore(); await roots.initialize()
  service = new ExecutionOwners(db, new CollaborationRuntime(new CollaborationStore(db), new SubagentStore(db)))
  store = new FinalResultStore(); history = new JSONLConversationHistory()
  await admit()
  const [adopted] = await store.stage(ctx, [{ childSessionId: report.childSessionId, runId: report.runId, artifactId: report.items[0].assetId }])
  await complete()
  const bytes = await store.readAsset(tenant, ctx.sessionId, root.runId, adopted.assetId, history)
  expect(Buffer.from(bytes.content, 'base64').toString()).toBe('retained after restart')
})

it.each(['runs', 'parent'] as const)('cleans child report metadata on %s deletion while preserving adopted parent assets', async mode => {
  const file = write('adopted-child.txt', 'parent adopted bytes')
  const report = await inChild(child => store.report(child, [{ path: file }]))
  const [adopted] = await store.stage(ctx, [{ childSessionId: report.childSessionId, runId: report.runId, artifactId: report.items[0].assetId }])
  await complete()
  const children = new SubagentStore(db)
  if (mode === 'runs') await children.deleteRuns(tenant, [report.runId])
  else await children.deleteRunsForParent(tenant, ctx.sessionId)
  expect((await db.execute({ sql: 'SELECT 1 FROM child_artifact_manifests WHERE tenant_id=? AND run_id=?', args: [tenant, report.runId] })).rows).toEqual([])
  expect(await children.getRunHeader(tenant, report.runId)).toBeNull()
  fs.unlinkSync(file)
  const retained = await store.readAsset(tenant, ctx.sessionId, root.runId, adopted.assetId, history)
  expect(Buffer.from(retained.content, 'base64').toString()).toBe('parent adopted bytes')
})

it('deduplicates the exact child report invocation and rejects conflicting retry contents', async () => {
  const file = write('child-report.txt', 'one version')
  await inChild(async child => {
    const first = await store.report(child, [{ path: file }])
    fs.writeFileSync(file, 'a newer version')
    expect(await store.report(child, [{ path: file }])).toEqual(first)
    await expect(store.report(child, [{ path: file, name: 'changed.txt' }])).rejects.toThrow('different input')
  })
})

it('rejects stale versions, root reporting, research reporting and forged child scope', async () => {
  const file = write('child-report.txt', 'one version')
  await expect(store.report(ctx, [{ path: file }])).rejects.toThrow('owner mismatch')
  await inChild(async child => {
    await expect(store.report(child, [{ path: file, expectedHash: 'sha256:' + '0'.repeat(64) }])).rejects.toThrow('version changed')
    await expect(store.report({ ...child, sessionId: 'forged' }, [{ path: file }])).rejects.toThrow('owner mismatch')
    await expect(store.stage(child, [{ path: file }])).rejects.toThrow()
    const outside = path.join(dir, 'outside-child.txt'); fs.writeFileSync(outside, 'outside')
    await expect(store.report(child, [{ path: outside }])).rejects.toThrow()
  })
  await inChild(async child => {
    await expect(store.report(child, [{ path: file }])).rejects.toThrow('not allowed')
  }, true)
})

it('rejects adopting another child, run, tenant or parent session as artifact provenance', async () => {
  const report = await inChild(child => store.report(child, [{ path: write('owned-child.txt', 'owned') }]))
  const input = { childSessionId: report.childSessionId, runId: report.runId, artifactId: report.items[0].assetId }
  for (const patch of [{ childSessionId: 'foreign' }, { runId: 'foreign' }, { artifactId: 'foreign' }]) {
    await expect(store.stage(ctx, [{ ...input, ...patch }])).rejects.toThrow()
  }
  await expect(store.stage({ ...ctx, tenantId: 'foreign' }, [input])).rejects.toThrow()
  await complete()
  await admit('another-parent')
  await expect(store.stage(ctx, [input])).rejects.toThrow('does not belong')
})

it('does not adopt old child files outside the current parent binding even in full access mode', async () => {
  vi.stubEnv('AUTH_ENABLED', 'true')
  vi.stubEnv('DEFAULT_SECURITY_MODE', 'full-access')
  const file = write('previous-project.txt', 'reported version')
  const report = await inChild(child => store.report(child, [{ path: file }]))
  const replacement = path.join(workspace, 'new-project'); fs.mkdirSync(replacement)
  manager.bind(ctx, replacement)
  await expect(store.stage(ctx, [{ childSessionId: report.childSessionId, runId: report.runId,
    artifactId: report.items[0].assetId }])).rejects.toThrow('outside the current parent workspace')
})

it('inherits authenticated parent files only through a live child owner and revokes stale workspace access', async () => {
  vi.stubEnv('AUTH_ENABLED', 'true')
  write('shared-source.txt', 'parent project')
  let oldChild: AgentContext | undefined
  await inChild(async child => {
    oldChild = child
    expect(manager.getWorkingDirectory(child)).toBe(fs.realpathSync(workspace))
    expect(fs.readFileSync(manager.resolveSafePath(child, 'shared-source.txt'), 'utf8')).toBe('parent project')
    expect(manager.getPaths(child)).toContain(fs.realpathSync(workspace))
    expect(() => manager.resolveSafePath(child, path.join(dir, 'foreign.txt'))).toThrow('outside')
    expect(() => manager.getWorkingDirectory({ ...child, parentSessionId: 'forged-parent' })).toThrow('owner mismatch')
    const unowned = { ...child, executionOwner: undefined }
    expect(manager.getWorkingDirectory(unowned)).not.toBe(fs.realpathSync(workspace))
    const replacement = path.join(workspace, 'replacement'); fs.mkdirSync(replacement)
    manager.bind(ctx, replacement)
    expect(() => manager.resolveSafePath(child, 'shared-source.txt')).toThrow('binding changed')
    manager.bind(ctx, workspace)
  })
  expect(oldChild).toBeDefined()
  expect(() => manager.getWorkingDirectory(oldChild!)).toThrow()
  await expect(store.report(oldChild!, [{ path: path.join(workspace, 'shared-source.txt') }])).rejects.toThrow()
})

it.each(['true', 'false'])('shares the parent default scratch workspace when auth is %s without making another workspace binding', async auth => {
  vi.stubEnv('AUTH_ENABLED', auth)
  await complete()
  await admit('default-workspace')
  ctx = createAgentContext({ tenantId: tenant, sessionId: ctx.sessionId,
    scratchDir: path.join(dir, 'scratch', ctx.sessionId), tools: new ToolRegistry(), history, logger: pino({ level: 'silent' }),
    executionOwner: owner, signal: controller.signal, rootRunId: root.runId, turnId: root.turnId,
    conversationId: root.turnId, assistantMessageId: root.assistantMessageId })
  const parentScratch = manager.getWorkingDirectory(ctx)
  const bindingsBefore = fs.readFileSync(path.join(dir, 'bindings.json'), 'utf8')
  fs.writeFileSync(path.join(parentScratch, 'default-output.txt'), 'default workspace output')
  const report = await inChild(async child => {
    expect(manager.getWorkingDirectory(child)).toBe(parentScratch)
    expect(manager.getScratchDirectory(child)).not.toBe(parentScratch)
    expect(fs.readFileSync(manager.resolveSafePath(child, 'default-output.txt'), 'utf8')).toBe('default workspace output')
    return store.report(child, [{ path: 'default-output.txt' }])
  })
  expect(fs.readFileSync(path.join(dir, 'bindings.json'), 'utf8')).toBe(bindingsBefore)
  expect(await store.stage(ctx, [{ childSessionId: report.childSessionId, runId: report.runId, artifactId: report.items[0].assetId }]))
    .toMatchObject([{ name: 'default-output.txt', producerChildSessionId: report.childSessionId }])
})

it('preserves operator supplied local workspace roots without requiring persistent bindings', async () => {
  vi.stubEnv('AUTH_ENABLED', 'false')
  await complete()
  await admit('local-unbound')
  const second = path.join(dir, 'second-project'); fs.mkdirSync(second)
  ctx.workspacePaths = [workspace, second]
  await inChild(async child => {
    expect(manager.getWorkingDirectory(child)).toBe(workspace)
    expect(manager.getPaths(child)).toContain(second)
    expect(manager.resolveSafePath(child, path.join(second, 'component.ts'))).toBe(path.join(second, 'component.ts'))
    expect(() => manager.resolveSafePath(child, path.join(dir, 'outside.txt'))).toThrow('outside')
  })
})

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
