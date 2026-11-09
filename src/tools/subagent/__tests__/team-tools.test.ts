/** Real SQLite admission, child history and projection; only model execution is scripted. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pino } from 'pino'
import type { AgentContext } from '../../../core/agent-context/types.js'
import * as database from '../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { SubagentStore } from '../../../core/subagent/store.js'
import * as runners from '../../../core/subagent/runner.js'
import { CollaborationRuntime } from '../../../core/collaboration/runtime.js'
import { CollaborationStore } from '../../../core/collaboration/store.js'
import { ExecutionOwners, initializeOwnedExecutionStartup } from '../../../core/collaboration/execution-owner.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { WorkspaceManager, workspaceManager } from '../../../workspace/index.js'
import { subagentDirectoryTool, subagentFollowupTool, subagentRequestInputTool, buildSubagentTeamContext } from '../team-tools.js'
import { executeSubagent } from '../subagent-tool.js'
import { readFileTool, writeFileTool } from '../../file/super-file-tool.js'
import { buildRuntimeCapabilities, buildRuntimeCapabilitiesPrompt } from '../../../core/runtime-capabilities.js'
import { setSecurityMode, clearSecurityMode } from '../../../security/policy-engine.js'
import { subagentReadResultTool } from '../async-tools.js'
import { getToolOutputLimit } from '../../../core/agent-loop/tool-output-limit.js'
import { getSubagentPayloadFiles } from '../../../core/subagent/payload-files.js'

const model = vi.hoisted(() => ({ calls: 0, histories: [] as string[], checkChild: undefined as ((child: AgentContext) => Promise<void>) | undefined }))
vi.mock('../../../core/llm-adapter/resolve-model.js', () => ({
  resolveModelConfig: async () => ({ model: 'scripted', provider: 'fixture', capabilities: { contextWindow: 100_000 } }),
  createAdapterFromResolved: () => ({}),
}))
vi.mock('../../../core/agent-loop/react.js', () => ({ ReActStrategy: class {
  async *run(task: string, child: AgentContext) {
    model.calls++
    await model.checkChild?.(child)
    model.histories.push(JSON.stringify(await child.history.getHistory(child)))
    await child.history.append({ id: `followup-user-${child.runId}`, role: 'user', content: task }, child)
    await child.history.append({ id: `followup-answer-${child.runId}`, role: 'assistant', content: 'Verified follow-up' }, child)
    await child.runObserver?.onOutcome?.({ status: 'succeeded', output: 'Verified follow-up' })
    yield ''
  }
} }))

let directory: string, db: LocalSqliteProcessClient, store: SubagentStore, runner: runners.SubagentRunner
let runtime: CollaborationRuntime, owners: ExecutionOwners, parent: AgentContext, manager: WorkspaceManager
let id = 0
beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/team-tools-'))
  vi.stubEnv('DATA_DIR', path.join(directory, 'fixture.db')); vi.stubEnv('HISTORY_BACKEND', 'jsonl')
  vi.stubEnv('WORKSPACE_ROOT', path.join(directory, 'scratch'))
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', directory); vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(directory, 'bindings.json'))
  manager = new WorkspaceManager(path.join(directory, 'scratch'))
  manager.bind({ tenantId: 'team', sessionId: 'parent' }, directory)
  vi.spyOn(workspaceManager, 'getWorkingDirectory').mockImplementation(scope => manager.getWorkingDirectory(scope))
  vi.spyOn(workspaceManager, 'getPaths').mockImplementation(scope => manager.getPaths(scope))
  vi.spyOn(workspaceManager, 'getBindingSnapshot').mockImplementation(scope => manager.getBindingSnapshot(scope))
  vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation((scope, expected) => manager.bindingReadGuard(scope, expected))
  vi.spyOn(workspaceManager, 'getScratchDirectory').mockImplementation(scope => manager.getScratchDirectory(scope))
  vi.spyOn(workspaceManager, 'resolveSafePath').mockImplementation((scope, value) => manager.resolveSafePath(scope, value))
  vi.spyOn(workspaceManager, 'inheritChildWorkspace').mockImplementation((child, source, roots) => manager.inheritChildWorkspace(child, source, roots))
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockReturnValue(db); await database.initDb()
  const roots = new RootRunStore(() => db), root = await roots.create('team', 'parent', 'scripted', [directory], {})
  store = new SubagentStore(db); runner = new runners.SubagentRunner(store)
  vi.spyOn(runners, 'getSubagentRunner').mockReturnValue(runner)
  runtime = new CollaborationRuntime(new CollaborationStore(db), store); owners = new ExecutionOwners(db, runtime)
  const executionOwner = await owners.admitRoot({ tenantId: 'team', rootRunId: root.runId, rootAttemptId: (await roots.get('team', root.runId))!.attemptId, controller: new AbortController() })
  const tools = new ToolRegistry(); tools.register(subagentDirectoryTool); tools.register(subagentFollowupTool)
  tools.register({ name: 'subagent', description: '', parameters: {}, execute: vi.fn() })
  parent = { tenantId: 'team', sessionId: 'parent', rootSessionId: 'parent', rootRunId: root.runId, turnId: root.turnId, conversationId: root.turnId,
    workspacePaths: [directory], workspaceDir: directory, projectRoot: directory, cwd: directory, modelName: 'scripted', executionOwner, tools, history: createConversationHistory(), logger: pino({ level: 'silent' }) } as AgentContext
  model.calls = 0; model.histories = []; model.checkChild = undefined
})
afterEach(async () => {
  clearSecurityMode('team', 'parent')
  await database.closeDb(); await db.closeWithReceipt(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('team-tools-')) throw new Error('Unsafe test cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

async function anchor(name = 'subagent_followup') {
  parent.currentToolCallId = `tool-${++id}`; parent.currentMessageId = `message-${id}`
  await parent.history.append({ id: parent.currentMessageId, role: 'assistant', content: '', toolCall: { id: parent.currentToolCallId, name, args: {} }, ...{ conversationId: parent.turnId } }, parent)
}
async function seed(legacyWorkspace = false, workspacePaths = [directory]) {
  await anchor('subagent_start')
  return runner.run({ tenantId: parent.tenantId, parentSessionId: 'parent', rootSessionId: 'parent', parentConversationId: parent.turnId!,
    parentMessageId: parent.currentMessageId!, parentToolCallId: parent.currentToolCallId!, task: 'Build chart component', description: 'Chart executor', modelId: 'scripted',
    continuation: { builtinRole: 'executor', builtinRoleVersion: 1, readOnly: false, systemPrompt: 'PRIVATE_PROMPT', toolNames: [], workspacePaths: legacyWorkspace ? [] : workspacePaths, ...(legacyWorkspace ? { projectRoot: directory, cwd: directory } : {}) } }, parent, async execution => {
      await parent.history.append({ id: 'retained-context', role: 'assistant', content: 'Chart uses the existing canvas API' }, { tenantId: 'team', sessionId: execution.snapshot.childSessionId })
      await execution.observer.onOutcome({ status: 'succeeded', output: 'Chart completed' })
    })
}

async function questioningChild() {
  const ticket = owners.reserveChild(parent.executionOwner!)
  const admitted = await runtime.admitChild(owners.producerForExecution(parent.executionOwner!), { tenantId: 'team', parentSessionId: 'parent', rootSessionId: 'parent', parentConversationId: parent.turnId!,
    parentMessageId: `question-parent-${++id}`, parentToolCallId: `question-dispatch-${id}`, task: 'Choose a document format', description: 'Document executor', modelId: 'scripted' })
  const run = admitted.mutation.header
  const child: AgentContext = { ...parent, sessionId: run.childSessionId, parentSessionId: parent.sessionId, runId: run.runId,
    executionOwner: owners.attachChild(ticket, run.runId, admitted.producer), currentMessageId: `question-message-${id}`, currentToolCallId: `question-tool-${id}` }
  await child.history.append({ id: child.currentMessageId, role: 'assistant', content: '', toolCall: { id: child.currentToolCallId!, name: 'subagent_request_input', args: {} }, ...{ conversationId: child.turnId } }, child)
  return { child, producer: admitted.producer }
}

describe('persistent child directory and follow-up', () => {
  it('settles the canonical executor, parent projection and ticket when the result volume fails', async () => {
    await anchor('subagent_start')
    await store.initialize()
    vi.spyOn(await getSubagentPayloadFiles(db), 'put').mockRejectedValue(new Error('fixture result volume unavailable'))
    const start = await runner.start({ tenantId: 'team', rootSessionId: 'parent', parentSessionId: 'parent',
      parentConversationId: parent.turnId!, parentMessageId: parent.currentMessageId!, parentToolCallId: parent.currentToolCallId!,
      task: 'Return final evidence', description: 'Result storage failure', modelId: 'fixture' }, parent, async ({ observer }) => {
      await observer.onOutcome({ status: 'succeeded', finalOutput: 'Candidate result' })
    })
    expect(await start.completion).toMatchObject({ status: 'failed', stopReason: 'result_persistence_failed', error: { code: 'RESULT_PERSIST_FAILED' } })
    const waited = await runner.waitOwned(parent, start.runId, { timeoutMs: 0 })
    expect(waited).toMatchObject({ state: 'completed', run: { status: 'failed', error: { code: 'RESULT_PERSIST_FAILED' } } })
    const result = (await parent.history.getHistory(parent)).find(message => message.id === 'subagent-result:' + start.runId)
    expect(result?.content).toContain('RESULT_PERSIST_FAILED'); expect(result?.metadata?.subagent).not.toHaveProperty('resultRef')
  })

  it('lets the parent read persisted earlier results within Work output limits and rejects forged authority', async () => {
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '4000')
    const value = await store.createRunDelta({ tenantId: 'team', parentSessionId: 'parent', rootSessionId: 'parent',
      parentConversationId: 'prior-turn', parentMessageId: 'prior-message', parentToolCallId: 'prior-call', task: 'Prior result', description: 'Prior result', modelId: 'fixture' })
    const body = '结论🙂\u0000\n"\\'.repeat(1800), { summary, ...metadata } = await store.prepareResult('team', body, 'final')
    await store.appendHeader('team', value.header.runId, 'finished', { status: 'succeeded', resultSummary: summary, ...metadata })
    let offset = 0, actual = ''
    while (true) {
      const result = await subagentReadResultTool.execute({ runId: value.header.runId, offset, limitBytes: 65536 }, parent)
      expect(result.success).toBe(true); expect(result.output.length).toBeLessThanOrEqual(getToolOutputLimit(parent.toolProfile, parent))
      const page = JSON.parse(result.output)
      expect(page).toMatchObject({ resultHash: metadata.resultHash, offset, totalBytes: Buffer.byteLength(body) })
      actual += page.text
      if (!page.hasMore) break
      expect(result.output.indexOf('"nextOffset"')).toBeLessThan(result.output.indexOf('"text"'))
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset
    }
    expect(actual).toBe(body)
    expect((await subagentReadResultTool.execute({ runId: value.header.runId, tenantId: 'team' }, parent)).success).toBe(false)
    expect((await subagentReadResultTool.execute({ runId: value.header.runId, resultRef: metadata.resultRef }, parent)).success).toBe(false)
    expect((await subagentReadResultTool.execute({ runId: value.header.runId }, { ...parent, sessionId: 'foreign-parent' })).success).toBe(false)
    const { child } = await questioningChild()
    expect((await subagentReadResultTool.execute({ runId: value.header.runId }, child)).success).toBe(false)
    const sibling = await seed()
    expect((await subagentReadResultTool.execute({ runId: sibling.runId }, child)).success).toBe(true)
  })

  it.each([false, true])('rejects no-task follow-ups before mailbox delivery or admission (active=%s)', async active => {
    const original = await seed()
    if (active) await runtime.admitChild(owners.producerForExecution(parent.executionOwner!), {
      tenantId: 'team', parentSessionId: 'parent', rootSessionId: 'parent', parentConversationId: parent.turnId!,
      parentMessageId: 'active-empty-guard', parentToolCallId: 'active-empty-guard', task: 'Active task',
      description: 'Active task', modelId: 'scripted', resumeFromRunId: original.runId,
    })
    const before = await store.listRunsForParent('team', 'parent')
    const send = vi.spyOn(runtime, 'send'), reserve = vi.spyOn(store, 'reserveFollowup')
    await anchor()
    for (const message of ['', ' \n\t', '!', '！？……', '\u200b\u200d', '👍✨']) {
      const result = await subagentFollowupTool.execute({ childSessionId: original.childSessionId, message }, parent)
      expect(result.success, message).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(await store.listRunsForParent('team', 'parent')).toEqual(before)
    expect(model.calls).toBe(0)
  })

  it('captures the authoritative bound workspace when a new request omits workspace paths', async () => {
    await anchor('subagent_start')
    const result = await executeSubagent({ builtinRole: 'executor', task: 'Build in the existing workspace' }, {
      ...parent, workspacePaths: [], projectRoot: path.join(directory, 'scratch'), cwd: path.join(directory, 'scratch'),
    }, { asynchronous: true })
    expect(result.success, result.output).toBe(true)
    const started = JSON.parse(result.output)
    expect(await runner.waitOwned(parent, started.runId, { timeoutMs: 3000 })).toMatchObject({ state: 'completed', run: { status: 'succeeded' } })
    expect((await store.getRunHeader('team', started.runId, true))?.continuation?.projectRoot).toBe(directory)
  })

  it.each(['jsonl', 'sqlite'])('continues a completed %s child once, preserving context and the original real projection anchor', async backend => {
    vi.stubEnv('HISTORY_BACKEND', backend); parent.history = createConversationHistory()
    const original = await seed(); await anchor()
    const firstAnchor = parent.currentToolCallId
    const input = { childSessionId: original.childSessionId, message: 'Add chart keyboard navigation', requestKey: 'same-followup' }
    const result = await subagentFollowupTool.execute(input, parent)
    expect(result.success, result.output).toBe(true)
    const admission = JSON.parse(result.output)
    expect(admission.childSessionId).toBe(original.childSessionId)
    expect(admission.runId).not.toBe(original.runId)
    const outcome = await runner.waitOwned(parent, admission.runId, { timeoutMs: 3000 })
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ state: 'completed', run: { status: 'succeeded' } })
    await anchor()
    const repeated = await subagentFollowupTool.execute(input, parent)
    expect(repeated.success, repeated.output).toBe(true)
    expect(JSON.parse(repeated.output).runId).toBe(admission.runId)
    expect(model.calls).toBe(1); expect(model.histories[0]).toContain('existing canvas API')
    expect((await store.getRunHeader('team', admission.runId))?.parentToolCallId).toBe(firstAnchor)
    expect((await parent.history.getFullHistory(parent)).find(message => message.id === 'subagent-result:' + admission.runId)).toBeDefined()
    expect((await subagentFollowupTool.execute({ ...input, message: 'Different payload' }, parent)).success).toBe(false)
    const page = JSON.parse((await subagentDirectoryTool.execute({}, parent)).output)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ runId: admission.runId, builtinRole: 'executor', builtinRoleVersion: 1, canResume: true })
    expect(JSON.stringify(page)).not.toContain('PRIVATE_PROMPT')
  })

  it('routes active follow-ups through the persistent mailbox and never starts a duplicate child', async () => {
    const original = await seed()
    const mutation = await runtime.admitChild(owners.producerForExecution(parent.executionOwner!), { tenantId: 'team', parentSessionId: 'parent', rootSessionId: 'parent', parentConversationId: parent.turnId!,
      parentMessageId: 'active', parentToolCallId: 'active', task: 'Active task', description: 'Active task', modelId: 'scripted', resumeFromRunId: original.runId })
    await anchor()
    const input = { childSessionId: original.childSessionId, message: 'Use the existing API', requestKey: 'active-update' }
    const result = await subagentFollowupTool.execute(input, parent)
    expect(result.success, result.output).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({ action: 'queued', receipt: { delivery: { state: 'pending' } } })
    await anchor()
    expect(JSON.parse((await subagentFollowupTool.execute(input, parent)).output).receipt.messageId).toBe(JSON.parse(result.output).receipt.messageId)
    expect(model.calls).toBe(0)
    expect((await store.latestChildHeader('team', 'parent', original.childSessionId))?.runId).toBe(mutation.mutation.header.runId)
  })

  it('scopes and bounds discovery, validates workspace, and includes reusable children in the parent prompt', async () => {
    const first = await seed(); const second = await seed()
    const one = await store.listChildSessionsPage('team', 'parent', { limit: 1 })
    expect(one.items).toHaveLength(1); expect(one.hasMore).toBe(true)
    const two = await store.listChildSessionsPage('team', 'parent', { limit: 1, cursor: one.nextCursor })
    expect(new Set([one.items[0].run.childSessionId, two.items[0].run.childSessionId])).toEqual(new Set([first.childSessionId, second.childSessionId]))
    await expect(store.listChildSessionsPage('other', 'parent', { cursor: one.nextCursor })).rejects.toThrow('scope mismatch')
    expect((await store.listChildSessionsPage('other', 'parent')).items).toHaveLength(0)
    expect(await buildSubagentTeamContext(parent)).toContain(first.childSessionId)
    await anchor()
    const narrower = path.join(directory, 'narrower'); fs.mkdirSync(narrower)
    manager.bind(parent, narrower)
    expect((await subagentFollowupTool.execute({ childSessionId: first.childSessionId, message: 'next' }, { ...parent, workspacePaths: [] })).success).toBe(false)
    expect((await subagentFollowupTool.execute({ childSessionId: 'not-owned', message: 'next' }, parent)).success).toBe(false)
    const publicView = await store.getRunView('team', first.runId)
    expect(publicView?.continuation).toEqual({ readOnly: false, builtinRole: 'executor', builtinRoleVersion: 1 })
  })

  it.each([undefined, []])('discovers and follows up retained children when request roots are %s', async workspacePaths => {
    const original = await seed()
    const reconnected = { ...parent, workspacePaths }
    const directoryResult = await subagentDirectoryTool.execute({}, reconnected)
    expect(directoryResult.success, directoryResult.output).toBe(true)
    expect(JSON.parse(directoryResult.output).items[0]).toMatchObject({ canResume: true })
    await anchor()
    const result = await subagentFollowupTool.execute({ childSessionId: original.childSessionId, message: 'Add keyboard navigation' }, { ...parent, workspacePaths })
    expect(result.success, result.output).toBe(true)
    expect(await runner.waitOwned(parent, JSON.parse(result.output).runId, { timeoutMs: 3000 })).toMatchObject({ state: 'completed', run: { status: 'succeeded' } })
  })

  it('resumes a legacy default-workspace child using its persisted project root with no request paths', async () => {
    const original = await seed(true)
    const reconnected = { ...parent, workspacePaths: undefined }
    const directoryResult = await subagentDirectoryTool.execute({}, reconnected)
    expect(JSON.parse(directoryResult.output).items[0]).toMatchObject({ canResume: true })
    await anchor('subagent')
    const result = await executeSubagent({ resumeRunId: original.runId, task: 'Continue the chart work' }, { ...parent, workspacePaths: [] }, { asynchronous: true })
    expect(result.success, result.output).toBe(true)
    expect(await runner.waitOwned(parent, JSON.parse(result.output).runId, { timeoutMs: 3000 })).toMatchObject({ state: 'completed', run: { status: 'succeeded' } })
  })

  it('rejects directory results if the binding epoch changes during database access', async () => {
    await seed()
    const original = store.listChildSessionsPage.bind(store)
    vi.spyOn(store, 'listChildSessionsPage').mockImplementation(async (...args) => {
      const page = await original(...args)
      manager.bind(parent, directory)
      return page
    })
    const result = await subagentDirectoryTool.execute({}, parent)
    expect(result.success).toBe(false)
    expect(result.output).toContain('binding changed')
  })

  it('keeps the real bound relative root while sharing an absolute parent output path with an owned child', async () => {
    const project = path.join(directory, 'selected-project'), stale = path.join(directory, 'stale-request-root')
    fs.mkdirSync(project); fs.mkdirSync(stale)
    manager.bind(parent, project)
    setSecurityMode('team', 'parent', 'safe')
    // Reconnect left descriptive fields stale; the persisted selection governs
    // both actual filesystem dispatch and the child capability, not ctx.cwd.
    parent.workspacePaths = []; parent.projectRoot = stale; parent.cwd = stale
    const output = manager.getScratchDirectory(parent)
    const draftPath = path.join(output, 'deliverables', 'draft.md')
    const shared = await writeFileTool.execute({ path: draftPath, data: '共同事实：只生成分工产物。', expectedHash: 'missing' }, parent)
    expect(shared.success, shared.output).toBe(true)
    const local = await writeFileTool.execute({ path: 'deliverables/draft.md', data: '项目内同名文件，不是共享草稿。', expectedHash: 'missing' }, parent)
    expect(local.success, local.output).toBe(true)
    expect(fs.readFileSync(draftPath, 'utf8')).toBe('共同事实：只生成分工产物。')
    expect(fs.readFileSync(path.join(project, 'deliverables/draft.md'), 'utf8')).toContain('项目内同名')
    const outside = path.join(directory, 'outside.txt'); fs.writeFileSync(outside, 'not granted')
    model.checkChild = async child => {
      expect(manager.getWorkingDirectory(child)).toBe(project)
      expect(buildRuntimeCapabilities(child).environment.cwd).toBe(project)
      expect(buildRuntimeCapabilitiesPrompt(child)).toContain('"relativePathRoot":' + JSON.stringify(project))
      expect(manager.getPaths(child)).toContain(output)
      const absolute = await readFileTool.execute({ path: draftPath, mode: 'exact' }, child)
      expect(absolute.success, absolute.output).toBe(true)
      expect(absolute.output).toContain('共同事实')
      const relative = await readFileTool.execute({ path: 'deliverables/draft.md', mode: 'exact' }, child)
      expect(relative.success, relative.output).toBe(true)
      expect(relative.output).toContain('项目内同名')
      expect((await readFileTool.execute({ path: outside }, child)).success).toBe(false)
      expect(() => manager.resolveSafePath(child, path.join(stale, 'private.txt'))).toThrow('outside')
      manager.bind(parent, project) // Same root, new epoch must invalidate the live child.
      expect((await readFileTool.execute({ path: draftPath }, child)).success).toBe(false)
    }
    await anchor('subagent_start')
    const result = await executeSubagent({ builtinRole: 'research', task: `共享草稿仅只读：${draftPath}；相对路径仍使用已绑定项目。` }, parent)
    expect(result.success, result.output).toBe(true)
    expect(model.calls).toBe(1)
  })

  it('does not reinterpret an output-first legacy permission list as the resumed child working directory', async () => {
    const project = path.join(directory, 'project'), output = manager.getScratchDirectory(parent)
    fs.mkdirSync(project); fs.mkdirSync(output, { recursive: true })
    manager.bind(parent, project)
    const original = await seed(false, [output, project])
    model.checkChild = async child => {
      expect(child.projectRoot).toBe(project)
      expect(child.cwd).toBe(project)
      expect(manager.getPaths(child)).toEqual(expect.arrayContaining([project, output]))
      expect(manager.getPaths(child)[0]).toBe(project)
      expect(manager.resolveSafePath(child, 'draft.md')).toBe(path.join(project, 'draft.md'))
      expect(buildRuntimeCapabilities(child).environment.primaryWorkspace).toBe(project)
    }
    await anchor('subagent')
    const result = await executeSubagent({ resumeRunId: original.runId, task: 'Continue using the shared output by absolute path' }, { ...parent, workspacePaths: [] })
    expect(result.success, result.output).toBe(true)
    expect(model.calls).toBe(1)
  })

  it('serializes follow-up reservations and keeps a retry bound to its original target and input', async () => {
    const original = await seed()
    const value = { payloadHash: 'hash-one', childSessionId: original.childSessionId, resumeFromRunId: original.runId, parentToolCallId: 'first', parentMessageId: 'first-message', description: 'next' }
    const [a, b] = await Promise.all([store.reserveFollowup('team', 'parent', 'key', value), store.reserveFollowup('team', 'parent', 'key', { ...value, parentToolCallId: 'second' })])
    expect(a).toEqual(b)
    await expect(store.reserveFollowup('team', 'parent', 'key', { ...value, payloadHash: 'changed' })).rejects.toThrow('payload conflict')
    await store.deleteRuns('team', [original.runId])
    expect(await store.followupAdmission('team', 'parent', 'key')).toBeNull()
  })

  it('joins simultaneous identical wake requests and refuses a fabricated tool anchor', async () => {
    const original = await seed()
    const input = { childSessionId: original.childSessionId, message: 'Handle keyboard navigation', requestKey: 'concurrent-wake' }
    const invalid = await subagentFollowupTool.execute(input, { ...parent, currentMessageId: 'missing', currentToolCallId: 'missing' })
    expect(invalid.success).toBe(false); expect(invalid.output).toContain('anchor')
    await anchor(); const first = { ...parent }
    await anchor(); const second = { ...parent }
    const results = await Promise.all([subagentFollowupTool.execute(input, first), subagentFollowupTool.execute(input, second)])
    for (const result of results) expect(result.success, result.output).toBe(true)
    const runId = JSON.parse(results[0].output).runId
    expect(JSON.parse(results[1].output).runId).toBe(runId)
    expect(await runner.waitOwned(parent, runId, { timeoutMs: 3000 })).toMatchObject({ state: 'completed', run: { status: 'succeeded' } })
    expect(model.calls).toBe(1)
  })

  it('discovers and resumes a retained child from a new parent execution after a real database reopen', async () => {
    const original = await seed(), oldOwner = parent.executionOwner
    await database.closeDb(); await db.closeWithReceipt()
    db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
    vi.mocked(database.getDb).mockReturnValue(db); await database.initDb(); await initializeOwnedExecutionStartup()
    store = new SubagentStore(db); runner = new runners.SubagentRunner(store); vi.mocked(runners.getSubagentRunner).mockReturnValue(runner)
    const roots = new RootRunStore(() => db), root = await roots.create('team', 'parent', 'scripted', [directory], {})
    runtime = new CollaborationRuntime(new CollaborationStore(db), store); owners = new ExecutionOwners(db, runtime)
    const owner = await owners.admitRoot({ tenantId: 'team', rootRunId: root.runId, rootAttemptId: (await roots.get('team', root.runId))!.attemptId, controller: new AbortController() })
    parent = { ...parent, executionOwner: owner, rootRunId: root.runId, turnId: root.turnId, conversationId: root.turnId, history: createConversationHistory() }
    const page = JSON.parse((await subagentDirectoryTool.execute({}, parent)).output)
    expect(page.items[0]).toMatchObject({ childSessionId: original.childSessionId, currentTurn: false, canResume: true })
    await anchor()
    expect((await subagentFollowupTool.execute({ childSessionId: original.childSessionId, message: 'continue' }, { ...parent, executionOwner: oldOwner })).success).toBe(false)
    const result = await subagentFollowupTool.execute({ childSessionId: original.childSessionId, message: 'Continue keyboard work' }, parent)
    expect(result.success, result.output).toBe(true)
    const resumed = JSON.parse(result.output)
    const outcome = await runner.waitOwned(parent, resumed.runId, { timeoutMs: 3000 })
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ state: 'completed', run: { status: 'succeeded' } })
    expect(resumed.childSessionId).toBe(original.childSessionId); expect(model.histories[0]).toContain('existing canvas API')
  })
})

describe('child question handoff', () => {
  it('durably identifies the real child, deduplicates its question and rejects forged identities', async () => {
    const { child, producer } = await questioningChild()
    const input = { question: 'Which output format?', options: ['Word', 'PDF'] }
    const first = await subagentRequestInputTool.execute(input, child)
    expect(first.success, first.output).toBe(true)
    const detail = first.metadata?.subagentQuestion
    expect(detail).toMatchObject({ ...input, childSessionId: child.sessionId, runId: child.runId,
      receipt: { recipientParticipantId: `root:${parent.rootRunId}`, delivery: { state: 'pending' } } })
    const repeated = await subagentRequestInputTool.execute(input, child)
    expect(repeated.metadata?.subagentQuestion).toEqual(detail)
    expect(Number((await db.execute('SELECT COUNT(*) AS count FROM collaboration_messages')).rows[0].count)).toBe(1)
    expect((await subagentRequestInputTool.execute(input, parent)).success).toBe(false)
    expect((await subagentRequestInputTool.execute(input, { ...child, runId: 'forged' })).success).toBe(false)
    expect((await subagentRequestInputTool.execute(input, { ...child, currentMessageId: 'missing' })).success).toBe(false)
    expect((await subagentRequestInputTool.execute({ question: 'Changed question' }, child)).success).toBe(false)
    expect(runtime.executionBinding(producer).kind).toBe('child')
  })

  it('retains the question without claiming delivery when the parent has sealed its inbox', async () => {
    const { child } = await questioningChild()
    expect(await runtime.sealInputIfEmpty(owners.producerForExecution(parent.executionOwner!))).toBe(true)
    const result = await subagentRequestInputTool.execute({ question: 'Which source should be used?' }, child)
    expect(result.success, result.output).toBe(true)
    expect(result.metadata?.subagentQuestion).toMatchObject({ childSessionId: child.sessionId, runId: child.runId, deliveryUnavailable: true })
    expect(result.metadata?.subagentQuestion).not.toHaveProperty('receipt')
    expect(Number((await db.execute('SELECT COUNT(*) AS count FROM collaboration_messages')).rows[0].count)).toBe(0)
  })
})
