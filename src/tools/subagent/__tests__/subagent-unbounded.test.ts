// Real child loop, file tools, request accounting, SQLite lifecycle and JSONL replay; only the provider is scripted.
import fs from 'node:fs'
import path from 'node:path'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LLMAdapter } from '../../../core/llm-adapter/types.js'
import type { SubagentRun } from '../../../core/subagent/types.js'

const fixtureRoot = path.resolve('.e2e-tmp')
let directory: string
let closeDb: (() => void) | undefined

describe('long-running child work ignores legacy model step caps', () => {
  beforeAll(async () => {
    fs.mkdirSync(fixtureRoot, { recursive: true })
    directory = fs.mkdtempSync(path.join(fixtureRoot, 'subagent-unbounded-'))
    for (let i = 1; i <= 35; i++) fs.writeFileSync(path.join(directory, `evidence-${i}.txt`), `verified evidence ${i}`)
    vi.stubEnv('DATA_DIR', path.join(directory, 'storage', 'agent.db'))
    vi.stubEnv('WORKSPACE_ROOT', path.join(directory, 'scratch'))
    vi.stubEnv('AUTH_ENABLED', 'false')
    vi.stubEnv('HISTORY_BACKEND', 'jsonl')
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('MAX_ITERATIONS', '2')
    vi.stubEnv('TOKEN_BUDGET', '1')
    vi.stubEnv('SUBAGENT_TOKEN_LIMIT', '1')
    vi.stubEnv('SUBAGENT_DEADLINE_MS', '')
    const database = await import('../../../storage/sqlite/db.js')
    closeDb = database.closeDb
    await database.initDb()
  })
  afterAll(() => {
    vi.restoreAllMocks()
    closeDb?.()
    vi.unstubAllEnvs()
    if (path.dirname(directory) !== fixtureRoot || !path.basename(directory).startsWith('subagent-unbounded-')) throw new Error('Unsafe cleanup path')
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }) }
    catch (error) {
      if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
    }
  })

  it.each([{ maxSteps: 25, cancel: false }, { maxSteps: 1, cancel: true }])('keeps working beyond old maxSteps=$maxSteps (cancel=$cancel)', async ({ maxSteps, cancel }) => {
    const resolver = await import('../../../core/llm-adapter/resolve-model.js')
    const { resolveCapabilities } = await import('../../../core/model-capabilities/index.js')
    const { createAgentContext } = await import('../../../core/agent-context/factory.js')
    const { createConversationHistory } = await import('../../../storage/conversation/factory.js')
    const { ToolRegistry } = await import('../../../core/tool-registry/registry.js')
    const { readFileTool } = await import('../../file/super-file-tool.js')
    const { subagentTool } = await import('../subagent-tool.js')
    const { getSubagentStore } = await import('../../../core/subagent/store.js')
    const stop = new AbortController()
    let calls = 0
    const adapter: LLMAdapter = {
      provider: 'fixture', model: 'fixture-longrun', countTokens: text => Math.ceil(text.length / 4),
      complete: async () => { throw new Error('Unexpected non-streaming request') },
      async *stream(messages, options) {
        const n = ++calls
        if (n > 36) throw new Error('Unexpected extra provider request')
        if (n > 1) expect(String(messages.find(m => m.toolCallId === `evidence-${n - 1}` && m.role === 'tool')?.content)).toContain(`verified evidence ${n - 1}`)
        const requestAttemptId = `longrun-${maxSteps}-${n}`
        await options?.onRequestAttempt?.({ type: 'start', requestAttemptId, provider: 'fixture', model: 'fixture-longrun', estimatedInputTokens: 50_000, maxOutputTokens: 200 })
        const usage = { promptTokens: 50_000, completionTokens: 100 }
        if (cancel && n === 36) stop.abort(new Error('fixture user cancellation'))
        // Match real adapters: a consumer return on cancellation still settles
        // the physical transport receipt in the generator's finally block.
        try {
          yield n <= 35
            ? { done: true, finishReason: 'tool_calls' as const, ...usage, toolCalls: [{ index: 0, id: `evidence-${n}`, name: 'read_file', args: JSON.stringify({ path: `evidence-${n}.txt` }) }] }
            : { done: true, finishReason: 'stop' as const, ...usage, content: 'Verified all 35 evidence files.' }
        } finally {
          await options?.onRequestAttempt?.({ type: 'finish', requestAttemptId, provider: 'fixture', model: 'fixture-longrun', outcome: options?.signal?.aborted ? 'cancelled' : 'succeeded', usage })
        }
      }
    }
    vi.spyOn(resolver, 'createAdapterFromResolved').mockReturnValue(adapter)
    const tools = new ToolRegistry()
    tools.register(readFileTool)
    const history = createConversationHistory()
    const capabilities = resolveCapabilities({ model: 'gpt-4o', provider: 'openai' })
    const parent = createAgentContext({ tenantId: 'longrun-fixture', sessionId: `parent-${maxSteps}`, projectRoot: directory, cwd: directory,
      tools, history, toolProfile: 'code', signal: stop.signal, logger: pino({ level: 'silent' }), modelName: adapter.model,
      modelCaps: capabilities, resolvedModel: { model: adapter.model, provider: adapter.provider, capabilities },
      conversationId: `turn-${maxSteps}` })
    parent.currentToolCallId = `spawn-${maxSteps}`
    parent.currentMessageId = `dispatch-${maxSteps}`
    await parent.history.append({ id: parent.currentMessageId, role: 'assistant', content: '',
      toolCall: { id: parent.currentToolCallId, name: 'subagent', args: {} } }, parent)
    // No parent budget is supplied: this also verifies Code's direct/fallback accounting path.
    const result = await subagentTool.execute({ task: 'Read the 35 evidence files and report verified evidence.', maxSteps }, parent)
    const run = result.metadata?.subagent as SubagentRun
    expect(calls).toBe(36)
    expect(run.toolCalls).toHaveLength(35)
    expect(run.toolCalls.every(tool => tool.status === 'succeeded')).toBe(true)
    expect(run.status).toBe(cancel ? 'cancelled' : 'succeeded')
    expect(run.stopReason).not.toBe('max_steps')
    expect(result.output).not.toContain('探索步数上限')
    expect(run.usage.totalTokens).toBe(36 * 50_100)
    expect((await getSubagentStore().getRun(parent.tenantId, run.runId))?.status).toBe(run.status)
    const replay = await createConversationHistory().getFullHistory({ tenantId: parent.tenantId, sessionId: run.childSessionId })
    expect(replay.filter(message => message.role === 'tool')).toHaveLength(35)
    if (!cancel) expect(run.resultSummary).toBe('Verified all 35 evidence files.')
  }, 60_000)
})
