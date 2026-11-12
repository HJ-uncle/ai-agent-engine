// Exercises the real subagent tool's child-context construction; model/runner I/O are replaced at their boundaries.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, IToolRegistry } from '../../../core/agent-context/types.js'
import type { CreateSubagentRun, SubagentRun, SubagentRunHeader } from '../../../core/subagent/types.js'
import type { SubagentExecution } from '../../../core/subagent/runner.js'
import { createAgentContext } from '../../../core/agent-context/factory.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { createSubagentToolRegistry, executeSubagent, subagentStartTool, subagentTool } from '../subagent-tool.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { officeInspectTool } from '../../office/index.js'
import { WorkspaceManager, workspaceManager } from '../../../workspace/index.js'
import { PluginService } from '../../../plugins/service.js'
import { pluginToolkitId } from '../../../plugins/catalogue.js'
import { pluginRegistryBindings } from '../../../plugins/identity.js'
import { createToolRegistry } from '../../registry-factory.js'
import type { CreatePluginInput } from '../../../plugins/types.js'
import { createKnowledgeManagementTools, createKnowledgeReadTools } from '../../knowledge/management-tools.js'
import { KNOWLEDGE_READ_TOOLS } from '../../toolkits.js'
import { loadToolsTool } from '../../model-tool-loading.js'
import { compactBuiltinToolDefinition } from '../../model-tool-definitions.js'
import * as database from '../../../storage/sqlite/db.js'
import * as knowledge from '../../../storage/knowledge/kb-repo.js'
import { knowledgeFixture } from '../../../storage/knowledge/__tests__/fixture.js'

const captured = vi.hoisted(() => ({ child: undefined as AgentContext | undefined, prior: null as SubagentRun | null, input: undefined as CreateSubagentRun | undefined,
  getRunHeader: vi.fn() }))

vi.mock('../../../core/subagent/runner.js', () => ({
  getSubagentRunner: () => ({
    store: { getRunHeader: captured.getRunHeader },
    run: async (input: CreateSubagentRun, _parent: AgentContext, execute: (execution: SubagentExecution) => Promise<void>) => {
      captured.input = input
      const snapshot: SubagentRunHeader = { ...input, schemaVersion: 1, runId: 'fixture-run', childSessionId: 'fixture-child',
        status: 'running', lastSeq: 1, createdAt: 1, updatedAt: 1, usage: {}, toolCount: 0, activeToolCount: 0,
        nonPlanToolCount: 0, transcriptRef: 'fixture' }
      await execute({ snapshot, signal: new AbortController().signal, onRequestAttempt: vi.fn(), observer: {
        onOutcome: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(), onUsage: vi.fn(),
      } })
      return { ...snapshot, status: 'succeeded', resultSummary: 'fixture' }
    },
  }),
}))
vi.mock('../../../core/agent-loop/react.js', () => ({
  ReActStrategy: class {
    async *run(_task: string, child: AgentContext) { captured.child = child; yield '' }
  },
}))
vi.mock('../../../core/llm-adapter/resolve-model.js', () => ({
  resolveModelConfig: async ({ model }: { model?: string }) => ({ model: model ?? 'fixture', provider: 'fixture', capabilities: { contextWindow: 100_000 } }),
  createAdapterFromResolved: () => ({}),
}))
vi.mock('../../../storage/conversation/factory.js', () => ({ createConversationHistory: () => ({}) }))
vi.mock('../../../core/project-context.js', () => ({ getProjectContextBlock: () => '' }))

let fixtureDir: string
let manager: WorkspaceManager
beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-reviewer-access-'))
  vi.stubEnv('WORKSPACE_ROOT', fixtureDir)
  vi.stubEnv('AUTH_ENABLED', 'true')
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', fixtureDir)
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(fixtureDir, 'bindings.json'))
  manager = new WorkspaceManager(path.join(fixtureDir, 'scratch'))
  manager.bind({ tenantId: 'fixture', sessionId: 'parent' }, fixtureDir)
  vi.spyOn(workspaceManager, 'getPaths').mockImplementation(scope => manager.getPaths(scope))
  vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation((scope, expected) => manager.bindingReadGuard(scope, expected))
  captured.child = undefined
  captured.input = undefined
  captured.prior = null
  captured.getRunHeader.mockReset().mockImplementation(async (_tenant: string, _run: string, fullRecord: boolean) => {
    expect(fullRecord).toBe(true)
    if (!captured.prior) return null
    const { toolCalls, ...header } = captured.prior
    return { ...header, toolCount: toolCalls.length, activeToolCount: toolCalls.filter(tool => tool.status === 'running').length,
      nonPlanToolCount: toolCalls.length }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixtureDir) !== path.resolve(os.tmpdir()) || !path.basename(fixtureDir).startsWith('aether-reviewer-access-')) throw new Error('Unsafe fixture cleanup path')
  fs.rmSync(fixtureDir, { recursive: true, force: true })
})

