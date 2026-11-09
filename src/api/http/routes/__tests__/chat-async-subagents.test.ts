/** Fastify inject -> actual registered async tools -> held child ReAct; no listener or real provider. */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../../core/agent-context/types.js'
import * as database from '../../../../storage/sqlite/db.js'
import { LocalSqliteProcessClient } from '../../../../storage/sqlite/local-process-client.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { createConversationHistory } from '../../../../storage/conversation/factory.js'
import * as boundary from '../../../../core/collaboration/production-boundary.js'
import * as modelResolver from '../../../../core/llm-adapter/resolve-model.js'
import { resolveCapabilities } from '../../../../core/model-capabilities/index.js'
import { activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { chatRoutes } from '../chat.js'
import { COLLABORATOR_LIMITS } from '../../../../core/subagent/collaborators.js'
import { WorkspaceManager, workspaceManager } from '../../../../workspace/index.js'
import * as toolFactory from '../../../../tools/registry-factory.js'

const headers = { 'x-aether-tool-profile': 'code', 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2' }
const barrier = () => { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
let directory: string, app: FastifyInstance, db: LocalSqliteProcessClient, contexts: AgentContext[]
let preloadOrchestration = true
const releases: (() => void)[] = []
const gate = () => { const value = barrier(); releases.push(value.release); return value }
beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync('.e2e-tmp', { recursive: true }); directory = fs.mkdtempSync(path.resolve('.e2e-tmp/chat-async-subagents-'))
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(directory, 'fixture.db'), WORKSPACE_ROOT: directory,
    MEMORY_DB_PATH: path.join(directory, 'memory.db'), AETHER_GLOBAL_DIR: path.join(directory, 'global'), SKILLS_ROOT: path.join(directory, 'skills'),
    ENABLE_LONG_TERM_MEMORY: 'false', OSM_MODE: 'off', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false' })) vi.stubEnv(key, value)
  db = new LocalSqliteProcessClient({ url: 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/') })
  vi.spyOn(database, 'getDb').mockImplementation(() => db); await database.initDb()
  contexts = []
  preloadOrchestration = true
  const install = boundary.installProductionCollaborationBoundary
  vi.spyOn(boundary, 'installProductionCollaborationBoundary').mockImplementation(ctx => {
    install(ctx)
    // These scripted adapters exercise lifecycle ordering, not tool discovery.
    // Preload only authorized orchestration schemas; real-model evaluations and
    // model-tool-projection tests cover load_tools admission and next-request use.
    if (preloadOrchestration && ctx.tools.hasModelToolLoader?.()) {
      const names = ctx.tools.list().map(tool => tool.name).filter(name => name.startsWith('subagent'))
      if (names.length) ctx.tools.loadForModel?.(names)
    }
    contexts.push(ctx)
  })
  vi.spyOn(modelResolver, 'resolveModelConfig').mockImplementation(async ({ model }) => ({ model: model ?? 'root-scripted', provider: 'fixture',
    capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
  app = Fastify(); app.decorateRequest('authContext', null)
  app.addHook('onRequest', async (request, reply) => { Object.assign(request, { authContext: { tenantId: 'default' } }); reply.raw.setTimeout = () => reply.raw })
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const [key, bus] of activeStreams) { if (bus.disconnectTimeout) clearTimeout(bus.disconnectTimeout); await bus.endOrdered(); activeStreams.delete(key) }
  await app.close(); await database.closeDb(); expect((await db.closeWithReceipt()).healthy).toBe(true)
  await (await import('../../../../storage/memory/db.js')).closeMemoryDb()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('chat-async-subagents-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})

describe('actual chat collaborator schema', () => {
  it('initializes project context and real relative writes from the persisted binding after paths are omitted', async () => {
    const selected = path.join(directory, 'selected-project')
    fs.mkdirSync(selected)
    fs.writeFileSync(path.join(selected, 'AE.md'), 'BOUND_PROJECT_CONTEXT_MARKER: read only the selected project.\n')
    vi.stubEnv('AUTH_ENABLED', 'true')
    vi.stubEnv('WORKSPACE_ROOT', path.join(directory, 'scratch'))
    vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', directory)
    vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(directory, 'bindings.json'))
    const manager = new WorkspaceManager(path.join(directory, 'scratch'))
    manager.bind({ tenantId: 'default', sessionId: 'bound-workspace-chat' }, selected)
    vi.spyOn(workspaceManager, 'getPaths').mockImplementation(ctx => manager.getPaths(ctx))
    vi.spyOn(workspaceManager, 'getWorkingDirectory').mockImplementation(ctx => manager.getWorkingDirectory(ctx))
    vi.spyOn(workspaceManager, 'getBindingSnapshot').mockImplementation(ctx => manager.getBindingSnapshot(ctx))
    vi.spyOn(workspaceManager, 'bindingReadGuard').mockImplementation((ctx, expected) => manager.bindingReadGuard(ctx, expected))
    vi.spyOn(workspaceManager, 'resolveSafePath').mockImplementation((ctx, value) => manager.resolveSafePath(ctx, value))
    const preparedRoots: Array<string | undefined> = []
    const factory = toolFactory.createToolRegistry
    vi.spyOn(toolFactory, 'createToolRegistry').mockImplementation(async opts => { preparedRoots.push(opts?.workspaceRoot); return factory(opts) })
    const prompts: string[] = []
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockReturnValue({ provider: 'fixture', model: 'root-scripted', countTokens: () => 0,
      complete: vi.fn(), async *stream(messages, options) {
        prompts.push(options?.systemPrompt ?? '')
        if (!messages.some(message => message.role === 'tool' && message.toolCallId === 'bound-write')) {
          yield { done: true, toolCalls: [{ index: 0, id: 'bound-write', name: 'write_file', args: JSON.stringify({ path: 'draft.md', data: 'BOUND_SHARED_DRAFT', expectedHash: 'missing' }) }] }
        } else yield { done: true, content: '草稿已保存。' }
      } })
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers,
      payload: { sessionId: 'bound-workspace-chat', message: '在当前项目写入草稿', workspacePaths: [] } })
    expect(response.statusCode, response.body).toBe(200)
    expect(preparedRoots).toEqual([selected])
    expect(contexts[0]).toMatchObject({ projectRoot: selected, cwd: selected })
    expect(contexts[0].scratchDir).not.toBe(selected)
    expect(prompts[0]).toContain('BOUND_PROJECT_CONTEXT_MARKER')
    expect(prompts[0]).toContain('"relativePathRoot":' + JSON.stringify(selected))
    expect(fs.readFileSync(path.join(selected, 'draft.md'), 'utf8')).toBe('BOUND_SHARED_DRAFT')
    expect(fs.existsSync(path.join(contexts[0].scratchDir!, 'draft.md'))).toBe(false)
  })

  it('preserves builtin role, independent instance key, task and description before dispatch', async () => {
    // Fastify executes its real route schema before this test-only dispatch gate.
    // No provider or child is needed to verify which fields reach the handler.
    const received = vi.fn()
    app.addHook('preHandler', async (request, reply) => {
      received(request.body)
      return reply.send({ collaborators: (request.body as { collaborators?: unknown }).collaborators })
    })
    await app.register(chatRoutes)
    const collaborators = [
      { builtinRole: 'research', instanceKey: 'research-one', task: 'Read the existing API', description: 'API evidence' },
      { builtinRole: 'executor', instanceKey: 'executor-one', task: 'Implement the editor', description: 'Editor' },
      { builtinRole: 'executor', instanceKey: 'executor-two', task: 'Implement the sidebar', description: 'Sidebar' },
      { builtinRole: 'general', instanceKey: 'general-one', task: 'Integrate the components', description: 'Integration' },
      { builtinRole: 'research', instanceKey: 'i'.repeat(COLLABORATOR_LIMITS.instanceKey),
        task: 't'.repeat(COLLABORATOR_LIMITS.task), description: 'd'.repeat(COLLABORATOR_LIMITS.description) },
    ]
    const response = await app.inject({ method: 'POST', url: '/chat', headers,
      payload: { sessionId: 'builtin-schema', message: 'Coordinate the selected collaborators', collaborators } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().collaborators).toEqual(collaborators)
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ collaborators }))
    expect(contexts).toHaveLength(0)
    expect((await db.execute('SELECT count(*) AS n FROM root_runs')).rows[0].n).toBe(0)
  })
  it.each(['unknown', 'Research', 'admin'])('rejects invalid builtin role %s before dispatch', async builtinRole => {
    const dispatch = vi.fn()
    app.addHook('preHandler', async (_request, reply) => { dispatch(); return reply.send({ unexpected: true }) })
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers,
      payload: { sessionId: 'invalid-builtin-schema', message: 'Invalid role must never execute', collaborators: [{ builtinRole, instanceKey: 'invalid' }] } })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('builtinRole')
    expect(dispatch).not.toHaveBeenCalled()
    expect(contexts).toHaveLength(0)
    expect((await db.execute('SELECT count(*) AS n FROM root_runs')).rows[0].n).toBe(0)
  })
  it.each(['task', 'description', 'instanceKey'] as const)('rejects oversized collaborator %s before dispatch', async field => {
    const dispatch = vi.fn()
    app.addHook('preHandler', async (_request, reply) => { dispatch(); return reply.send({ unexpected: true }) })
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers,
      payload: { sessionId: 'oversize-builtin-schema', message: 'No dispatch for invalid selection',
        collaborators: [{ builtinRole: 'research', [field]: 'x'.repeat(COLLABORATOR_LIMITS[field] + 1) }] } })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain(field)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe.each(['jsonl', 'sqlite'])('%s actual async model tools', backend => {
  it.each(['duplicate-plan', 'premature-final'])('plans selected same-role instances after %s before any child starts, then publishes independent scoped admissions', async firstAttempt => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    preloadOrchestration = false
    let parentCalls = 0
    const childTasks: string[] = []
    const message = 'Implement editor and sidebar. ORIGINAL_SHARED_REQUEST_SENTINEL'
    const assignments = [{ selectionId: 'selection-1', task: 'Implement only editor.ts with keyboard editing tests', description: 'Editor' },
      { selectionId: 'selection-2', task: 'Implement only sidebar.ts with selection tests', description: 'Sidebar' }]
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream(messages, options) {
        if (config.model === 'scoped-child') {
          const task = String([...messages].reverse().find(item => item.role === 'user')?.content)
          childTasks.push(task)
          expect(task).not.toContain('ORIGINAL_SHARED_REQUEST_SENTINEL')
          expect(options?.tools?.some(tool => tool.name === 'collaborator_dispatch')).toBe(false)
          yield { done: true, finishReason: 'stop', content: task.includes('editor.ts') ? 'Editor scope finished' : 'Sidebar scope finished' }
          return
        }
        parentCalls++
        if (parentCalls <= 2) {
          expect((await db.execute('SELECT count(*) AS n FROM subagent_runs')).rows[0].n).toBe(0)
          expect(options?.tools?.some(tool => tool.name === 'collaborator_dispatch')).toBe(true)
          if (parentCalls === 1 && firstAttempt === 'premature-final') {
            yield { done: true, finishReason: 'stop', content: 'Premature unplanned candidate' }
            return
          }
          if (parentCalls === 2 && firstAttempt === 'duplicate-plan') expect(messages.find(item => item.role === 'tool' && item.toolCallId === 'invalid-plan')?.metadata?.success).toBe(false)
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: parentCalls === 1 ? 'invalid-plan' : 'scoped-plan', index: 0,
            name: 'collaborator_dispatch', args: JSON.stringify({ assignments: parentCalls === 1
              ? [assignments[0], { ...assignments[1], task: assignments[0].task }] : assignments }) }] }
        } else if (parentCalls === 3) {
          const admissions = messages.filter(item => item.role === 'tool' && item.toolName === 'subagent_start')
          expect(admissions).toHaveLength(2)
          expect(new Set(admissions.map(item => item.toolCallId)).size).toBe(2)
          expect(messages.find(item => item.role === 'tool' && item.toolCallId === 'scoped-plan')?.content).toContain('"state":"planned"')
          expect(options?.tools?.some(tool => tool.name === 'subagent_wait')).toBe(true)
          yield { done: true, finishReason: 'tool_calls', toolCalls: admissions.map((item, index) => ({ id: 'join-scoped-' + index, index,
            name: 'subagent_wait', args: JSON.stringify({ runId: JSON.parse(String(item.content)).runId, timeoutMs: 30000 }) })) }
        } else {
          expect(parentCalls).toBe(4)
          expect(childTasks).toHaveLength(2)
          yield { done: true, finishReason: 'stop', content: 'Parent verified both distinct scopes' }
        }
      },
    }))
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'scoped-selection-route', message,
      collaborators: [{ builtinRole: 'executor', instanceKey: 'one' }, { builtinRole: 'executor', instanceKey: 'two' }],
      model: 'scoped-parent', subagentModel: 'scoped-child', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] } })
    expect(response.statusCode).toBe(200); expect(response.body).toContain('Parent verified both distinct scopes')
    expect(response.body).toContain('"subagentEvent"')
    expect(parentCalls).toBe(4)
    const history = await createConversationHistory().getFullHistory({ tenantId: 'default', sessionId: 'scoped-selection-route' })
    const starts = history.filter(item => item.role === 'assistant' && item.toolCall?.name === 'subagent_start')
    expect(starts).toHaveLength(2)
    expect(new Set(starts.map(item => item.toolCall!.id)).size).toBe(2)
    expect(starts.map(item => item.toolCall!.args.description).sort()).toEqual(['Editor', 'Sidebar'])
    expect(history.filter(item => item.metadata?.subagentNotification)).toHaveLength(2)
    expect((await db.execute('SELECT count(*) AS n FROM subagent_runs')).rows[0].n).toBe(2)
    expect((await rootRunStore.list('default', 'scoped-selection-route'))[0].status).toBe('succeeded')
  })

  it('does not report success or loop indefinitely when the model ignores selected collaborators twice', async () => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    preloadOrchestration = false
    let calls = 0
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream() { calls++; yield { done: true, finishReason: 'stop', content: 'Ignored the selected collaborators', promptTokens: 100, completionTokens: 5 } },
    }))
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'unplanned-selection-route', message: 'Build editor and sidebar',
      collaborators: [{ builtinRole: 'executor', instanceKey: 'one' }, { builtinRole: 'executor', instanceKey: 'two' }],
      model: 'unplanned-parent', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] } })
    expect(response.statusCode).toBe(200)
    expect(calls).toBe(2)
    expect((await db.execute('SELECT count(*) AS n FROM subagent_runs')).rows[0].n).toBe(0)
    expect((await rootRunStore.list('default', 'unplanned-selection-route'))[0]).toMatchObject({ status: 'failed', error: { code: 'COLLABORATOR_PLAN_REQUIRED' } })
    expect(response.body).not.toContain('"finalResult"')
    expect(response.body).toContain('"totalTokens":210')
  })

  it('an explicitly selected collaborator admits before the parent model and receives live parent steering before completion', async () => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const entered = gate(), finish = gate()
    let parentCalls = 0, childCalls = 0, runId = '', childSessionId = '', dispatchId = ''
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream(messages) {
        if (config.model === 'explicit-child') {
          childCalls++
          if (childCalls === 1) {
            entered.release(); await finish.promise
            yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'explicit-child-peers', name: 'subagent_participants', args: '{}', index: 0 }] }
          } else {
            expect(childCalls).toBe(2)
            expect(messages.some(message => String(message.content).includes('Include keyboard navigation in this component'))).toBe(true)
            yield { done: true, finishReason: 'stop', content: 'Explicit child included the parent update' }
          }
          return
        }
        parentCalls++
        if (parentCalls === 1) {
          const admissionMessage = messages.find(message => message.role === 'tool' && message.toolName === 'subagent_start')!
          expect(admissionMessage).toBeDefined()
          const admission = JSON.parse(String(admissionMessage.content))
          expect(admission.state).toBe('admitted')
          runId = admission.runId; childSessionId = admission.childSessionId; dispatchId = admissionMessage.toolCallId!
          await entered.promise
          expect((await db.execute({ sql: 'SELECT status FROM subagent_runs WHERE run_id=?', args: [runId] })).rows[0].status).toBe('running')
          expect(messages.some(message => message.id === 'subagent-result:' + runId)).toBe(false)
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'explicit-parent-steer', name: 'subagent_send', index: 0,
            args: JSON.stringify({ recipientParticipantId: 'child:' + childSessionId, message: 'Include keyboard navigation in this component' }) }] }
        } else if (parentCalls === 2) {
          expect(messages.find(message => message.toolCallId === 'explicit-parent-steer' && message.role === 'tool')?.content).toContain('queued')
          finish.release()
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'explicit-parent-join', name: 'subagent_wait', index: 0,
            args: JSON.stringify({ runId, timeoutMs: 30000 }) }] }
        } else {
          expect(parentCalls).toBe(3)
          expect(messages.find(message => message.toolCallId === 'explicit-parent-join' && message.role === 'tool')?.content).toContain('Explicit child included the parent update')
          yield { done: true, finishReason: 'stop', content: 'Parent verified explicitly selected work' }
        }
      },
    }))
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'explicit-async-route', message: 'Build the selected component',
      collaborators: [{ builtinRole: 'executor', instanceKey: 'component', task: 'Build the component', description: 'Component' }],
      model: 'explicit-parent', subagentModel: 'explicit-child', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] } })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Parent verified explicitly selected work')
    expect(parentCalls).toBe(3); expect(childCalls).toBe(2)
    const history = await createConversationHistory().getFullHistory({ tenantId: 'default', sessionId: 'explicit-async-route' })
    expect(history.filter(message => message.role === 'tool' && message.toolCallId === dispatchId)).toHaveLength(1)
    expect(history.find(message => message.id === 'subagent-result:' + runId)).toMatchObject({ role: 'assistant', metadata: { subagentNotification: { runId } } })
    expect((await rootRunStore.list('default', 'explicit-async-route'))[0].status).toBe('succeeded')
  })
  it('actual cancel tool stays pending until the held child stops and then returns its exact cancelled result', async () => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const { registry } = await (await import('../../../../tools/registry-factory.js')).createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_start', 'subagent_cancel'], allowedMcpServers: [] })
    expect(registry.has('subagent_start')).toBe(true); expect(registry.has('subagent_cancel')).toBe(true)
    const entered = gate(), finish = gate(); let parentCalls = 0, runId = ''
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream(messages) {
        if (config.model === 'child-cancel') { entered.release(); await finish.promise; yield { done: true, finishReason: 'stop', content: 'Must not become a successful cancelled child' }; return }
        parentCalls++
        if (parentCalls === 1) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'cancel-start', index: 0, name: 'subagent_start', args: JSON.stringify({ task: 'Actual cancel target', model: 'child-cancel' }) }] }
        else if (parentCalls === 2) {
          await entered.promise; runId = JSON.parse(String(messages.find(message => message.role === 'tool' && message.toolCallId === 'cancel-start')!.content)).runId
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'cancel-request', index: 0, name: 'subagent_cancel', args: JSON.stringify({ runId, timeoutMs: 0 }) }] }
        } else if (parentCalls === 3) {
          expect(JSON.parse(String(messages.find(message => message.role === 'tool' && message.toolCallId === 'cancel-request')!.content)).state).toBe('pending')
          expect(contexts.find(ctx => ctx.runId)?.signal?.aborted).toBe(true)
          expect((await db.execute('SELECT status FROM subagent_runs')).rows[0].status).toBe('cancelling')
          finish.release()
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'cancel-join', index: 0, name: 'subagent_cancel', args: JSON.stringify({ runId, timeoutMs: 30000 }) }] }
        } else {
          expect(parentCalls).toBe(4)
          const receipt = messages.find(message => message.role === 'tool' && message.toolCallId === 'cancel-join')!
          expect(receipt.metadata?.subagentObservation).toMatchObject({ state: 'completed', run: { runId, status: 'cancelled' } })
          yield { done: true, finishReason: 'stop', content: 'Actual cancellation joined' }
        }
      },
    }))
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'cancel-route', message: 'Start then cancel child', model: 'root-cancel', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] } })
    expect(response.statusCode).toBe(200); expect(response.body).toContain('Actual cancellation joined'); expect(parentCalls).toBe(4)
    const rows = await createConversationHistory().getFullHistory({ tenantId: 'default', sessionId: 'cancel-route' })
    expect(rows.filter(message => message.role === 'tool' && message.toolCallId === 'cancel-start')).toHaveLength(1)
    expect(rows.find(message => message.id === 'subagent-result:' + runId)?.metadata?.subagent).toMatchObject({ status: 'cancelled' })
    expect((await rootRunStore.list('default', 'cancel-route'))[0].status).toBe('succeeded')
  })
  it('an early parent final stays open until the child settles and the model receives its result for acceptance', async () => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const { registry } = await (await import('../../../../tools/registry-factory.js')).createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_start'], allowedMcpServers: [] })
    expect(registry.has('subagent_start')).toBe(true)
    const entered = gate(), finish = gate(); let parentCalls = 0
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream(messages) {
        if (config.model === 'child-drain') { entered.release(); await finish.promise; yield { done: true, finishReason: 'stop', content: 'Exact async child after parent final' }; return }
        parentCalls++
        if (parentCalls === 1) yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'drain-start', index: 0, name: 'subagent_start', args: JSON.stringify({ task: 'Actual drain target', model: 'child-drain' }) }] }
        else if (parentCalls === 2) { await entered.promise; yield { done: true, finishReason: 'stop', content: 'Premature parent candidate' } }
        else {
          expect(parentCalls).toBe(3)
          expect(messages.some(message => message.metadata?.subagentNotification && String(message.content).includes('Exact async child after parent final'))).toBe(true)
          yield { done: true, finishReason: 'stop', content: 'Parent accepted exact child result' }
        }
      },
    }))
    await app.register(chatRoutes)
    let settled = false
    const pending = app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'drain-route', message: 'Start child then finish parent', model: 'root-drain', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] } }).then(response => { settled = true; return response })
    try {
      await entered.promise
      await expect.poll(() => parentCalls).toBe(2)
      expect((await db.execute('SELECT phase FROM collaboration_roots')).rows[0]?.phase).toBe('open')
      expect(settled).toBe(false); expect((await db.execute('SELECT status FROM subagent_runs')).rows[0].status).toBe('running')
      finish.release(); const response = await pending
      expect(response.statusCode).toBe(200); expect(response.body).toContain('Parent accepted exact child result')
      const final = response.body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
        .find(frame => frame.finalResult)?.finalResult
      expect(final?.text).toBe('Parent accepted exact child result')
      expect(parentCalls).toBe(3)
      expect((await rootRunStore.list('default', 'drain-route'))[0].status).toBe('succeeded')
      const child = (await db.execute('SELECT run_id FROM subagent_runs')).rows[0]
      const rows = await createConversationHistory().getFullHistory({ tenantId: 'default', sessionId: 'drain-route' })
      expect(rows.find(message => message.id === 'subagent-result:' + child.run_id)).toMatchObject({ role: 'assistant', metadata: { subagentNotification: { parentToolCallId: 'drain-start' }, subagent: { status: 'succeeded' } } })
    } finally { finish.release(); await pending }
  })
  it('start returns while child is held, parent/child send with real identities, and wait keeps one result per call plus independent completion', async () => {
    vi.stubEnv('HISTORY_BACKEND', backend)
    const { registry } = await (await import('../../../../tools/registry-factory.js')).createToolRegistry({ toolProfile: 'code', allowedTools: ['subagent_start', 'subagent_wait', 'subagent_send', 'subagent_participants', 'subagent_inbox', 'subagent_request_input'], allowedMcpServers: [] })
    expect(registry.has('subagent_start')).toBe(true); expect(registry.has('subagent_wait')).toBe(true)
    expect(registry.has('subagent_request_input')).toBe(true)
    const entered = gate(), finish = gate(), answer = gate(); let parentCalls = 0, childCalls = 0, runId = '', childSessionId = ''
    const providerInputs: Message[][] = []
    vi.spyOn(modelResolver, 'createAdapterFromResolved').mockImplementation(config => ({ provider: 'fixture', model: config.model,
      countTokens: text => Math.ceil(text.length / 4), complete: async () => { throw new Error('UNEXPECTED_COMPLETION') },
      async *stream(messages) {
        providerInputs.push(messages)
        const root = contexts.find(ctx => !ctx.runId)!
        expect(root.tools.has('subagent_request_input')).toBe(true)
        if (config.model === 'child-scripted') {
          childCalls++
          const child = contexts.find(ctx => !!ctx.runId)!
          expect(child.tools.has('subagent_start')).toBe(false); expect(child.tools.has('subagent')).toBe(false)
          expect(child.tools.has('subagent_request_input')).toBe(true)
          if (childCalls === 1) {
            entered.release(); await finish.promise
            yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'child-participants', index: 0, name: 'subagent_participants', args: '{}' }] }
          } else if (childCalls === 2) {
            expect(messages.some(message => String(message.content).includes('Actual parent to child message'))).toBe(true)
            yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'child-reply', index: 0, name: 'subagent_send', args: JSON.stringify({ recipientParticipantId: 'root:' + root.rootRunId, message: 'Actual child to parent reply' }) }] }
          } else {
            expect(childCalls).toBe(3); await answer.promise
            yield { done: true, finishReason: 'stop', content: 'Actual async child final' }
          }
          return
        }
        parentCalls++
        if (parentCalls === 1) {
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'async-start', index: 0, name: 'subagent_start', args: JSON.stringify({ task: 'Actual asynchronous child task', model: 'child-scripted' }) }] }
        } else if (parentCalls === 2) {
          await entered.promise
          const receipt = messages.find(message => message.role === 'tool' && message.toolCallId === 'async-start')!
          const admission = JSON.parse(String(receipt.content)); expect(admission.state).toBe('admitted')
          runId = admission.runId; childSessionId = admission.childSessionId
          expect((await db.execute('SELECT status FROM subagent_runs')).rows[0].status).toBe('running')
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'parent-send', index: 0, name: 'subagent_send', args: JSON.stringify({ recipientParticipantId: 'child:' + childSessionId, message: 'Actual parent to child message' }) }] }
        } else if (parentCalls === 3) {
          expect(messages.some(message => message.toolCallId === 'parent-send' && String(message.content).includes('queued'))).toBe(true)
          yield { done: true, finishReason: 'tool_calls', toolCalls: [
            { id: 'parent-participants', index: 0, name: 'subagent_participants', args: '{"limit":1}' },
            { id: 'parent-inbox', index: 1, name: 'subagent_inbox', args: '{}' },
          ] }
        } else if (parentCalls === 4) {
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'parent-poll', index: 0, name: 'subagent_wait', args: JSON.stringify({ runId, timeoutMs: 0 }) }] }
        } else if (parentCalls === 5) {
          expect(messages.some(message => message.role === 'tool' && message.toolCallId === 'parent-poll' && JSON.parse(String(message.content)).state === 'pending')).toBe(true)
          finish.release()
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'parent-join', index: 0, name: 'subagent_wait', args: JSON.stringify({ runId, timeoutMs: 30000 }) }] }
        } else if (parentCalls === 6) {
          const observation = JSON.parse(String(messages.find(message => message.role === 'tool' && message.toolCallId === 'parent-join')!.content))
          expect(observation).toMatchObject({ state: 'pending', runId, reason: 'message' })
          expect(messages.some(message => String(message.content).includes('Actual child to parent reply'))).toBe(true)
          answer.release()
          yield { done: true, finishReason: 'tool_calls', toolCalls: [{ id: 'parent-final-join', index: 0, name: 'subagent_wait', args: JSON.stringify({ runId, timeoutMs: 30000 }) }] }
        } else {
          expect(parentCalls).toBe(7)
          expect(messages.filter(message => message.role === 'tool' && message.toolCallId === 'async-start')).toHaveLength(1)
          expect(messages.some(message => message.role === 'tool' && message.toolCallId === 'parent-final-join' && String(message.content).includes('Actual async child final'))).toBe(true)
          expect(messages.some(message => message.role === 'assistant' && message.metadata?.subagentNotification && String(message.content).includes('Actual async child final'))).toBe(true)
          expect(messages.some(message => String(message.content).includes('Actual child to parent reply'))).toBe(true)
          yield { done: true, finishReason: 'stop', content: 'Actual async parent final' }
        }
      },
    }))
    await app.register(chatRoutes)
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: { sessionId: 'async-route', message: 'Start and coordinate actual child',
      model: 'root-scripted', workspacePaths: [directory], memoryScope: 'off', thinkingMode: false, skills: [], mcpServers: [], knowledgeBases: [] } })
    expect(response.statusCode, response.body).toBe(200); expect(response.body).toContain('Actual async parent final')
    expect(parentCalls).toBe(7); expect(childCalls).toBe(3)
    const root = (await rootRunStore.list('default', 'async-route'))[0], rows = await createConversationHistory().getFullHistory({ tenantId: 'default', sessionId: 'async-route' })
    expect(root.status).toBe('succeeded')
    expect(rows.filter(message => message.role === 'tool' && message.toolCallId === 'async-start')).toHaveLength(1)
    expect(rows.filter(message => message.id === 'subagent-result:' + runId)).toHaveLength(1)
    expect(rows.find(message => message.id === 'subagent-result:' + runId)).toMatchObject({ role: 'assistant', metadata: { subagentNotification: { runId, parentToolCallId: 'async-start' } } })
    const mail = (await db.execute('SELECT sender_participant_id,recipient_participant_id FROM collaboration_messages ORDER BY seq')).rows
    expect(mail).toEqual([{ sender_participant_id: 'root:' + root.runId, recipient_participant_id: 'child:' + childSessionId }, { sender_participant_id: 'child:' + childSessionId, recipient_participant_id: 'root:' + root.runId }])
    const deliveryTable = backend === 'jsonl' ? 'collaboration_jsonl_deliveries' : 'collaboration_deliveries'
    expect((await db.execute('SELECT state FROM ' + deliveryTable)).rows).toEqual([{ state: 'integrated' }, { state: 'integrated' }])
    for (const messages of providerInputs) {
      const resultIds = messages.filter(message => message.role === 'tool').map(message => message.toolCallId)
      expect(new Set(resultIds).size).toBe(resultIds.length)
    }
  })
})
