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
import { executeSubagent, subagentStartTool, subagentTool } from '../subagent-tool.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { officeInspectTool } from '../../office/index.js'
import { WorkspaceManager, workspaceManager } from '../../../workspace/index.js'

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