describe('reviewer role access through subagentTool.execute', () => {
  it.each(['spec-reviewer', 'code-quality-reviewer'])('%s cannot obtain parent write capabilities with access=inherit', async (role) => {
    const definitions = ['read_file', 'write_file', 'execute_cmd', 'mcp_mutation'].map((name) => ({ name, description: name, parameters: { type: 'object' } }))
    const tools: IToolRegistry = { register: vi.fn(), unregister: vi.fn(), has: (name) => definitions.some((tool) => tool.name === name),
      list: () => definitions, execute: vi.fn().mockResolvedValue({ success: true, output: 'read result' }) }
    const parent = createAgentContext({ tenantId: 'fixture', sessionId: 'parent', projectRoot: fixtureDir,
      logger: pino({ level: 'silent' }), tools, history: createConversationHistory(), tokenBudget: 100_000, modelName: 'fixture' })
    await subagentTool.execute({ task: 'Review the project', role, access: 'inherit' }, parent)
    const child = captured.child
    expect(child).toBeDefined()
    if (!child) throw new Error('Child execution was not reached')
    expect(child.tools.list().map((tool) => tool.name)).toEqual(['read_file', 'plan_update'])
    const blocked = await child.tools.execute('write_file', { path: 'README.md', data: 'unexpected mutation' }, child)
    expect(blocked).toMatchObject({ success: false, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } })
    expect(tools.execute).not.toHaveBeenCalled()
    await child.tools.execute('read_file', { path: 'README.md' }, child)
    expect(tools.execute).toHaveBeenCalledWith('read_file', { path: 'README.md' }, child)
  })
})

describe('builtin role identity and permission snapshots', () => {
  function parentContext() {
    const definitions = ['read_file', 'write_file', 'execute_cmd', 'deliver_files', 'mcp_mutation'].map(name => ({ name, description: name, parameters: {} }))
    const tools: IToolRegistry = { register: vi.fn(), unregister: vi.fn(), has: name => definitions.some(tool => tool.name === name),
      list: () => definitions, execute: vi.fn() }
    return createAgentContext({ tenantId: 'fixture', sessionId: 'parent', workspacePaths: [fixtureDir], projectRoot: fixtureDir,
      logger: pino({ level: 'silent' }), tools, history: createConversationHistory(), modelName: 'fixture' })
  }

  it.each(['', ' \n\t', '!', '！？……', '\u200b\u200d', '👍✨'])('rejects no-task input %j before creating or resuming a child', async task => {
    for (const tool of [subagentTool, subagentStartTool]) {
      for (const resume of [{}, { resumeRunId: 'previous' }]) {
        const result = await tool.execute({ task, ...resume }, parentContext())
        expect(result).toMatchObject({ success: false })
        expect(result.output).toContain('实际任务')
      }
    }
    expect(captured.input).toBeUndefined()
    expect(captured.child).toBeUndefined()
    expect(captured.getRunHeader).not.toHaveBeenCalled()
  })

  it.each(['查', '继续', 'Go', 'x', '2'])('keeps short task %j executable', async task => {
    expect((await subagentTool.execute({ task }, parentContext())).success).toBe(true)
    expect(captured.input?.task).toBe(task)
  })

  it('preserves meaningful legacy systemPrompt fallback without overriding a punctuation task', async () => {
    const parent = parentContext()
    const rejected = await subagentTool.execute({ task: '!', systemPrompt: 'Inspect the project' }, parent)
    expect(rejected.success).toBe(false)
    expect(captured.input).toBeUndefined()
    expect((await subagentTool.execute({ task: '', systemPrompt: 'Inspect the project' }, parent)).success).toBe(true)
    expect(captured.input?.task).toBe('Inspect the project')
  })

  it.each(['research', 'executor', 'general'])('snapshots the %s template independently of a configured Agent', async builtinRole => {
    const result = await subagentTool.execute({ task: 'Complete the assigned work', builtinRole }, parentContext())
    expect(result.success).toBe(true)
    expect(captured.input?.continuation).toMatchObject({ builtinRole, builtinRoleVersion: 1, readOnly: builtinRole === 'research' })
    expect(captured.input?.agentId).toBeUndefined()
    expect(captured.child?.tools.has('write_file')).toBe(builtinRole !== 'research')
    expect(captured.child?.tools.has('execute_cmd')).toBe(builtinRole !== 'research')
    expect(captured.child?.tools.has('deliver_files')).toBe(false)
    expect(captured.input?.continuation?.systemPrompt).toContain('主 Agent 验收')
  })

  it.each([
    { builtinRole: 'unknown' },
    { builtinRole: 'research', access: 'inherit' },
    { builtinRole: 'research', agentId: 'configured' },
    { builtinRole: 'executor', role: 'implementer' },
  ])('rejects ambiguous or expanded builtin authority: %j', async args => {
    expect((await subagentTool.execute({ task: 'work', ...args }, parentContext())).success).toBe(false)
    expect(captured.child).toBeUndefined()
  })

  it('keeps the stored template version and prompt when a completed builtin child is resumed', async () => {
    const parent = parentContext()
    captured.prior = { schemaVersion: 1, runId: 'previous', tenantId: 'fixture', rootSessionId: 'parent', parentSessionId: 'parent',
      parentConversationId: 'old-turn', parentMessageId: 'old-message', parentToolCallId: 'old-tool', childSessionId: 'fixture-child',
      task: 'first task', description: 'research', modelId: 'fixture', status: 'succeeded', lastSeq: 2,
      createdAt: 1, updatedAt: 1, usage: {}, toolCalls: [], transcriptRef: 'fixture',
      continuation: { builtinRole: 'research', builtinRoleVersion: 1, readOnly: true, toolNames: ['read_file'],
        systemPrompt: 'Frozen research prompt', workspacePaths: [fixtureDir], projectRoot: fixtureDir } }
    expect((await subagentTool.execute({ task: '继续', resumeRunId: 'previous' }, parent)).success).toBe(true)
    expect(captured.input?.continuation).toEqual(captured.prior.continuation)
    expect(captured.input?.resumeFromRunId).toBe('previous')
    expect(captured.child?.tools.has('write_file')).toBe(false)
    captured.child = undefined
    expect((await subagentTool.execute({ task: 'Follow up', resumeRunId: 'previous', builtinRole: 'executor' }, parent)).success).toBe(false)
    expect(captured.child).toBeUndefined()
  })
})


