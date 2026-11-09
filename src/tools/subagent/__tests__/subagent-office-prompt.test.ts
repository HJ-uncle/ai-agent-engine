// Real child construction, registry and ReAct model requests; only model/runner I/O is scripted.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/types.js'
import type { CreateSubagentRun, SubagentRunHeader } from '../../../core/subagent/types.js'
import type { SubagentExecution } from '../../../core/subagent/runner.js'
import type { LLMAdapterOptions } from '../../../core/llm-adapter/types.js'
import { createAgentContext } from '../../../core/agent-context/factory.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { WorkspaceManager, workspaceManager } from '../../../workspace/index.js'
import { skillsRegistry } from '../../../skills/index.js'
import { createToolRegistry } from '../../registry-factory.js'
import { executeSubagent } from '../subagent-tool.js'
import { buildOfficeExecutionPrompt } from '../../../core/office-prompt.js'

const model = vi.hoisted(() => ({ requests: [] as LLMAdapterOptions[],
  sessions: new Map<string, Message[]>(), prior: null as SubagentRunHeader | null }))
vi.mock('../../../core/llm-adapter/resolve-model.js', () => ({
  resolveModelConfig: async () => ({ model: 'scripted-office', provider: 'fixture', capabilities: { contextWindow: 100_000 } }),
  createAdapterFromResolved: () => ({ model: 'scripted-office', provider: 'fixture', countTokens: () => 0,
    complete: () => { throw new Error('Unexpected completion request') },
    async *stream(_messages: Message[], options: LLMAdapterOptions) {
      model.requests.push(options)
      yield { done: true, content: '已核对本次办公规则与工具范围，未修改文件。', finishReason: 'stop' }
    },
  }),
}))
vi.mock('../../../core/subagent/runner.js', () => ({
  getSubagentRunner: () => ({
    store: { getRunHeader: async () => model.prior },
    run: async (input: CreateSubagentRun, _parent: AgentContext, execute: (execution: SubagentExecution) => Promise<void>) => {
      const snapshot: SubagentRunHeader = { ...input, schemaVersion: 1, runId: 'office-fixture-run', childSessionId: 'office-fixture-child',
        status: 'running', lastSeq: 1, createdAt: 1, updatedAt: 1, usage: {}, toolCount: 0, activeToolCount: 0, nonPlanToolCount: 0, transcriptRef: 'fixture' }
      await execute({ snapshot, signal: new AbortController().signal, onRequestAttempt: vi.fn(), observer: {
        onOutcome: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn(), onUsage: vi.fn(),
      } })
      return { ...snapshot, status: 'succeeded', resultSummary: 'fixture' }
    },
  }),
}))
vi.mock('../../../storage/conversation/factory.js', () => ({ createConversationHistory: () => ({
  async append(message: Message, ctx: AgentContext) {
    const messages = model.sessions.get(ctx.sessionId) ?? []
    messages.push(message); model.sessions.set(ctx.sessionId, messages)
    return message.id ?? 'fixture-message'
  },
  async getHistory(ctx: AgentContext) { return [...(model.sessions.get(ctx.sessionId) ?? [])] },
  async getRawTokenCount() { return 0 },
}) }))
vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
vi.mock('../../../storage/mcp/mcp-config.js', () => ({ listServers: () => [] }))

let fixture: string
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-subagent-office-prompt-'))
  vi.stubEnv('WORKSPACE_ROOT', path.join(fixture, 'scratch'))
  vi.stubEnv('AUTH_ENABLED', 'true'); vi.stubEnv('OSM_MODE', 'balanced'); vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', fixture)
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(fixture, 'bindings.json'))
  const manager = new WorkspaceManager(path.join(fixture, 'scratch'))
  manager.bind({ tenantId: 'fixture', sessionId: 'parent' }, fixture)
  vi.spyOn(workspaceManager, 'getPaths').mockImplementation(scope => manager.getPaths(scope))
  vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation((scope, expected) => manager.bindingReadGuard(scope, expected))
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([])
  model.requests = []; model.sessions.clear(); model.prior = null
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-subagent-office-prompt-')) throw new Error('Unsafe cleanup')
  fs.rmSync(fixture, { recursive: true, force: true })
})

