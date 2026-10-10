// Real subagent orchestration, rg, read_file, SQLite lifecycle and JSONL history; only the model adapter is scripted.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LLMAdapter } from '../../../core/llm-adapter/types.js'
import type { SubagentRun } from '../../../core/subagent/types.js'

const rgAvailable = spawnSync('rg', ['--version'], { windowsHide: true }).status === 0
const fixtureRoot = path.resolve('.e2e-tmp')
let fixtureDir: string
let projectRoot: string
let closeDb: (() => void) | undefined

describe.skipIf(!rgAvailable)('subagent project overview with real search and history', () => {
  beforeAll(async () => {
    fs.mkdirSync(fixtureRoot, { recursive: true })
    fixtureDir = fs.mkdtempSync(path.join(fixtureRoot, 'subagent-overview-'))
    projectRoot = path.join(fixtureDir, 'project')
    fs.mkdirSync(projectRoot)
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Sample project\nPROJECT_PURPOSE: Electron IDE for project research\nENTRY: src/main/index.ts\n')
    vi.stubEnv('DATA_DIR', path.join(fixtureDir, 'storage', 'agent.db'))
    vi.stubEnv('WORKSPACE_ROOT', path.join(fixtureDir, 'scratch'))
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('HISTORY_BACKEND', 'jsonl')
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('SUBAGENT_TOKEN_LIMIT', '')
    // Delay engine imports until its complete database and scratch configuration point at this fixture.
    const database = await import('../../../storage/sqlite/db.js')
    closeDb = database.closeDb
    await database.initDb()
  })

  afterAll(() => {
    vi.restoreAllMocks()
    closeDb?.()
    vi.unstubAllEnvs()
    if (path.dirname(fixtureDir) !== fixtureRoot || !path.basename(fixtureDir).startsWith('subagent-overview-')) throw new Error('Unsafe fixture cleanup path')
    try { fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }) }
    catch (error) {
      // Native libsql transaction handles can outlive closeDb until the Windows worker exits.
      if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
    }
  })

  it('searches, reads and summarizes above 500000 simulated cumulative tokens without an implicit cap', async () => {
    const resolver = await import('../../../core/llm-adapter/resolve-model.js')
    const { resolveCapabilities } = await import('../../../core/model-capabilities/index.js')
    const { createAgentContext } = await import('../../../core/agent-context/factory.js')
    const { createConversationHistory } = await import('../../../storage/conversation/factory.js')
    const { ToolRegistry } = await import('../../../core/tool-registry/registry.js')
    const { grepTool } = await import('../../search/grep-tool.js')
    const { readFileTool } = await import('../../file/super-file-tool.js')
    const { subagentTool } = await import('../subagent-tool.js')
    const { getSubagentStore } = await import('../../../core/subagent/store.js')
    const { RequestBudget, parseRequestTokenLimit } = await import('../../../core/subagent/budget.js')
    let calls = 0
    let searchEvidence = ''
    let readEvidence = ''
    const adapter: LLMAdapter = {
      provider: 'fixture', model: 'fixture-overview', countTokens: (text) => Math.ceil(text.length / 4),
      complete: async () => { throw new Error('Unexpected model completion') },
      async *stream(messages, options) {
        const requestAttemptId = `overview-attempt-${++calls}`
        // These are local fixture counters, not real provider requests or billed tokens.
        await options?.onRequestAttempt?.({ type: 'start', requestAttemptId, provider: 'fixture', model: 'fixture-overview', estimatedInputTokens: 180_000, maxOutputTokens: 100 })
        const usage = { promptTokens: 180_000, completionTokens: 20_000 }
        if (calls === 1) {
          expect(messages.find((message) => message.role === 'user')?.content).toBe('Inspect this project: search its purpose, read the source evidence, and summarize it.')
          yield { done: true, finishReason: 'tool_calls', ...usage,
            toolCalls: [{ id: 'overview-search', name: 'grep_search', args: JSON.stringify({ pattern: 'PROJECT_PURPOSE', maxResults: 3 }), index: 0 }] }
        } else if (calls === 2) {
          searchEvidence = String(messages.find((message) => message.role === 'tool' && message.toolName === 'grep_search')?.content ?? '')
          expect(searchEvidence).toContain('Found 1 match(es) [ripgrep]')
          expect(searchEvidence).toContain('README.md:2:PROJECT_PURPOSE: Electron IDE for project research')
          yield { done: true, finishReason: 'tool_calls', ...usage,
            toolCalls: [{ id: 'overview-read', name: 'read_file', args: JSON.stringify({ path: 'README.md' }), index: 0 }] }
        } else if (calls === 3) {
          readEvidence = String(messages.find((message) => message.role === 'tool' && message.toolName === 'read_file')?.content ?? '')
          expect(readEvidence).toContain('ENTRY: src/main/index.ts')
          yield { done: true, finishReason: 'stop', ...usage,
            content: `Project overview:\n${searchEvidence}\n${readEvidence}` }
        } else { throw new Error('Unexpected extra model request') }
        await options?.onRequestAttempt?.({ type: 'finish', requestAttemptId, provider: 'fixture', model: 'fixture-overview', outcome: 'succeeded', usage })
      },
    }
    vi.spyOn(resolver, 'createAdapterFromResolved').mockReturnValue(adapter)
    const tools = new ToolRegistry()
    tools.register(grepTool)
    tools.register(readFileTool)
    const history = createConversationHistory()
    const resolvedModel = { model: 'fixture-overview', provider: 'fixture', capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }) }
    const parent = createAgentContext({ tenantId: 'overview-tenant', sessionId: 'overview-parent', projectRoot, cwd: projectRoot,
      logger: pino({ level: 'silent' }), tools, history, tokenBudget: 100_000, modelName: resolvedModel.model,
      resolvedModel, modelCaps: resolvedModel.capabilities, conversationId: 'overview-turn', currentMessageId: 'overview-dispatch' })
    parent.currentToolCallId = 'overview-spawn'
    const requestBudget = new RequestBudget(parseRequestTokenLimit(undefined))
    parent.requestBudget = requestBudget
    parent.onRequestAttempt = (event) => requestBudget.observe(event)
    const task = 'Inspect this project: search its purpose, read the source evidence, and summarize it.'
    await history.append({ role: 'user', content: 'Use a subagent to inspect this project.' }, parent)
    await history.append({ id: 'overview-dispatch', role: 'assistant', content: '', toolCallId: 'overview-spawn',
      toolCall: { id: 'overview-spawn', name: 'subagent', args: { task } } }, parent)
    const result = await subagentTool.execute({ task, description: 'Project overview' }, parent)
    expect(result.success).toBe(true)
    expect(calls).toBe(3)
    expect(result.output).toContain(searchEvidence)
    expect(result.output).toContain(readEvidence)
    const run = result.metadata?.subagent as SubagentRun
    expect(run.status).toBe('succeeded')
    expect(run.toolCalls.map((tool) => [tool.name, tool.status])).toEqual([['grep_search', 'succeeded'], ['read_file', 'succeeded']])
    expect(run.usage.totalTokens).toBe(600_000)
    expect(requestBudget.limit).toBe(Infinity)
    expect(requestBudget.snapshot).toMatchObject({ charged: 600_000, reserved: 0, remaining: Infinity })
    expect((await getSubagentStore().getRun(parent.tenantId, run.runId))?.resultSummary).toBe(run.resultSummary)
    expect(result.output).toContain(`[子任务状态] {"runId":"${run.runId}"`)
    expect(result.output).toContain(run.resultSummary)
    const childHistory = await createConversationHistory().getFullHistory({ tenantId: parent.tenantId, sessionId: run.childSessionId })
    expect(childHistory.filter((message) => message.role === 'tool').map((message) => message.toolName)).toEqual(['grep_search', 'read_file'])
    expect(childHistory.at(-1)?.content).toBe(run.resultSummary)
    const parentHistory = await history.getFullHistory(parent)
    expect(parentHistory.find((message) => message.id === `subagent-result:${run.runId}`)).toMatchObject({
      role: 'tool', toolCallId: 'overview-spawn', content: result.output, metadata: { success: true, subagent: { runId: run.runId, status: 'succeeded' } },
    })
  })
})