describe('subagent continuation tool preserves original capabilities', () => {
  function parentAndPrior() {
    const definitions = ['read_file', 'write_file', 'execute_cmd'].map(name => ({ name, description: name, parameters: { type: 'object' } }))
    const tools: IToolRegistry = { register: vi.fn(), unregister: vi.fn(), has: name => definitions.some(tool => tool.name === name), list: () => definitions, execute: vi.fn().mockResolvedValue({ success: true, output: 'ok' }) }
    const parent = createAgentContext({ tenantId: 'fixture', sessionId: 'parent', workspacePaths: [fixtureDir], projectRoot: fixtureDir, logger: pino({ level: 'silent' }), tools, history: createConversationHistory(), modelName: 'fixture' })
    captured.prior = { schemaVersion: 1, runId: 'previous', tenantId: 'fixture', rootSessionId: 'parent', parentSessionId: 'parent', parentConversationId: 'previous-turn', parentMessageId: 'message', parentToolCallId: 'previous-tool', childSessionId: 'fixture-child', task: 'original', description: 'reviewer', modelId: 'fixture', status: 'succeeded', lastSeq: 2, createdAt: 1, updatedAt: 2, usage: {}, toolCalls: [], transcriptRef: 'fixture', continuation: { role: 'spec-reviewer', readOnly: true, toolNames: ['read_file'], systemPrompt: 'Original role', workspacePaths: [fixtureDir], projectRoot: fixtureDir } }
    return parent
  }
  it.each([
    { configured: 'qwen3.8-flash', toolModel: undefined, expected: 'qwen3.8-flash' },
    { configured: undefined, toolModel: undefined, expected: 'fixture' },
    { configured: 'qwen3.8-flash', toolModel: 'deepseek-v4.1-flash', expected: 'deepseek-v4.1-flash' },
  ])('resolves continued model with explicit user/tool priority: $expected', async ({ configured, toolModel, expected }) => {
    const parent = { ...parentAndPrior(), modelName: 'parent-model', subagentModel: configured }
    const result = await subagentTool.execute({ task: 'next', resumeRunId: 'previous', ...(toolModel ? { model: toolModel } : {}) }, parent)
    expect(result.success).toBe(true)
    expect(captured.child?.modelName).toBe(expected)
    expect(captured.child?.tools.list().map(tool => tool.name)).toEqual(['read_file', 'plan_update'])
    expect(captured.child?.sessionId).toBe('fixture-child')
    expect(captured.getRunHeader).toHaveBeenCalledWith('fixture', 'previous', true)
  })
  it('refuses role or access escalation and does not enter child execution', async () => {
    const parent = parentAndPrior()
    for (const overrides of [{ access: 'inherit' }, { role: 'implementer' }, { systemPrompt: 'Change policy' }]) {
      const result = await subagentTool.execute({ task: 'next', resumeRunId: 'previous', ...overrides }, parent)
      expect(result.success).toBe(false)
      expect(result.output).toContain('不能修改')
      expect(captured.child).toBeUndefined()
    }
  })
  it('intersects saved child tools with the current parent and preserves the workspace', async () => {
    const parent = parentAndPrior()
    await subagentTool.execute({ task: 'next', resumeRunId: 'previous' }, parent)
    expect(captured.child?.tools.list().map(tool => tool.name)).toEqual(['read_file', 'plan_update'])
    expect(captured.child?.projectRoot).toBe(fixtureDir)
  })
  it.skipIf(process.platform !== 'win32')('accepts the same Windows workspace with different casing without adding tools or directories', async () => {
    const parent = parentAndPrior()
    parent.workspacePaths = [fixtureDir.toUpperCase()]
    const result = await subagentTool.execute({ task: 'Continue in the same workspace', resumeRunId: 'previous' }, parent)
    expect(result.success, result.output).toBe(true)
    expect(captured.input?.continuation?.workspacePaths).toEqual([fixtureDir])
    expect(captured.child?.tools.list().map(tool => tool.name)).toEqual(['read_file', 'plan_update'])
    expect(captured.child?.projectRoot).toBe(fixtureDir)
  })
  it('refuses a changed parent session or a no-longer-authorized workspace', async () => {
    const parent = parentAndPrior()
    const other = { ...parent, sessionId: 'other' }
    expect((await subagentTool.execute({ task: 'next', resumeRunId: 'previous' }, other)).success).toBe(false)
    const narrower = path.join(fixtureDir, 'narrower'); fs.mkdirSync(narrower)
    manager.bind(parent, narrower)
    expect((await subagentTool.execute({ task: 'next', resumeRunId: 'previous' }, { ...parent, workspacePaths: [] })).success).toBe(false)
    expect(captured.child).toBeUndefined()
  })
})


