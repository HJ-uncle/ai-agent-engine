// Real HTTP /chat, ReAct, child runner, tool/file side effects, SQLite and JSONL replay. Only the model and MCP transport are controlled.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LLMAdapter, LLMAdapterOptions } from '../../../../core/llm-adapter/types.js'
import type { Agent, SQLiteAgentStore } from '../../../../storage/agent/index.js'
import type { Message } from '../../../../core/agent-context/types.js'
import type { SubagentRun } from '../../../../core/subagent/types.js'

const tenantId = 'collaborator-tenant'
let fixture: string
let app: FastifyInstance
let baseUrl: string
let closeDatabase: () => Promise<void>
let agentStore: SQLiteAgentStore
let frontend: Agent
let main: Agent
let modelCalls: Array<{ model: string; messages: Message[]; options?: LLMAdapterOptions }> = []
let executedMcp = 0
let waitForChild: (() => void) | undefined
let slowChildStarted = false
let failParentOnce = false
const mcpDiscoveryScopes: Array<{ sessionId?: string; servers?: readonly string[] | null }> = []

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-collaborator-chat-'))
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(fixture, 'agent.db'), WORKSPACE_ROOT: path.join(fixture, 'scratch'),
    HISTORY_BACKEND: 'jsonl', MEMORY_DB_PATH: path.join(fixture, 'memory.db'), AETHER_GLOBAL_DIR: path.join(fixture, 'global'),
    SKILLS_ROOT: path.join(fixture, 'skills'), OSM_MODE: 'off', AUTH_ENABLED: 'false', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false',
    AGENT_TOTAL_TOKEN_LIMIT: '', SUBAGENT_TOKEN_LIMIT: '', DEFAULT_SECURITY_MODE: 'standard' })) vi.stubEnv(key, value)
  const database = await import('../../../../storage/sqlite/db.js')
  await database.initDb()
  closeDatabase = async () => {
    const db = database.getDb() as import('../../../../storage/sqlite/local-process-client.js').LocalSqliteProcessClient
    database.closeDb()
    await db.whenClosed()
    await (await import('../../../../storage/memory/db.js')).closeMemoryDb()
  }
  const storage = await import('../../../../storage/agent/index.js')
  agentStore = new storage.SQLiteAgentStore()
  main = await agentStore.create(tenantId, { name: '主助手', systemPrompt: 'MAIN_PROFILE', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: [] })
  frontend = await agentStore.create(tenantId, { name: '前端工程师', systemPrompt: 'FRONTEND_PROFILE_ORIGINAL', model: 'frontend-fixture', temperature: 0.35,
    skills: ['design'], mcpServers: ['docs'], knowledgeBases: ['frontend-kb'],
    allowedTools: ['write_file', 'get_skill', 'list_skills', 'mcp_docs_lookup', 'subagent', 'ask_user'] })
  const { skillsRegistry } = await import('../../../../skills/index.js')
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([
    { name: 'design', description: 'DESIGN_SKILL_INDEX', skillMdPath: '', inlineContent: 'DESIGN_SKILL_CONTENT', enabled: true, order: 1 },
    { name: 'unbound', description: 'UNBOUND_SKILL', skillMdPath: '', inlineContent: 'UNBOUND_CONTENT', enabled: true, order: 2 },
  ])
  const knowledge = await import('../../../../storage/knowledge/kb-repo.js')
  vi.spyOn(knowledge, 'searchChunks').mockImplementation(async (_tenant, _query, _top, ids) => ids?.includes('frontend-kb')
    ? [{ chunkId: 'chunk', documentId: 'document', knowledgeBaseId: 'frontend-kb', chunkIndex: 0,
      content: 'FRONTEND_KNOWLEDGE_CONTEXT', filename: 'frontend-guide.md', score: 1 }] : [])
  const mcp = await import('../../../../tools/mcp/loader.js')
  vi.spyOn(mcp, 'registerMCPTools').mockImplementation(async (registry, filter, _inline, _security, _workspace, _signal, ids) => {
    mcpDiscoveryScopes.push({ sessionId: _security?.sessionId, servers: ids })
    if (!ids?.includes('docs') || (filter && !filter('mcp_docs_lookup'))) return []
    registry.register({ name: 'mcp_docs_lookup', description: 'Bound documentation lookup', parameters: { type: 'object' }, source: 'mcp',
      execute: async () => { executedMcp++; return { success: true, output: 'MCP_DOCS_RESULT' } } } as import('../../../../core/agent-context/types.js').Tool)
    return ['mcp_docs_lookup']
  })
  const factory = await import('../../../../tools/registry-factory.js')
  const realFactory = factory.createToolRegistry
  vi.spyOn(factory, 'createToolRegistry').mockImplementation(async options => {
    if (options?.strictSkillBindings && options.allowedTools?.includes('catalog_fixture_failure')) throw new Error('COLLABORATOR_CATALOG_UNAVAILABLE')
    return realFactory(options)
  })
  const resolver = await import('../../../../core/llm-adapter/resolve-model.js')
  const { resolveCapabilities } = await import('../../../../core/model-capabilities/index.js')
  vi.spyOn(resolver, 'resolveModelConfig').mockImplementation(async ({ model, parent }) => ({ model: model ?? parent?.model ?? 'main-fixture',
    provider: 'fixture', capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
  vi.spyOn(resolver, 'createAdapterFromResolved').mockImplementation(config => {
    const adapter: LLMAdapter = { provider: 'fixture', model: config.model, countTokens: text => Math.ceil(text.length / 4),
      complete: async () => { throw new Error('Unexpected completion transport') },
      async *stream(messages, options) {
        modelCalls.push({ model: config.model, messages: structuredClone(messages), options })
        if (config.model !== 'frontend-fixture') {
          if (failParentOnce) { failParentOnce = false; throw new Error('PARENT_PROVIDER_FIXTURE_FAILURE') }
          const results = messages.filter(message => message.role === 'tool' && message.toolName === 'subagent')
          yield { done: true, finishReason: 'stop', content: `MAIN_SUMMARY\n${results.map(result => result.content).join('\n')}`, promptTokens: 11, completionTokens: 7 }
          return
        }
        const lastUser = messages.map(message => message.role).lastIndexOf('user')
        const task = String(messages[lastUser]?.content)
        const current = messages.slice(lastUser)
        if (task.includes('越界文件') && !current.some(message => message.role === 'tool')) {
          yield { done: true, finishReason: 'tool_calls', promptTokens: 7, completionTokens: 4,
            toolCalls: [{ id: 'outside-write', name: 'write_file', args: JSON.stringify({ path: path.join(fixture, 'outside-boundary.txt'), data: 'FORBIDDEN_EFFECT' }), index: 0 }] }
          return
        }
        if (task.includes('缓慢任务')) {
          slowChildStarted = true
          await new Promise<void>(resolve => {
            waitForChild = resolve
            if (options?.signal?.aborted) resolve()
            else options?.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          if (options?.signal?.aborted) return
        }
        if (task.includes('第一轮') && !current.some(message => message.role === 'tool')) {
          yield { done: true, finishReason: 'tool_calls', promptTokens: 13, completionTokens: 9, toolCalls: [
            { id: 'design-lookup', name: 'get_skill', args: JSON.stringify({ name: 'design' }), index: 0 },
            { id: 'docs-lookup', name: 'mcp_docs_lookup', args: '{}', index: 1 },
            { id: 'frontend-write', name: 'write_file', args: JSON.stringify({ path: 'frontend-result.txt', data: 'ACTUAL_CHILD_FILE' }), index: 2 },
          ] }
          return
        }
        if (task.includes('第一轮')) {
          expect(current.find(message => message.toolName === 'get_skill')?.content).toContain('DESIGN_SKILL_CONTENT')
          expect(current.find(message => message.toolName === 'mcp_docs_lookup')?.content).toContain('MCP_DOCS_RESULT')
          yield { done: true, finishReason: 'stop', content: 'CHILD_FIRST_CONTEXT_SENTINEL', promptTokens: 17, completionTokens: 9 }
        } else if (task.includes('第二轮')) {
          expect(messages.some(message => message.role === 'assistant' && message.content === 'CHILD_FIRST_CONTEXT_SENTINEL')).toBe(true)
          yield { done: true, finishReason: 'stop', content: 'CHILD_SECOND_REUSED_CONTEXT', promptTokens: 19, completionTokens: 10 }
        } else yield { done: true, finishReason: 'stop', content: 'CHILD_OTHER_RESULT', promptTokens: 5, completionTokens: 3 }
      },
    }
    return adapter
  })
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId } }) })
  await app.register((await import('../chat.js')).chatRoutes)
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
}, 30_000)

