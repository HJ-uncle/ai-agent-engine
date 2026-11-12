// Actual HTTP admission/registry/SQLite, with only model and external discovery isolated.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LLMAdapter } from '../../../../core/llm-adapter/types.js'
import { AGENT_MANAGEMENT_TOOLS, KNOWLEDGE_MANAGEMENT_TOOLS, KNOWLEDGE_READ_TOOLS, TOOLKIT_IDS, toolkitToolNames } from '../../../../tools/toolkits.js'

let fixture: string, app: FastifyInstance, baseUrl: string, restrictedAgentId: string
let closeDatabase: (() => Promise<void>) | undefined
const offered: string[][] = []
const modelInputs: string[] = []
let nextToolCall: { id: string; name: string; args: Record<string, unknown> } | undefined
const tenantId = 'toolkit-http-fixture'

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-toolkit-http-'))
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(fixture, 'agent.db'), WORKSPACE_ROOT: path.join(fixture, 'scratch'),
    HISTORY_BACKEND: 'jsonl', MEMORY_DB_PATH: path.join(fixture, 'memory.db'), AETHER_GLOBAL_DIR: path.join(fixture, 'global'),
    SKILLS_ROOT: path.join(fixture, 'skills'), OSM_MODE: 'off', AUTH_ENABLED: 'false', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false',
    MCP_CONFIG_PATH: '', AGENT_TOTAL_TOKEN_LIMIT: '', DEFAULT_SECURITY_MODE: 'standard' })) vi.stubEnv(key, value)
  const database = await import('../../../../storage/sqlite/db.js')
  await database.initDb()
  closeDatabase = async () => {
    expect((await database.closeDb())?.healthy).toBe(true)
    await (await import('../../../../storage/memory/db.js')).closeMemoryDb()
  }
  const { SQLiteAgentStore } = await import('../../../../storage/agent/index.js')
  restrictedAgentId = (await new SQLiteAgentStore().create(tenantId, { name: '无管理权限', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: [] })).id
  const { skillsRegistry } = await import('../../../../skills/index.js')
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([])
  const mcp = await import('../../../../tools/mcp/loader.js')
  vi.spyOn(mcp, 'registerMCPTools').mockResolvedValue([])
  const resolver = await import('../../../../core/llm-adapter/resolve-model.js')
  const { resolveCapabilities } = await import('../../../../core/model-capabilities/index.js')
  vi.spyOn(resolver, 'resolveModelConfig').mockImplementation(async () => ({ model: 'toolkit-fixture', provider: 'fixture',
    capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
  vi.spyOn(resolver, 'createAdapterFromResolved').mockImplementation(() => {
    const adapter: LLMAdapter = { provider: 'fixture', model: 'toolkit-fixture', countTokens: text => Math.ceil(text.length / 4),
      complete: async () => { throw new Error('Unexpected model transport') },
      async *stream(_messages, options) {
        offered.push(options?.tools?.map(tool => tool.name) ?? [])
        modelInputs.push(JSON.stringify({ messages: _messages, systemPrompt: options?.systemPrompt, requestContext: options?.requestContext }))
        if (nextToolCall) {
          const call = nextToolCall
          nextToolCall = undefined
          yield { done: true, finishReason: 'tool_calls', promptTokens: 10, completionTokens: 4,
            toolCalls: [{ ...call, args: JSON.stringify(call.args), index: 0 }] }
          return
        }
        yield { done: true, finishReason: 'stop', content: 'TOOLKIT_MODEL_RESULT', promptTokens: 10, completionTokens: 4 }
      },
    }
    return adapter
  })
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId: request.headers['x-test-tenant'] ?? tenantId, method: 'none' } }) })
  await app.register((await import('../chat.js')).chatRoutes)
  await app.register((await import('../sessions.js')).sessionRoutes)
  await app.register((await import('../tools.js')).toolRoutes)
  await app.register((await import('../agents.js')).agentRoutes)
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
}, 30_000)