describe('custom Agent and legacy child builtin planning defaults', () => {
  it.each([
    { trusted: true, allowedTools: ['office_inspect'], expected: ['office_inspect', 'plan_update'] },
    { trusted: true, allowedTools: [], expected: ['plan_update'] },
    { trusted: false, allowedTools: ['office_inspect'], expected: ['plan_update'] },
  ])('intersects configured readonly Office inspection with trusted parent and explicit selection: %j', async ({ trusted, allowedTools, expected }) => {
    const tools = new ToolRegistry()
    const inspector = { ...officeInspectTool, execute: vi.fn().mockResolvedValue({ success: true, output: 'unused' }) }
    tools.register(trusted ? trustBuiltinTool(inspector, 'readonly') : inspector)
    const parent = createAgentContext({ tenantId: 'fixture', sessionId: 'parent', projectRoot: fixtureDir, toolProfile: 'general',
      logger: pino({ level: 'silent' }), tools, history: createConversationHistory(), modelName: 'fixture' })
    const agent = { id: 'office-reviewer', name: 'Office reviewer', model: 'fixture', systemPrompt: 'Review only.', skills: [], mcpServers: [], knowledgeBases: [], allowedTools }
    expect((await executeSubagent({ task: 'Inspect saved workbook diagnostics', access: 'read-only' }, parent, { agent })).success).toBe(true)
    expect(captured.child?.tools.list().map(tool => tool.name).sort()).toEqual(expected)
    expect(captured.child?.tools.has('office_document')).toBe(false)
    expect(inspector.execute).not.toHaveBeenCalled()
  })

  it.each([
    { toolProfile: 'general' as const, userDelegated: false, access: 'read-only' },
    { toolProfile: 'code' as const, userDelegated: false, access: 'inherit' },
    { toolProfile: 'general' as const, userDelegated: true, access: 'inherit' },
    { toolProfile: 'code' as const, userDelegated: true, access: 'read-only' },
  ])('keeps session planning but no business capabilities for $toolProfile / $access / delegated=$userDelegated', async ({ toolProfile, userDelegated, access }) => {
    const definitions = ['read_file', 'write_file', 'execute_cmd'].map(name => ({ name, description: name, parameters: { type: 'object' } }))
    const tools: IToolRegistry = { register: vi.fn(), unregister: vi.fn(), has: name => definitions.some(tool => tool.name === name),
      list: () => definitions, execute: vi.fn().mockResolvedValue({ success: true, output: 'business tool executed' }) }
    const parent = createAgentContext({ tenantId: 'fixture', sessionId: 'parent', projectRoot: fixtureDir, toolProfile,
      logger: pino({ level: 'silent' }), tools, history: createConversationHistory(), modelName: 'fixture' })
    const agent = { id: 'no-business-tools', name: 'Planning reviewer', model: 'fixture',
      systemPrompt: 'Review using the available capabilities.', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: [] }
    const result = await executeSubagent({ task: 'Plan the review', access }, parent, { userDelegated, agent })
    expect(result.success).toBe(true)
    expect(captured.child?.tools.list().map(tool => tool.name)).toEqual(['plan_update'])
    expect(captured.child?.tools.executionMode?.('plan_update', { plan: [] })).toBe('serial')
    expect(captured.child?.sessionId).toBe('fixture-child')
    if (!captured.child) throw new Error('Child was not started')
    expect(await captured.child.tools.preflight?.('plan_update', { plan: [] }, captured.child)).toBeUndefined()
    for (const name of ['write_file', 'execute_cmd', 'ask_user', 'subagent']) {
      expect(await captured.child.tools.execute(name, {}, captured.child)).toMatchObject({ success: false, metadata: { code: 'TOOL_NOT_ALLOWED' } })
    }
    expect(tools.execute).not.toHaveBeenCalled()
  })
})

