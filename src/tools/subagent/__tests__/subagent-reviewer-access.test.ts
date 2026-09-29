// Exercises the real subagent tool's child-context construction; model/runner I/O are replaced at their boundaries.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, IToolRegistry } from '../../../core/agent-context/types.js'
import type { CreateSubagentRun, SubagentRun } from '../../../core/subagent/types.js'
import type { SubagentExecution } from '../../../core/subagent/runner.js'
import { createAgentContext } from '../../../core/agent-context/factory.js'
import { createConversationHistory } from '../../../storage/conversation/factory.js'
import { subagentTool } from '../subagent-tool.js'

const captured = vi.hoisted(() => ({ child: undefined as AgentContext | undefined }))

vi.mock('../../../core/subagent/runner.js', () => ({
  getSubagentRunner: () => ({
    run: async (input: CreateSubagentRun, _parent: AgentContext, execute: (execution: SubagentExecution) => Promise<void>) => {
      const snapshot: SubagentRun = { ...input, schemaVersion: 1, runId: 'fixture-run', childSessionId: 'fixture-child',
        status: 'running', lastSeq: 1, createdAt: 1, updatedAt: 1, usage: {}, toolCalls: [], transcriptRef: 'fixture' }
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
  resolveModelConfig: async () => ({ model: 'fixture', provider: 'fixture', capabilities: { contextWindow: 100_000 } }),
  createAdapterFromResolved: () => ({}),
}))
vi.mock('../../../storage/conversation/factory.js', () => ({ createConversationHistory: () => ({}) }))
vi.mock('../../../core/project-context.js', () => ({ getProjectContextBlock: () => '' }))

let fixtureDir: string
beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-reviewer-access-'))
  vi.stubEnv('WORKSPACE_ROOT', fixtureDir)
  captured.child = undefined
})
afterEach(() => {
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
    expect(child.tools.list().map((tool) => tool.name)).toEqual(['read_file'])
    const blocked = await child.tools.execute('write_file', { path: 'README.md', content: 'unexpected mutation' }, child)
    expect(blocked).toMatchObject({ success: false, metadata: { blocked: true, code: 'TOOL_NOT_ALLOWED' } })
    expect(tools.execute).not.toHaveBeenCalled()
    await child.tools.execute('read_file', { path: 'README.md' }, child)
    expect(tools.execute).toHaveBeenCalledWith('read_file', { path: 'README.md' }, child)
  })
})