async function parentContext() {
  const prepared = await createToolRegistry({ toolProfile: 'general', workspaceRoot: fixture,
    allowedTools: ['read_file', 'write_file', 'get_skill', 'office_document', 'office_inspect'],
    allowedSkills: [], strictSkillBindings: true, allowedMcpServers: [], memoryScopes: [] })
  const parent = createAgentContext({ tenantId: 'fixture', sessionId: 'parent', toolProfile: 'general', workspacePaths: [fixture], projectRoot: fixture,
    logger: pino({ level: 'silent' }), tools: prepared.registry, history: createConversationHistory(), modelName: 'scripted-office', memoryScopes: [] })
  return { prepared, parent }
}

describe('Office workflow in actual subagent model requests', () => {
  it.each(['inherited', 'selected'])('%s executor receives the shared Office workflow and admitted skill exactly once', async mode => {
    const { prepared, parent } = await parentContext()
    const agent = { id: 'selected-office', name: 'Selected Office', skills: [], mcpServers: [], knowledgeBases: [],
      allowedTools: ['read_file', 'write_file', 'get_skill', 'office_document', 'office_inspect'] }
    const result = await executeSubagent({ task: '根据已有共享草稿制作分工内办公文件；本测试只核对指令，不写文件。', ...(mode === 'inherited' ? { builtinRole: 'executor' } : {}) }, parent,
      mode === 'selected' ? { agent, userDelegated: true } : {})
    expect(result.success, result.output).toBe(true)
    expect(model.requests).toHaveLength(1)
    const prompt = model.requests[0].systemPrompt!
    const office = buildOfficeExecutionPrompt('general', prepared.registry, prepared.externalSkills)
    expect(prompt.split(office)).toHaveLength(2)
    expect(prompt.split('# Available Skills Index')).toHaveLength(2)
    expect(prompt).toContain('Read aether-office with get_skill first')
    expect(prompt).toContain('已有共享草稿就直接复用')
    expect(prompt).toContain('同版本可信校验回执就复用')
    expect(prompt).not.toContain('deliver_files成功后')
    expect(model.requests[0].tools?.some(tool => tool.name === 'get_skill')).toBe(true)
  })

  it('readonly research receives only Office reading guidance and no native creation skill', async () => {
    const { parent } = await parentContext()
    expect((await executeSubagent({ task: '只读审查已有材料，不写文件', builtinRole: 'research' }, parent)).success).toBe(true)
    const prompt = model.requests[0].systemPrompt!
    expect(prompt).toContain('## Office reading')
    expect(prompt).not.toContain('## Office delivery')
    expect(prompt).not.toContain('**aether-office**')
    expect(prompt).not.toContain('Read aether-office')
  })

  it('resumed executors retain their frozen role but receive the current shared Office workflow once', async () => {
    const { prepared, parent } = await parentContext()
    model.prior = { schemaVersion: 1, runId: 'prior-office', childSessionId: 'office-fixture-child', tenantId: 'fixture',
      parentSessionId: 'parent', rootSessionId: 'parent', parentConversationId: 'old-turn', parentMessageId: 'old-message', parentToolCallId: 'old-call',
      task: 'Original Office work', description: 'Office executor', modelId: 'scripted-office', status: 'succeeded', lastSeq: 1,
      createdAt: 1, updatedAt: 1, usage: {}, toolCount: 0, activeToolCount: 0, nonPlanToolCount: 0, transcriptRef: 'fixture',
      continuation: { builtinRole: 'executor', builtinRoleVersion: 1, readOnly: false, systemPrompt: 'FROZEN_CUSTOM_ROLE',
        toolNames: prepared.registry.list().map(tool => tool.name), workspacePaths: [fixture], projectRoot: fixture, cwd: fixture } }
    expect((await executeSubagent({ resumeRunId: 'prior-office', task: '复用共享草稿继续办公工作；仅核对当前规则' }, parent)).success).toBe(true)
    const prompt = model.requests[0].systemPrompt!
    expect(prompt).toContain('FROZEN_CUSTOM_ROLE')
    expect(prompt.split(buildOfficeExecutionPrompt('general', prepared.registry, prepared.externalSkills))).toHaveLength(2)
    expect(prompt.split('# Available Skills Index')).toHaveLength(2)
    expect(prompt).toContain('Read aether-office with get_skill first')
  })
})