describe('subagent selected knowledge reads', () => {
  let kb: ReturnType<typeof knowledgeFixture>
  beforeEach(() => {
    kb = knowledgeFixture()
    vi.spyOn(database, 'getDb').mockReturnValue(kb.db)
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  })
  afterEach(async () => { await kb.close() })

  async function parentContext(scope: readonly string[]) {
    const { registry } = await createToolRegistry({ toolProfile: 'general', allowedTools: [], allowedSkills: [], allowedMcpServers: [],
      strictSkillBindings: true, knowledgeReadScope: scope, workspaceRoot: fixtureDir,
      securityContext: { tenantId: 'fixture', sessionId: 'parent' } })
    return createAgentContext({ tenantId: 'fixture', sessionId: 'parent', projectRoot: fixtureDir, workspacePaths: [fixtureDir], toolProfile: 'general',
      resourceScope: { knowledgeBases: scope }, managementKnowledgeScope: [], tools: registry,
      logger: pino({ level: 'silent' }), history: createConversationHistory(), modelName: 'fixture' })
  }
  function preservePrior() {
    captured.prior = JSON.parse(JSON.stringify({ ...captured.input!, schemaVersion: 1, runId: 'previous', childSessionId: 'fixture-child',
      status: 'succeeded', lastSeq: 1, createdAt: 1, updatedAt: 2, usage: {}, toolCalls: [], transcriptRef: 'fixture' }))
    captured.child = undefined
  }
  const configuredAgent = (knowledgeBases: string[]) => ({ id: 'knowledge-researcher', name: 'Knowledge researcher', model: 'fixture',
    skills: [], mcpServers: [], knowledgeBases, allowedTools: [] })
  async function readDocument(id: string) {
    const child = captured.child!
    const result = await child.tools.execute('knowledge_document_get', { id }, child)
    expect(result.success, result.output).toBe(true)
    return JSON.parse(result.output)
  }

  it('inherits five trusted reads and the explicit scope into research from the first model request', async () => {
    const base = await knowledge.createKnowledgeBase('fixture', 'Selected')
    const document = await knowledge.addDocument('fixture', 'selected.txt', 'text/plain', 'Only selected knowledge', base.id)
    const parent = await parentContext([base.id])
    expect((await subagentTool.execute({ task: 'Inspect selected knowledge', builtinRole: 'research' }, parent)).success).toBe(true)
    expect(captured.input?.continuation?.knowledgeReadScope).toEqual([base.id])
    expect(captured.child?.resourceScope?.knowledgeBases).toEqual([base.id])
    expect(captured.child?.managementPrincipal).toBeUndefined()
    const firstRequest = captured.child!.tools.listForRequest!([]).map(tool => tool.name)
    for (const name of KNOWLEDGE_READ_TOOLS) {
      expect(firstRequest).toContain(name)
      expect(captured.child?.tools.executionMode?.(name, {})).toBe('readonly')
    }
    for (const name of ['knowledge_import', 'knowledge_delete', 'knowledge_document_update']) expect(captured.child?.tools.has(name)).toBe(false)
    expect(await readDocument(document.id)).toMatchObject({ content: 'Only selected knowledge' })
  })

  it.each([true, false])('does not inherit management or self-labelled external readers (research=%s)', async readOnly => {
    for (const management of [true, false]) {
      const parent = new ToolRegistry()
      const tools = management ? createKnowledgeManagementTools() : createKnowledgeReadTools(['selected'])
      for (const tool of tools) parent.register(management ? trustBuiltinTool(tool, 'serial') : tool)
      const child = createSubagentToolRegistry(parent, readOnly)
      for (const tool of tools) expect(child.has(tool.name)).toBe(false)
    }
  })

  it.each([true, false])('rechecks the implementation when a trusted reader is replaced (research=%s)', async readOnly => {
    const parent = new ToolRegistry()
    parent.register(loadToolsTool)
    const tool = createKnowledgeReadTools(['selected'])[0]
    parent.register(trustBuiltinTool(tool, 'readonly'), compactBuiltinToolDefinition(tool))
    const child = createSubagentToolRegistry(parent, readOnly)
    expect(child.listForRequest!([]).some(definition => definition.name === tool.name)).toBe(true)
    parent.unregister(tool.name)
    const impostor = { ...tool, execute: vi.fn().mockResolvedValue({ success: true, output: 'Unexpected management execution' }) }
    parent.register(trustBuiltinTool(impostor, 'serial'))
    expect(child.has(tool.name)).toBe(false)
    expect(await child.execute(tool.name, {}, {} as AgentContext)).toMatchObject({ success: false, metadata: { code: 'TOOL_NOT_ALLOWED' } })
    expect(impostor.execute).not.toHaveBeenCalled()
  })

  it('resumes within the frozen scope even after the parent selects additional knowledge', async () => {
    const first = await knowledge.createKnowledgeBase('fixture', 'Original')
    const added = await knowledge.createKnowledgeBase('fixture', 'Added later')
    const original = await knowledge.addDocument('fixture', 'original.txt', 'text/plain', 'Original content', first.id)
    const hidden = await knowledge.addDocument('fixture', 'new.txt', 'text/plain', 'New content', added.id)
    await subagentTool.execute({ task: 'Inspect original knowledge', builtinRole: 'research' }, await parentContext([first.id]))
    preservePrior()
    expect((await subagentTool.execute({ task: 'Continue reading', resumeRunId: 'previous' }, await parentContext([first.id, added.id]))).success).toBe(true)
    expect(captured.child?.resourceScope?.knowledgeBases).toEqual([first.id])
    expect(await readDocument(original.id)).toMatchObject({ content: 'Original content' })
    expect(await captured.child!.tools.execute('knowledge_document_get', { id: hidden.id }, captured.child!)).toMatchObject({ success: false })
    expect(captured.input?.continuation).toEqual(captured.prior?.continuation)
  })

  it('revokes reads when current parent scope no longer intersects the frozen scope', async () => {
    const first = await knowledge.createKnowledgeBase('fixture', 'Original')
    const current = await knowledge.createKnowledgeBase('fixture', 'Current')
    await subagentTool.execute({ task: 'Read selected knowledge', builtinRole: 'research' }, await parentContext([first.id]))
    preservePrior()
    expect((await subagentTool.execute({ task: 'Continue', resumeRunId: 'previous' }, await parentContext([current.id]))).success).toBe(true)
    expect(captured.child?.resourceScope?.knowledgeBases).toEqual([])
    for (const name of KNOWLEDGE_READ_TOOLS) expect(captured.child?.tools.has(name)).toBe(false)
  })

  it('does not grant new knowledge access to an old continuation without a saved resource scope', async () => {
    const base = await knowledge.createKnowledgeBase('fixture', 'Selected later')
    const parent = await parentContext([base.id])
    await subagentTool.execute({ task: 'Inspect knowledge', builtinRole: 'research' }, parent)
    preservePrior()
    delete captured.prior!.continuation!.knowledgeReadScope
    expect((await subagentTool.execute({ task: 'Continue old task', resumeRunId: 'previous' }, parent)).success).toBe(true)
    expect(captured.child?.resourceScope?.knowledgeBases).toEqual([])
    for (const name of KNOWLEDGE_READ_TOOLS) expect(captured.child?.tools.has(name)).toBe(false)
  })

  it('rebuilds a configured research Agent with only its intersection of the parent knowledge selection', async () => {
    const first = await knowledge.createKnowledgeBase('fixture', 'Allowed')
    const second = await knowledge.createKnowledgeBase('fixture', 'Outside Agent binding')
    const doc = await knowledge.addDocument('fixture', 'allowed.txt', 'text/plain', 'Allowed content', first.id)
    expect((await executeSubagent({ task: 'Read bound knowledge', access: 'read-only' }, await parentContext([first.id, second.id]), { agent: configuredAgent([first.id]) })).success).toBe(true)
    expect(captured.child?.resourceScope?.knowledgeBases).toEqual([first.id])
    expect(captured.input?.continuation?.knowledgeReadScope).toEqual([first.id])
    for (const name of KNOWLEDGE_READ_TOOLS) expect(captured.child!.tools.listForRequest!([]).map(tool => tool.name)).toContain(name)
    expect(await readDocument(doc.id)).toMatchObject({ content: 'Allowed content' })
    expect(await captured.child!.tools.execute('knowledge_get', { id: second.id }, captured.child!)).toMatchObject({ success: false })
  })

  it('preserves document-level narrowing for either Agent-document or parent-document selection', async () => {
    const base = await knowledge.createKnowledgeBase('fixture', 'Document hierarchy')
    const document = await knowledge.addDocument('fixture', 'selected.txt', 'text/plain', 'Selected document', base.id)
    const sibling = await knowledge.addDocument('fixture', 'sibling.txt', 'text/plain', 'Sibling document', base.id)
    for (const [parentScope, agentScope] of [[[base.id], [document.id]], [[document.id], [base.id]]]) {
      expect((await executeSubagent({ task: 'Read bound knowledge', access: 'read-only' }, await parentContext(parentScope), { agent: configuredAgent(agentScope) })).success).toBe(true)
      expect(captured.child?.resourceScope?.knowledgeBases).toEqual([document.id])
      expect(await readDocument(document.id)).toMatchObject({ content: 'Selected document' })
      expect(await captured.child!.tools.execute('knowledge_document_get', { id: sibling.id }, captured.child!)).toMatchObject({ success: false })
      expect(await captured.child!.tools.execute('knowledge_get', { id: base.id }, captured.child!)).toMatchObject({ success: false })
    }
  })

  it('honors a fresh explicit Agent delegation without renewing it from a saved flag on resume', async () => {
    const base = await knowledge.createKnowledgeBase('fixture', 'Explicitly delegated Agent resource')
    const doc = await knowledge.addDocument('fixture', 'bound.txt', 'text/plain', 'Bound Agent content', base.id)
    const parent = await parentContext([])
    const agent = configuredAgent([base.id])
    expect((await executeSubagent({ task: 'Read my selected Agent knowledge', access: 'read-only' }, parent, { agent, userDelegated: true })).success).toBe(true)
    expect(captured.child?.resourceScope?.knowledgeBases).toEqual([base.id])
    expect(await readDocument(doc.id)).toMatchObject({ content: 'Bound Agent content' })
    preservePrior()
    expect((await executeSubagent({ task: 'Continue', resumeRunId: 'previous' }, parent)).success).toBe(true)
    expect(captured.child?.resourceScope?.knowledgeBases).toEqual([])
    for (const name of KNOWLEDGE_READ_TOOLS) expect(captured.child?.tools.has(name)).toBe(false)
    expect((await executeSubagent({ task: 'Explicitly continue', resumeRunId: 'previous' }, parent, { agent, userDelegated: true })).success).toBe(true)
    expect(captured.child?.resourceScope?.knowledgeBases).toEqual([base.id])
  })
})