afterAll(async () => {
  waitForChild?.()
  await app?.close()
  await closeDatabase?.()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-collaborator-chat-')) throw new Error('Unsafe cleanup target')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

function chatRequest(sessionId: string, message: string, collaborators: Array<{ agentId?: string; resumeRunId?: string }>, signal?: AbortSignal) {
  return fetch(baseUrl + '/chat', { method: 'POST', headers: { 'content-type': 'application/json',
    'x-aether-tool-profile': 'general', 'x-aether-run-lifetime': 'durable' }, signal,
    body: JSON.stringify({ sessionId, agentId: main.id, model: 'main-fixture', message, collaborators, memoryScope: 'off', workspacePaths: [fixture] }) })
}
async function chat(sessionId: string, message: string, collaborators: Array<{ agentId?: string; resumeRunId?: string }>) {
  const response = await chatRequest(sessionId, message, collaborators)
  return { status: response.status, body: await response.text() }
}

describe('explicit custom Agent collaboration through real chat', () => {
  it('runs the selected Agent before the main model, preserves its full configuration and actual effects, then resumes the same context', async () => {
    const sessionId = 'configured-collaboration'
    const first = await chat(sessionId, '第一轮：请前端工程师读取设计技能和资料，写出成果。', [{ agentId: frontend.id }, { agentId: frontend.id }])
    expect(first.status).toBe(200)
    expect(first.body).toContain('"subagentEvent"')
    expect(first.body).toContain('"toolStart"')
    expect(first.body).toContain('"toolEnd"')
    expect(first.body).toContain('CHILD_FIRST_CONTEXT_SENTINEL')
    expect(fs.readFileSync(path.join(fixture, 'frontend-result.txt'), 'utf8')).toBe('ACTUAL_CHILD_FILE')
    expect(executedMcp).toBe(1)
    const childCalls = modelCalls.filter(call => call.model === 'frontend-fixture')
    expect(childCalls).toHaveLength(2)
    expect(childCalls[0].options).toMatchObject({ temperature: 0.35 })
    expect(childCalls[0].options?.systemPrompt).toContain('FRONTEND_PROFILE_ORIGINAL')
    expect(childCalls[0].options?.systemPrompt).toContain('FRONTEND_KNOWLEDGE_CONTEXT')
    expect(childCalls[0].options?.systemPrompt).toContain('DESIGN_SKILL_INDEX')
    expect(childCalls[0].options?.systemPrompt).not.toContain('UNBOUND_SKILL')
    expect(childCalls[0].options?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['get_skill', 'mcp_docs_lookup', 'write_file']))
    expect(childCalls[0].options?.tools?.map(tool => tool.name)).not.toContain('subagent')
    expect(childCalls[0].options?.tools?.map(tool => tool.name)).not.toContain('ask_user')
    const parentCall = modelCalls.find(call => call.model === 'main-fixture')!
    expect(parentCall.options?.tools).toEqual([])
    expect(parentCall.messages.some(message => message.role === 'tool' && String(message.content).includes('CHILD_FIRST_CONTEXT_SENTINEL'))).toBe(true)
    const { getSubagentStore } = await import('../../../../core/subagent/store.js')
    const runsBefore = await getSubagentStore().listRunsForParent(tenantId, sessionId)
    expect(runsBefore).toHaveLength(1)
    expect(runsBefore[0]).toMatchObject({ agentId: frontend.id, agentName: frontend.name, status: 'succeeded',
      continuation: { userDelegated: true, agent: { skills: ['design'], mcpServers: ['docs'], knowledgeBases: ['frontend-kb'] } } })
    await agentStore.update(frontend.id, tenantId, { name: '已修改名字', systemPrompt: 'MUTATED_PROFILE', model: 'changed-fixture', allowedTools: [] })
    const second = await chat(sessionId, '第二轮：沿用上一轮子代理上下文，继续给出结论。', [{ agentId: frontend.id }])
    expect(second.status).toBe(200)
    expect(second.body).toContain('CHILD_SECOND_REUSED_CONTEXT')
    const after = await getSubagentStore().listRunsForParent(tenantId, sessionId)
    expect(after).toHaveLength(2)
    expect(after[1]).toMatchObject({ childSessionId: after[0].childSessionId, resumeFromRunId: after[0].runId,
      agentName: frontend.name, modelId: 'frontend-fixture', status: 'succeeded' })
    const lastChild = modelCalls.filter(call => call.model === 'frontend-fixture').at(-1)!
    expect(lastChild.options?.systemPrompt).toContain('FRONTEND_PROFILE_ORIGINAL')
    expect(lastChild.options?.systemPrompt).not.toContain('MUTATED_PROFILE')
    const { SessionStore } = await import('../../../../storage/session/index.js')
    expect((await new SessionStore().getBinding(sessionId, tenantId))?.agentId).toBe(main.id)
    const history = (await import('../../../../storage/conversation/factory.js')).createConversationHistory()
    const replay = await history.getFullHistory({ tenantId, sessionId })
    const childResults = replay.filter(message => message.role === 'tool' && message.toolName === 'subagent')
    expect(childResults).toHaveLength(2)
    expect((childResults[1].metadata?.subagent as SubagentRun).childSessionId).toBe(after[0].childSessionId)
    await agentStore.update(frontend.id, tenantId, { name: frontend.name, systemPrompt: frontend.systemPrompt, model: frontend.model, allowedTools: frontend.allowedTools })
  }, 30_000)

  it('invalid Agent selections are rejected before binding, root admission, user history or model generation', async () => {
    const sessionId = 'invalid-collaboration'
    const before = modelCalls.length
    expect((await chat(sessionId, '不应执行', [{ agentId: 'unknown-agent' }])).status).toBe(404)
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    expect(await rootRunStore.list(tenantId, sessionId)).toEqual([])
    const { SessionStore } = await import('../../../../storage/session/index.js')
    expect(await new SessionStore().getBinding(sessionId, tenantId)).toBeUndefined()
    const history = (await import('../../../../storage/conversation/factory.js')).createConversationHistory()
    expect(await history.getFullHistory({ tenantId, sessionId })).toEqual([])
    expect(modelCalls).toHaveLength(before)
  })

  it('cancels an explicitly delegated child with its parent and rejects a duplicate continuation while it is active', async () => {
    const sessionId = 'cancel-collaboration'
    slowChildStarted = false
    const pending = chat(sessionId, '缓慢任务：等待测试取消。', [{ agentId: frontend.id }])
    await vi.waitFor(() => expect(slowChildStarted).toBe(true), { timeout: 10_000 })
    const { getSubagentStore } = await import('../../../../core/subagent/store.js')
    const child = (await getSubagentStore().listRunsForParent(tenantId, sessionId))[0]
    expect(child.status).toBe('running')
    expect((await chat(sessionId, '再次调用不应开始', [{ agentId: frontend.id }])).status).toBe(409)
    const response = await app.inject({ method: 'POST', url: '/chat/cancel', payload: { sessionId } })
    expect(response.statusCode).toBe(200)
    const finished = await pending
    expect(finished.body).toContain('cancelled')
    expect((await getSubagentStore().getRun(tenantId, child.runId))?.status).toBe('cancelled')
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    expect((await rootRunStore.list(tenantId, sessionId)).at(-1)?.status).toBe('cancelled')
  }, 20_000)

  it('persists an Agent preparation failure and settles it while a sibling is still running', async () => {
    const sessionId = 'preparation-failure-collaboration'
    const broken = await agentStore.create(tenantId, { name: '暂不可用 Agent', model: 'frontend-fixture', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['catalog_fixture_failure'] })
    slowChildStarted = false
    const pending = chat(sessionId, '缓慢任务：其他 Agent 继续工作。', [{ agentId: broken.id }, { agentId: frontend.id }])
    await vi.waitFor(() => expect(slowChildStarted).toBe(true), { timeout: 10_000 })
    const releaseSibling = waitForChild!
    const { getSubagentStore } = await import('../../../../core/subagent/store.js')
    try { await vi.waitFor(async () => {
      const children = await getSubagentStore().listRunsForParent(tenantId, sessionId)
      expect(children.find(run => run.agentId === broken.id)).toMatchObject({ agentName: broken.name, status: 'failed', error: { message: 'COLLABORATOR_CATALOG_UNAVAILABLE' } })
      expect(children.find(run => run.agentId === frontend.id)?.status).toBe('running')
      const { activeStreams } = await import('../../../../core/stream-pipeline/stream-bus.js')
      const frames = activeStreams.get(`${tenantId}:${sessionId}`)?.snapshot().projection ?? []
      expect(frames.some(frame => ((frame.toolResult ?? frame.toolEnd) as { metadata?: { subagent?: SubagentRun } } | undefined)?.metadata?.subagent?.agentId === broken.id)).toBe(true)
    }) } finally {
      releaseSibling()
      expect((await pending).status).toBe(200)
    }
    expect((await getSubagentStore().listRunsForParent(tenantId, sessionId)).find(run => run.agentId === frontend.id)?.status).toBe('succeeded')
  }, 20_000)

  it('keeps a successful child and its context resumable when the parent model subsequently fails', async () => {
    const sessionId = 'parent-failure-collaboration'
    failParentOnce = true
    expect((await chat(sessionId, '本轮子代理先成功，父模型随后失败。', [{ agentId: frontend.id }])).body).toContain('PARENT_PROVIDER_FIXTURE_FAILURE')
    const { getSubagentStore } = await import('../../../../core/subagent/store.js')
    const first = (await getSubagentStore().listRunsForParent(tenantId, sessionId))[0]
    expect(first.status).toBe('succeeded')
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    expect((await rootRunStore.list(tenantId, sessionId)).at(-1)?.status).toBe('failed')
    expect((await chat(sessionId, '父任务失败后，继续此前协作。', [{ resumeRunId: first.runId }])).status).toBe(200)
    const children = await getSubagentStore().listRunsForParent(tenantId, sessionId)
    expect(children[1]).toMatchObject({ childSessionId: first.childSessionId, resumeFromRunId: first.runId, status: 'succeeded' })
    const latest = modelCalls.filter(call => call.model === 'frontend-fixture').at(-1)!
    expect(latest.messages.some(message => message.role === 'user' && String(message.content).includes('父模型随后失败'))).toBe(true)
  }, 20_000)

  it('retains delegated Work after HTTP viewer disconnect, exposes durable child evidence and resumes through the same context', async () => {
    const sessionId = 'durable-disconnect-collaboration'
    const viewer = new AbortController()
    slowChildStarted = false
    const response = await chatRequest(sessionId, '缓慢任务：测试断流后的持续执行。', [{ agentId: frontend.id }], viewer.signal)
    await vi.waitFor(() => expect(slowChildStarted).toBe(true), { timeout: 10_000 })
    viewer.abort()
    await response.body?.cancel().catch(() => undefined)
    const { activeStreams } = await import('../../../../core/stream-pipeline/stream-bus.js')
    const bus = activeStreams.get(`${tenantId}:${sessionId}`)!
    await vi.waitFor(() => expect(bus.emitter.listenerCount('data')).toBe(0))
    expect(bus.abortController.signal.aborted).toBe(false)
    expect(bus.disconnectTimeout).toBeNull()
    waitForChild!()
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    await vi.waitFor(async () => expect((await rootRunStore.list(tenantId, sessionId)).at(-1)?.status).toBe('succeeded'))
    const snapshot = (await app.inject({ method: 'GET', url: `/chat/snapshot?sessionId=${sessionId}` })).json().data
    expect(snapshot.subagentRuns).toHaveLength(1)
    const child = snapshot.subagentRuns[0] as SubagentRun
    expect(child).toMatchObject({ agentId: frontend.id, status: 'succeeded', resultSummary: 'CHILD_OTHER_RESULT' })
    expect(snapshot.history.some((message: Message) => message.role === 'tool' && message.metadata?.subagent?.runId === child.runId)).toBe(true)
    expect((await chat(sessionId, '断流恢复后继续同一个子代理。', [{ resumeRunId: child.runId }])).status).toBe(200)
    const { getSubagentStore } = await import('../../../../core/subagent/store.js')
    expect((await getSubagentStore().listRunsForParent(tenantId, sessionId)).at(-1)).toMatchObject({ childSessionId: child.childSessionId, resumeFromRunId: child.runId, status: 'succeeded' })
  }, 20_000)

  it('keeps normal model-created named children inside the parent tool catalog and does not connect MCP in safe mode', async () => {
    const { createAgentContext } = await import('../../../../core/agent-context/factory.js')
    const { createConversationHistory } = await import('../../../../storage/conversation/factory.js')
    const { ToolRegistry } = await import('../../../../core/tool-registry/registry.js')
    const { pino } = await import('pino')
    const { subagentTool, executeSubagent } = await import('../../../../tools/subagent/subagent-tool.js')
    const { setSecurityMode, clearSecurityMode } = await import('../../../../security/policy-engine.js')
    const parent = createAgentContext({ sessionId: 'model-created-boundary', tenantId, workspacePaths: [fixture], projectRoot: fixture,
      tools: new ToolRegistry(), history: createConversationHistory(), modelName: 'main-fixture', logger: pino({ level: 'silent' }), memoryScope: 'off' })
    parent.resourceScope = { skills: [], mcpServers: [], knowledgeBases: [] }
    const beforeMcp = executedMcp
    const ordinary = await subagentTool.execute({ agentId: frontend.id, task: '普通模型创建的子代理，不得扩权。', userDelegated: true }, parent)
    expect(ordinary.success).toBe(true)
    expect(modelCalls.filter(call => call.model === 'frontend-fixture').at(-1)?.options?.tools).toEqual([])
    expect(modelCalls.filter(call => call.model === 'frontend-fixture').at(-1)?.options?.systemPrompt).not.toContain('FRONTEND_KNOWLEDGE_CONTEXT')
    expect(modelCalls.filter(call => call.model === 'frontend-fixture').at(-1)?.options?.systemPrompt).not.toContain('DESIGN_SKILL_INDEX')
    expect((ordinary.metadata?.subagent as SubagentRun).continuation?.userDelegated).toBe(false)
    setSecurityMode(parent.tenantId, parent.sessionId, 'safe')
    try {
      const safe = await executeSubagent({ agentId: frontend.id, task: '安全模式下明确委派，仍需遵守扩展限制。' },
        { ...parent, currentToolCallId: 'safe-explicit-collaboration' }, { userDelegated: true })
      expect(safe.success).toBe(true)
      expect(mcpDiscoveryScopes.at(-1)?.servers).toEqual([])
      expect(modelCalls.filter(call => call.model === 'frontend-fixture').at(-1)?.options?.tools?.map(tool => tool.name)).not.toContain('mcp_docs_lookup')
      expect(executedMcp).toBe(beforeMcp)
      expect(parent.tools.list()).toEqual([])
    } finally { clearSecurityMode(parent.tenantId, parent.sessionId) }
  }, 20_000)
  it('keeps explicit Agent delegation inside the parent workspace in safe mode', async () => {
    const { createAgentContext } = await import('../../../../core/agent-context/factory.js')
    const { createConversationHistory } = await import('../../../../storage/conversation/factory.js')
    const { ToolRegistry } = await import('../../../../core/tool-registry/registry.js')
    const { pino } = await import('pino')
    const { executeSubagent } = await import('../../../../tools/subagent/subagent-tool.js')
    const { setSecurityMode, clearSecurityMode } = await import('../../../../security/policy-engine.js')
    const project = path.join(fixture, 'restricted-project')
    fs.mkdirSync(project)
    const parent = createAgentContext({ sessionId: 'workspace-boundary-collaboration', tenantId, workspacePaths: [project], projectRoot: project,
      tools: new ToolRegistry(), history: createConversationHistory(), modelName: 'main-fixture', logger: pino({ level: 'silent' }), memoryScope: 'off' })
    setSecurityMode(parent.tenantId, parent.sessionId, 'safe')
    try {
      const result = await executeSubagent({ agentId: frontend.id, task: '越界文件：尝试写到授权项目外。' }, parent, { userDelegated: true })
      const child = result.metadata?.subagent as SubagentRun
      expect(child.toolCalls).toHaveLength(1)
      expect(child.toolCalls[0]).toMatchObject({ name: 'write_file', status: 'failed' })
      expect(fs.existsSync(path.join(fixture, 'outside-boundary.txt'))).toBe(false)
      expect(child.continuation?.workspacePaths).toEqual([project])
    } finally { clearSecurityMode(parent.tenantId, parent.sessionId) }
  }, 15_000)
})