afterAll(async () => {
  await app?.close()
  await closeDatabase?.()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-toolkit-http-')) throw new Error('Unsafe cleanup target')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

async function chat(sessionId: string, fields: Record<string, unknown> = {}, profile = 'general', tenant = tenantId) {
  const response = await fetch(baseUrl + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aether-tool-profile': profile, 'x-test-tenant': tenant },
    body: JSON.stringify({ sessionId, message: '请回答当前问题', model: 'toolkit-fixture', workspacePaths: [fixture], ...fields }) })
  return { status: response.status, body: await response.text() }
}
async function selection(sessionId: string, tenant = tenantId): Promise<string[]> {
  return (await (await fetch(`${baseUrl}/sessions/${sessionId}/toolkits`, { headers: { 'x-test-tenant': tenant } })).json() as { data: { toolkits: string[] } }).data.toolkits
}

describe('Work session toolkit admission', () => {
  it('discovers server packages and persists independent selections through real HTTP admission', async () => {
    const catalogue = await (await fetch(baseUrl + '/toolkits')).json() as { data: { toolkits: Array<{ id: string; available: boolean }> } }
    expect(catalogue.data.toolkits.map(item => item.id)).toEqual(TOOLKIT_IDS)
    expect(catalogue.data.toolkits.filter(item => item.id !== 'mcp-management').every(item => item.available)).toBe(true)
    expect(catalogue.data.toolkits.find(item => item.id === 'mcp-management')?.available).toBe(false)
    const local = await (await fetch(baseUrl + '/toolkits', { headers: { 'x-test-tenant': 'default' } })).json() as typeof catalogue
    expect(local.data.toolkits.find(item => item.id === 'mcp-management')?.available).toBe(true)
    const code = await (await fetch(baseUrl + '/toolkits', { headers: { 'x-aether-tool-profile': 'code' } })).json() as typeof catalogue
    expect(code.data.toolkits).toEqual([])
    const restricted = await (await fetch(baseUrl + '/toolkits?agentId=' + restrictedAgentId)).json() as typeof catalogue
    expect(restricted.data.toolkits.every(item => !item.available)).toBe(true)
    expect((await chat('multi-package', { toolkits: [...TOOLKIT_IDS].reverse() })).body).toContain('TOOLKIT_MODEL_RESULT')
    expect(await selection('multi-package')).toEqual(TOOLKIT_IDS)
    for (const name of toolkitToolNames(TOOLKIT_IDS)) expect(offered.at(-1), name).toContain(name)
    const remaining = ['skill-management', 'automation']
    expect((await chat('multi-package', { toolkits: remaining })).body).toContain('TOOLKIT_MODEL_RESULT')
    expect(await selection('multi-package')).toEqual(remaining)
    expect(offered.at(-1)).not.toContain('knowledge_create')
    expect(offered.at(-1)).not.toContain('agent_create')
    expect((await chat('multi-package')).body).toContain('TOOLKIT_MODEL_RESULT')
    expect(await selection('multi-package')).toEqual(remaining)
  }, 30_000)

  it('admits MCP management in the local tenant, approves one disabled config and rejects shared config access from other tenants', async () => {
    const sessionId = 'mcp-http-approval', name = 'mcp_server_create'
    const args = { id: 'http-managed', name: 'HTTP managed MCP', transportType: 'http', url: 'https://example.invalid/mcp', scope: 'project' }
    nextToolCall = { id: 'mcp-create', name, args }
    const waiting = await chat(sessionId, { toolkits: ['mcp-management'] }, 'general', 'default')
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    const run = (await rootRunStore.list('default', sessionId)).at(-1)!
    expect(run.status, waiting.body.split('\n').filter(line => /"toolResult"/.test(line)).join('\n')).toBe('waiting')
    const { listServers } = await import('../../../../storage/mcp/mcp-config.js')
    expect(listServers(fixture, 'project')).toEqual([])
    const pending = run.pending[0]
    const response = { runId: run.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, name: pending.toolName, output: 'approved' }
    const resumed = await chat(sessionId, { toolkits: [], toolResponse: response }, 'general', 'default')
    expect(resumed.body).toContain('resourceChange')
    expect((await rootRunStore.get('default', run.runId))?.status).toBe('succeeded')
    expect((await chat(sessionId, { toolResponse: response }, 'general', 'default')).status).toBe(200)
    expect(listServers(fixture, 'project')).toEqual([expect.objectContaining({ id: args.id, name: args.name, enabled: false })])

    nextToolCall = { id: 'mcp-other-tenant', name: 'mcp_server_list', args: {} }
    const rejected = await chat('mcp-tenant-denied', { toolkits: ['mcp-management'] })
    const result = rejected.body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
      .find(frame => frame.toolResult?.toolCallId === 'mcp-other-tenant')?.toolResult
    expect(result).toMatchObject({ success: false })
    expect(result.output).not.toContain(args.name)
    expect(result.output).not.toContain(args.url)
    expect(await selection(sessionId, 'default')).toEqual(['mcp-management'])
  }, 30_000)

  it.each([
    ['knowledge-management', 'knowledge_create', { name: 'HTTP knowledge', description: 'Frozen' }],
    ['skill-management', 'skill_create', { name: 'http-skill', description: 'Frozen skill', content: 'Follow the original workflow.' }],
    ['automation', 'cron_create', { name: 'HTTP automation', message: 'Only the frozen task', enabled: false,
      configuration: { version: 2, schedule: { kind: 'calendar', localTime: '09:00', timeZone: 'Asia/Shanghai', daysOfWeek: [1] },
        target: { kind: 'standalone' }, notificationPolicy: 'all_runs', toolProfile: 'general' } }],
  ] as const)('runs %s mutation through durable chat approval and deduplicates repeated responses', async (toolkit, name, args) => {
    const sessionId = 'approval-' + toolkit
    nextToolCall = { id: 'call-' + toolkit, name, args }
    const waiting = await chat(sessionId, { toolkits: [toolkit] })
    expect(waiting.status).toBe(200)
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    const run = (await rootRunStore.list(tenantId, sessionId)).at(-1)!
    expect(run.status, waiting.body.split('\n').filter(line => /"toolResult"/.test(line)).join('\n')).toBe('waiting')
    const pending = run.pending[0]
    expect(pending.pendingAction?.type).toBe(name)
    const response = { runId: run.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, name: pending.toolName, output: 'approved' }
    const resumed = await chat(sessionId, { message: 'Do not replace the frozen operation', toolkits: [], toolResponse: response })
    expect(resumed.body).toContain('TOOLKIT_MODEL_RESULT')
    expect(resumed.body).toContain('resourceChange')
    expect((await rootRunStore.get(tenantId, run.runId))?.status).toBe('succeeded')
    expect((await chat(sessionId, { toolResponse: response })).status).toBe(200)
    if (toolkit === 'knowledge-management') {
      const bases = await (await import('../../../../storage/knowledge/kb-repo.js')).listKnowledgeBases(tenantId)
      expect(bases.filter(base => base.name === args.name)).toHaveLength(1)
    } else if (toolkit === 'automation') {
      const jobs = await (await import('../../../../scheduler/cron-service.js')).cronService.list(tenantId)
      expect(jobs.filter(job => job.name === args.name)).toHaveLength(1)
      expect(jobs.find(job => job.name === args.name)?.enabled).toBe(false)
    } else {
      const { SkillManagementService } = await import('../../../../skills/management-service.js')
      const service = new SkillManagementService()
      const context = { tenantId, principal: { tenantId, method: 'none' as const }, projectRoot: fixture }
      const skills = service.list(context, 'project').filter(skill => skill.name === args.name)
      expect(skills).toHaveLength(1)
      expect(service.get(context, skills[0].id).content).toContain(args.content)
    }
  }, 30_000)

  it.each([false, true])('imports a workspace document only when its approved source is unchanged (changed=%s)', async changed => {
    const repository = await import('../../../../storage/knowledge/kb-repo.js')
    const base = await repository.createKnowledgeBase(tenantId, 'Import ' + changed)
    const filename = 'import-' + changed + '.md', original = 'Approved knowledge content.'
    const source = path.join(fixture, filename)
    fs.writeFileSync(source, original)
    const sessionId = 'import-' + changed
    nextToolCall = { id: 'call-import', name: 'knowledge_import', args: { knowledgeBaseId: base.id, path: filename } }
    const waiting = await chat(sessionId, { toolkits: ['knowledge-management'] })
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    const run = (await rootRunStore.list(tenantId, sessionId)).at(-1)!
    expect(run.status, waiting.body.split('\n').filter(line => /"toolResult"/.test(line)).join('\n')).toBe('waiting')
    expect(await repository.listDocuments(tenantId, base.id)).toEqual([])
    if (changed) fs.writeFileSync(source, 'Replacement after preview.')
    const pending = run.pending[0]
    const response = { runId: run.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, name: pending.toolName, output: 'approved' }
    const resumed = await chat(sessionId, { toolkits: [], toolResponse: response })
    expect(resumed.body).toContain(changed ? 'Import source changed after preview' : 'resourceChange')
    expect((await chat(sessionId, { toolResponse: response })).status).toBe(200)
    const documents = await repository.listDocuments(tenantId, base.id)
    expect(documents).toHaveLength(changed ? 0 : 1)
    if (!changed) expect((await repository.getDocument(tenantId, documents[0].id))?.content).toBe(original)
  }, 30_000)

  it('grants reading selected knowledge while keeping the bound Agent mutation ceiling', async () => {
    const repository = await import('../../../../storage/knowledge/kb-repo.js')
    const allowed = await repository.createKnowledgeBase(tenantId, 'Allowed management')
    const blocked = await repository.createKnowledgeBase(tenantId, 'Blocked management')
    await repository.addDocument(tenantId, 'allowed.md', 'text/plain', 'Allowed research', allowed.id)
    await repository.addDocument(tenantId, 'blocked.md', 'text/plain', 'Restricted management marker', blocked.id)
    const { SQLiteAgentStore } = await import('../../../../storage/agent/index.js')
    const agent = await new SQLiteAgentStore().create(tenantId, { name: 'Scoped knowledge manager', skills: [], mcpServers: [],
      knowledgeBases: [allowed.id], allowedTools: [...KNOWLEDGE_MANAGEMENT_TOOLS] })
    const sessionId = 'knowledge-management-ceiling'
    const fields = { agentId: agent.id, toolkits: ['knowledge-management'], knowledgeBases: [blocked.id], managementKnowledgeScope: [blocked.id] }
    nextToolCall = { id: 'forbidden-import', name: 'knowledge_import', args: { knowledgeBaseId: blocked.id, filename: 'forbidden.md', content: 'Must not be saved' } }
    const denied = await chat(sessionId, fields)
    expect(denied.status).toBe(200)
    expect(denied.body).toContain('outside the explicitly bound resource scope')
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    expect((await rootRunStore.list(tenantId, sessionId)).at(-1)?.status).toBe('succeeded')
    expect(await repository.listDocuments(tenantId, blocked.id)).toHaveLength(1)
    nextToolCall = { id: 'restricted-search', name: 'knowledge_search', args: { query: 'Restricted management marker' } }
    const searched = await chat(sessionId, fields)
    const result = searched.body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
      .find(frame => frame.toolResult?.toolCallId === 'restricted-search')
    expect(result?.toolResult.success).toBe(true)
    expect(JSON.parse(result?.toolResult.output)).toEqual([expect.objectContaining({ knowledgeBaseId: blocked.id, content: 'Restricted management marker' })])
  }, 30_000)

  it('reads an explicitly selected knowledge base in ordinary Work even when the Agent has no configured knowledge', async () => {
    const repository = await import('../../../../storage/knowledge/kb-repo.js')
    const base = await repository.createKnowledgeBase(tenantId, '笑话集')
    const document = await repository.addDocument(tenantId, '笑话.txt', 'text/plain', '一个只在知识库里的笑话。', base.id)
    const other = await repository.createKnowledgeBase(tenantId, 'Unselected confidential library')
    const { SQLiteAgentStore } = await import('../../../../storage/agent/index.js')
    const agent = await new SQLiteAgentStore().create(tenantId, { name: '普通阅读助手', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['read_file'] })
    const sessionId = 'ordinary-reference-reader'
    const fields = { agentId: agent.id, toolkits: [], knowledgeBases: [base.id],
      message: `/kb:${base.id} 再看看\n<!--aether-refs:${JSON.stringify([{ t: 'kb', p: base.id, d: '笑话集', s: 0, e: 40 }])}-->` }
    nextToolCall = { id: 'list-selected', name: 'knowledge_documents', args: { knowledgeBaseId: base.id } }
    const listing = await chat(sessionId, fields)
    expect(listing.status).toBe(200)
    expect(listing.body).toContain('笑话.txt')
    for (const name of KNOWLEDGE_READ_TOOLS) expect(offered.at(-1)).toContain(name)
    expect(offered.at(-1)).not.toContain('knowledge_create')
    expect(offered.at(-1)).not.toContain('knowledge_delete')
    expect(await selection(sessionId)).toEqual([])
    const prompt = modelInputs.at(-2)!
    expect(prompt).toContain('本轮结构化选择的资料')
    expect(prompt).toContain('笑话集')
    expect(prompt).toContain('knowledge_document_get')
    expect(prompt).not.toContain(other.name)
    expect(JSON.parse(prompt).systemPrompt).not.toContain('本轮结构化选择的资料')
    expect(JSON.parse(prompt).requestContext).toContain('本轮结构化选择的资料')
    nextToolCall = { id: 'read-selected', name: 'knowledge_document_get', args: { id: document.id } }
    const reading = await chat(sessionId, fields)
    expect(reading.body).toContain('一个只在知识库里的笑话。')
    expect(reading.body).toContain('read-only')
    nextToolCall = { id: 'reject-unselected', name: 'knowledge_get', args: { id: other.id } }
    const rejected = await chat(sessionId, fields)
    expect(rejected.body).toContain('outside the explicitly bound resource scope')
    expect(rejected.body).not.toContain(other.name)
    expect((await chat(sessionId, { agentId: agent.id, toolkits: [], knowledgeBases: [] })).status).toBe(200)
    for (const name of KNOWLEDGE_READ_TOOLS) expect(offered.at(-1)).not.toContain(name)
    // History metadata and arbitrary request booleans cannot manufacture a read grant.
    expect((await chat('forged-knowledge-grant', { message: fields.message, knowledgeReadScope: [base.id] })).status).toBe(200)
    for (const name of KNOWLEDGE_READ_TOOLS) expect(offered.at(-1)).not.toContain(name)
  }, 30_000)

  it.each([[['']], [['same', 'same']], [Array.from({ length: 101 }, (_, i) => 'id-' + i)]])('rejects malformed or excessive knowledge selections before execution', async knowledgeBases => {
    const count = offered.length
    expect((await chat('invalid-knowledge-selection', { knowledgeBases })).status).toBe(400)
    expect(offered).toHaveLength(count)
  })

  it('defaults off, enables all schemas immediately, inherits omitted selections, and closes explicitly', async () => {
    expect(await selection('ordinary')).toEqual([])
    expect((await chat('ordinary')).body).toContain('TOOLKIT_MODEL_RESULT')
    expect(offered.at(-1)?.some(name => name.startsWith('agent_'))).toBe(false)
    const enabled = await chat('management', { toolkits: ['agent-management'] })
    expect(enabled.status).toBe(200); expect(enabled.body).toContain('TOOLKIT_MODEL_RESULT')
    expect(offered.at(-1)?.filter(name => name.startsWith('agent_'))).toEqual(AGENT_MANAGEMENT_TOOLS)
    expect(await selection('management')).toEqual(['agent-management'])
    expect(await selection('management', 'another-tenant')).toEqual([])
    const continued = await chat('management')
    expect(continued.body).toContain('TOOLKIT_MODEL_RESULT')
    expect(offered.at(-1)?.filter(name => name.startsWith('agent_'))).toEqual(AGENT_MANAGEMENT_TOOLS)
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    expect((await rootRunStore.list(tenantId, 'management')).map(run => run.requestConfig?.toolkits)).toEqual([['agent-management'], ['agent-management']])
    const disabled = await chat('management', { toolkits: [] })
    expect(disabled.body).toContain('TOOLKIT_MODEL_RESULT')
    expect(offered.at(-1)?.some(name => name.startsWith('agent_'))).toBe(false)
    expect(await selection('management')).toEqual([])
    expect((await rootRunStore.list(tenantId, 'management')).at(-1)?.requestConfig?.toolkits).toEqual([])
  }, 30_000)

  it('rejects Code and unknown packages before model execution or settings mutation', async () => {
    const calls = offered.length
    const code = await chat('code', { toolkits: ['agent-management'] }, 'code')
    expect(code.status).toBe(400); expect(code.body).toContain('Work')
    expect((await chat('unknown', { toolkits: ['arbitrary-tool'] })).status).toBe(400)
    expect(offered).toHaveLength(calls)
    expect(await selection('code')).toEqual([])
  })

  it('does not let request-level allowedTools override the bound Agent ceiling', async () => {
    const calls = offered.length
    const blocked = await chat('restricted', { agentId: restrictedAgentId, toolkits: ['agent-management'], allowedTools: [...AGENT_MANAGEMENT_TOOLS] })
    expect(blocked.status).toBe(403); expect(blocked.body).toContain('agent_delete')
    expect(offered).toHaveLength(calls)
    expect(await selection('restricted')).toEqual([])
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    expect(await rootRunStore.list(tenantId, 'restricted')).toEqual([])

    // Hiding the package selector must not turn an explicit request allowlist into a grant.
    const injected = await chat('restricted-no-package', { agentId: restrictedAgentId, toolkits: [],
      allowedTools: ['skill_delete', 'knowledge_delete', 'cron_create', 'agent_create'] })
    expect(injected.status).toBe(200)
    for (const name of ['skill_delete', 'knowledge_delete', 'cron_create', 'agent_create']) expect(offered.at(-1)).not.toContain(name)
  })

  it.each([false, true])('resumes a frozen Agent operation through HTTP without aliases or duplicate writes (legacy=%s)', async legacy => {
    const { SQLiteAgentStore } = await import('../../../../storage/agent/index.js')
    const agents = new SQLiteAgentStore()
    const before = await agents.list(tenantId)
    const sessionId = legacy ? 'legacy-approval' : 'approval'
    const name = legacy ? '已批准的旧版配置' : '已批准的配置'
    nextToolCall = { id: 'create-approved-agent', name: 'agent_create', args: { name, systemPrompt: '原始预览', allowedTools: [] } }
    const waiting = await chat(sessionId, { toolkits: ['agent-management'],
      ...(legacy ? { allowedTools: ['agent_list', 'agent_get', 'agent_do_create', 'agent_do_update', 'agent_do_delete'] } : {}) })
    expect(waiting.status).toBe(200)
    expect(await agents.list(tenantId)).toHaveLength(before.length)
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    const run = (await rootRunStore.list(tenantId, sessionId)).at(-1)!
    expect(run.status).toBe('waiting')
    const pending = run.pending[0]
    expect(pending.pendingAction?.type).toBe('agent_create')
    if (legacy) {
      // Persist the previous release's actual pending wire shape in the isolated
      // fixture, including the obsolete boolean. Its frozen operation is unchanged.
      pending.toolName = 'agent_do_create'
      pending.args = { ...pending.args, confirmed: true }
      await rootRunStore.update(tenantId, run.runId, { pending: [pending] })
    }
    await (await import('../../../../storage/session/toolkits.js')).clearSessionToolkits(tenantId, sessionId)
    const response = { runId: run.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, name: pending.toolName, output: 'approved' }
    const resumed = await chat(sessionId, { toolkits: [], message: '不要用此文本替换已批准的配置', toolResponse: response })
    expect(resumed.status).toBe(200)
    expect(resumed.body).toContain('TOOLKIT_MODEL_RESULT')
    const created = (await agents.list(tenantId)).filter(agent => !before.some(prior => prior.id === agent.id))
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ name, systemPrompt: '原始预览', allowedTools: [] })
    expect((await rootRunStore.get(tenantId, run.runId))?.status).toBe('succeeded')
    expect(offered.at(-1)?.filter(name => name.startsWith('agent_'))).toEqual(AGENT_MANAGEMENT_TOOLS)
    expect(await selection(sessionId)).toEqual([])
    expect((await chat(sessionId, { toolResponse: response })).status).toBe(200)
    expect(await agents.list(tenantId)).toHaveLength(before.length + 1)
  }, 30_000)

  it.each(['/tools', '/system-tools'])('publishes one entry per Agent capability in %s, including with OSM disabled', async route => {
    const response = await fetch(baseUrl + route)
    const body = await response.json() as { data: Array<{ name: string; displayName: string }> }
    expect(response.status).toBe(200)
    const management = body.data.filter(tool => tool.name.startsWith('agent_'))
    expect(management.map(tool => tool.name)).toEqual(AGENT_MANAGEMENT_TOOLS)
    expect(new Set(management.map(tool => tool.displayName)).size).toBe(5)
  })

  it('uses the same OSM-aware defaults for catalogue checkboxes and Agent creation without hiding selectable tools', async () => {
    const response = await fetch(baseUrl + '/tools')
    const body = await response.json() as { data: Array<{ name: string; defaultEnabled: boolean }> }
    const defaults = body.data.filter(tool => tool.defaultEnabled).map(tool => tool.name).sort()
    expect(body.data.find(tool => tool.name === 'execute_cmd')).toMatchObject({ defaultEnabled: false })
    expect(body.data.find(tool => tool.name === 'agent_create')).toMatchObject({ defaultEnabled: false })
    expect(body.data.find(tool => tool.name === 'plan_update')).toMatchObject({ defaultEnabled: false })
    expect(defaults).toContain('read_file')
    const created = await fetch(baseUrl + '/agents', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '与界面一致的默认权限' }) })
    expect(created.status).toBe(200)
    const agent = await created.json() as { data: { allowedTools: string[] } }
    expect(agent.data.allowedTools.slice().sort()).toEqual(defaults)
    const code = await (await fetch(baseUrl + '/tools', { headers: { 'x-aether-tool-profile': 'code' } })).json() as typeof body
    expect(code.data.find(tool => tool.name === 'execute_cmd')).toMatchObject({ defaultEnabled: true })
    expect(code.data.some(tool => tool.name.startsWith('agent_'))).toBe(false)
  })
})