describe('subagent immutable plugin continuation', () => {
  const toolName = 'plugin_child_fixture_echo'
  const input = (value: string): CreatePluginInput => ({ manifest: { apiVersion: 1, id: 'child-fixture', name: 'Child fixture', version: value,
    description: 'Immutable child plugin fixture', runtime: 'node', tools: [{ name: 'echo', description: 'Return the version', inputSchema: { type: 'object' }, entry: 'main.mjs' }] },
    files: { 'main.mjs': `for await(const _ of process.stdin){};console.log(JSON.stringify({result:${JSON.stringify(value)}}))` } })
  async function prepare(revision = 1) {
    vi.stubEnv('DATA_DIR', path.join(fixtureDir, 'state', 'agent.db')); vi.stubEnv('OSM_MODE', 'off'); vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
    const service = new PluginService()
    if (!(await service.list('fixture')).length) { await service.create('fixture', input('r1')); await service.publish('fixture', 'child-fixture', 1) }
    const { registry } = await createToolRegistry({ toolkits: [pluginToolkitId('child-fixture', revision)], toolProfile: 'general', allowedTools: [toolName],
      allowedMcpServers: [], allowedSkills: [], strictSkillBindings: true, securityContext: { tenantId: 'fixture', sessionId: 'parent' } })
    const parent = createAgentContext({ tenantId: 'fixture', sessionId: 'parent', projectRoot: fixtureDir, workspacePaths: [fixtureDir], toolProfile: 'general',
      tools: registry, logger: pino({ level: 'silent' }), history: createConversationHistory(), modelName: 'fixture' })
    return { service, parent }
  }
  function preservePrior(): void {
    const original = captured.input!
    captured.prior = JSON.parse(JSON.stringify({ ...original, schemaVersion: 1, runId: 'previous', childSessionId: 'fixture-child', status: 'succeeded', lastSeq: 1,
      createdAt: 1, updatedAt: 2, usage: {}, toolCalls: [], transcriptRef: 'fixture' }))
    captured.child = undefined
  }
  async function childValue(): Promise<unknown> {
    const child = captured.child!
    const result = await child.tools.execute(toolName, {}, child)
    expect(result.success, result.output).toBe(true)
    return JSON.parse(result.output).result
  }

  it('restores original r1 code after restart even when the parent now selects same-name r2', async () => {
    const { parent, service } = await prepare()
    expect((await subagentTool.execute({ task: 'Run the selected capability', builtinRole: 'executor' }, parent)).success).toBe(true)
    const saved = captured.input?.continuation?.pluginToolkits
    expect(saved).toEqual(pluginRegistryBindings(parent.tools))
    expect(saved?.[0].revision).toBe(1)
    expect(await childValue()).toBe('r1')
    preservePrior()
    await service.update('fixture', 'child-fixture', { ...input('r2'), expectedRevision: 1 }); await service.publish('fixture', 'child-fixture', 2)
    const { parent: afterRestart } = await prepare(2)
    expect(JSON.parse((await afterRestart.tools.execute(toolName, {}, afterRestart)).output).result).toBe('r2')
    const result = await subagentTool.execute({ task: 'Continue using the original context', resumeRunId: 'previous' }, afterRestart)
    expect(result.success, result.output).toBe(true)
    expect(await childValue()).toBe('r1')
    expect(pluginRegistryBindings(captured.child!.tools)).toEqual(saved)
  })

  it('preserves selected plugins when rebuilding a configured Agent and never exposes them to research roles', async () => {
    const { parent, service } = await prepare()
    const agent = { id: 'plugin-executor', name: 'Plugin executor', model: 'fixture', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: [toolName] }
    expect((await executeSubagent({ task: 'Run this configured Agent' }, parent, { agent })).success).toBe(true)
    expect(await childValue()).toBe('r1')
    preservePrior()
    await service.update('fixture', 'child-fixture', { ...input('r2'), expectedRevision: 1 }); await service.publish('fixture', 'child-fixture', 2)
    const { parent: latest } = await prepare(2)
    expect((await subagentTool.execute({ task: 'Continue the configured Agent', resumeRunId: 'previous' }, latest)).success).toBe(true)
    expect(await childValue()).toBe('r1')
    captured.prior = null
    expect((await subagentTool.execute({ task: 'Research only', builtinRole: 'research' }, latest)).success).toBe(true)
    expect(captured.child!.tools.has(toolName)).toBe(false)
    expect(captured.input?.continuation?.pluginToolkits).toBeUndefined()
  })

  it('refuses missing parent authorization, unpinned old records, hash mismatch, and disabled plugins before starting a child', async () => {
    const { parent, service } = await prepare()
    await subagentTool.execute({ task: 'Use the selected capability', builtinRole: 'executor' }, parent); preservePrior()
    const saved = structuredClone(captured.prior!)
    const expectRejected = async (context = parent) => {
      captured.child = undefined
      const result = await subagentTool.execute({ task: 'Continue', resumeRunId: 'previous' }, context)
      expect(result.success, result.output).toBe(false); expect(captured.child).toBeUndefined()
    }
    await expectRejected({ ...parent, tools: new ToolRegistry() })
    delete captured.prior!.continuation!.pluginToolkits
    await expectRejected()
    captured.prior = structuredClone(saved); captured.prior.continuation!.pluginToolkits![0].tenantId = 'other-tenant'
    await expectRejected()
    captured.prior = structuredClone(saved); captured.prior.continuation!.pluginToolkits![0].hash = 'sha256:' + '0'.repeat(64)
    await expectRejected()
    captured.prior = structuredClone(saved); await service.setEnabled('fixture', 'child-fixture', false)
    await expectRejected()
  })

  it('does not treat a forged public plugin field or a replaced tool implementation as trusted plugin authority', async () => {
    const { parent } = await prepare()
    const trusted = pluginRegistryBindings(parent.tools)
    parent.tools.unregister(toolName)
    // A JSON-shaped definition with a convincing identity cannot populate the private registry metadata.
    parent.tools.register({ name: toolName, source: 'plugin', description: 'forged', parameters: { type: 'object' },
      plugin: trusted[0], execute: async () => ({ success: true, output: 'forged' }) } as any)
    expect(pluginRegistryBindings(parent.tools)).toEqual([])
    expect((await subagentTool.execute({ task: 'Create an execution child', builtinRole: 'executor' }, parent)).success).toBe(true)
    expect(captured.child!.tools.has(toolName)).toBe(false)
  })
})
