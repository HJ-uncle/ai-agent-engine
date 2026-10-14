// Actual authenticated HTTP chat, factory, ReAct, child runner, SQLite and browser broker/routes.
// Only model generation and external MCP discovery are controlled. This does not exercise a native browser.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../../../storage/agent/index.js'
import type { AgentContext, ToolResult } from '../../../../core/agent-context/types.js'
import type { LLMAdapter } from '../../../../core/llm-adapter/types.js'
import type { BrowserCommand } from '../../../../tools/browser/browser-bridge.js'
import type { BrowserExecutionIdentity } from '../../../../core/browser-execution.js'

const tenantId = 'browser-context-tenant'
const userId = 'browser-context-user'
const otherUserId = 'browser-context-other-user'
const key = 'local-browser-context-api-key'
const otherKey = 'local-browser-context-other-api-key'
const instanceToken = 'local-browser-context-instance-gate'
let otherCredential: string
let fixture: string
let app: FastifyInstance
let baseUrl: string
let main: Agent
let child: Agent
let anonymousMain: Agent
let anonymousChild: Agent
let closeDatabase: () => Promise<void>
const observed: Array<{ sessionId: string; rootSessionId?: string; rootRunId?: string; runId?: string;
  authority: AgentContext['browserAuthority']; principal: AgentContext['browserPrincipal']; principalFrozen: boolean; execution?: Readonly<BrowserExecutionIdentity>; result?: ToolResult }> = []
const delivered: BrowserCommand[] = []

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-browser-context-'))
  for (const [name, value] of Object.entries({ DATA_DIR: path.join(fixture, 'agent.db'), WORKSPACE_ROOT: path.join(fixture, 'scratch'),
    HISTORY_BACKEND: 'jsonl', MEMORY_DB_PATH: path.join(fixture, 'memory.db'), AETHER_GLOBAL_DIR: path.join(fixture, 'global'),
    SKILLS_ROOT: path.join(fixture, 'skills'), OSM_MODE: 'balanced', AUTH_ENABLED: 'true', AETHER_INSTANCE_TOKEN: instanceToken, JWT_SECRET: 'browser-context-fixture-jwt-secret',
    LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false', DEFAULT_SECURITY_MODE: 'standard', AGENT_TOTAL_TOKEN_LIMIT: '', SUBAGENT_TOKEN_LIMIT: '' })) vi.stubEnv(name, value)
  const database = await import('../../../../storage/sqlite/db.js')
  await database.initDb()
  await database.getDb().execute({ sql: 'INSERT INTO users(id,tenant_id,api_key_hash,name) VALUES(?,?,?,?)',
    args: [userId, tenantId, createHash('sha256').update(key).digest('hex'), userId] })
  // The legacy user table is one-user-per-tenant; a real verified JWT exercises same-tenant alternate principal without changing that schema.
  const { SignJWT } = await import('jose')
  otherCredential = await new SignJWT({ tenantId }).setProtectedHeader({ alg: 'HS256' }).setSubject(otherUserId)
    .setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode('browser-context-fixture-jwt-secret'))
  closeDatabase = async () => {
    const db = database.getDb() as import('../../../../storage/sqlite/local-process-client.js').LocalSqliteProcessClient
    database.closeDb()
    await db.whenClosed()
    await (await import('../../../../storage/memory/db.js')).closeMemoryDb()
  }
  const { SQLiteAgentStore } = await import('../../../../storage/agent/index.js')
  const store = new SQLiteAgentStore()
  main = await store.create(tenantId, { name: 'Browser root', model: 'browser-main-fixture', systemPrompt: 'ROOT_BROWSER_PROFILE',
    skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['browser_tabs', 'ask_user'] })
  child = await store.create(tenantId, { name: 'Browser child', model: 'browser-child-fixture', systemPrompt: 'CHILD_BROWSER_PROFILE',
    skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['browser_tabs'] })
  anonymousMain = await store.create('default', { name: 'Anonymous instance root', model: 'browser-main-fixture', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['browser_tabs'] })
  anonymousChild = await store.create('default', { name: 'Anonymous instance child', model: 'browser-child-fixture', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['browser_tabs'] })
  const mcp = await import('../../../../tools/mcp/loader.js')
  vi.spyOn(mcp, 'registerMCPTools').mockResolvedValue([])
  const resolver = await import('../../../../core/llm-adapter/resolve-model.js')
  const { resolveCapabilities } = await import('../../../../core/model-capabilities/index.js')
  vi.spyOn(resolver, 'resolveModelConfig').mockImplementation(async ({ model, parent }) => ({ model: model ?? parent?.model ?? 'browser-main-fixture',
    provider: 'fixture', capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
  vi.spyOn(resolver, 'createAdapterFromResolved').mockImplementation(config => {
    const adapter: LLMAdapter = { model: config.model, provider: 'fixture', countTokens: text => Math.ceil(text.length / 4),
      complete: async () => { throw new Error('No external model transport is allowed in this fixture') },
      async *stream(messages) {
        const lastUser = messages.map(message => message.role).lastIndexOf('user')
        const current = messages.slice(lastUser)
        if (!current.some(message => message.role === 'tool' && message.toolName === 'browser_tabs')) {
          yield { done: true, finishReason: 'tool_calls', promptTokens: 11, completionTokens: 4,
            toolCalls: [{ id: 'actual-browser-tabs', name: 'browser_tabs', args: '{}', index: 0 }] }
          return
        }
        if (config.model === 'browser-child-fixture' && String(messages[lastUser]?.content).includes('CONTINUE_BROWSER_CHILD')) {
          expect(messages.some(message => message.role === 'assistant' && message.content === 'CHILD_BROWSER_FIRST_SENTINEL')).toBe(true)
        }
        if (config.model === 'browser-main-fixture' && String(messages[lastUser]?.content).includes('WAIT_BROWSER_ROOT')) {
          yield { done: true, finishReason: 'tool_calls', promptTokens: 13, completionTokens: 5,
            toolCalls: [{ id: 'actual-browser-root-question', name: 'ask_user', index: 0,
              args: JSON.stringify({ question: 'Choose a fixture variant', options: [{ label: 'Blue' }, { label: 'Green' }] }) }] }
          return
        }
        yield { done: true, finishReason: 'stop', promptTokens: 13, completionTokens: 5,
          content: config.model === 'browser-child-fixture'
            ? String(messages[lastUser]?.content).includes('CONTINUE_BROWSER_CHILD') ? 'CHILD_BROWSER_CONTINUED' : 'CHILD_BROWSER_FIRST_SENTINEL'
            : 'ROOT_BROWSER_RESULT' }
      } }
    return adapter
  })
  const { browserBridge } = await import('../../../../tools/browser/browser-bridge.js')
  const { browserExecutionIdentity } = await import('../../../../core/browser-execution.js')
  const realExecute = browserBridge.execute.bind(browserBridge)
  vi.spyOn(browserBridge, 'execute').mockImplementation(async (action, args, context) => {
    const record = { sessionId: context.sessionId, rootSessionId: context.rootSessionId, rootRunId: context.rootRunId, runId: context.runId,
      authority: context.browserAuthority, principal: context.browserPrincipal, principalFrozen: Object.isFrozen(context.browserPrincipal), execution: browserExecutionIdentity(context) }
    observed.push(record)
    const result = await realExecute(action, args, context)
    Object.assign(record, { result })
    return result
  })
  const middleware = await import('../../middleware.js')
  middleware.configureRequestAuthentication()
  app = Fastify()
  app.addHook('onRequest', middleware.authMiddlewareHook)
  await app.register((await import('../chat.js')).chatRoutes, { prefix: '/api/v1' })
  await app.register((await import('../browser.js')).browserRoutes, { prefix: '/api/v1' })
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
}, 30_000)

afterAll(async () => {
  await app?.close()
  await closeDatabase?.()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (!fixture) return
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-browser-context-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

function headers(credential = key): Record<string, string> {
  return { 'content-type': 'application/json', 'x-aether-instance-token': instanceToken,
    ...(credential === otherKey ? { authorization: `Bearer ${otherCredential}` } : { 'x-api-key': credential }) }
}
async function register(sessionId: string) {
  const response = await fetch(baseUrl + '/api/v1/browser/clients', { method: 'POST', headers: headers(),
    body: JSON.stringify({ sessionId, protocolVersion: 2 }) })
  expect(response.status).toBe(200)
  return (await response.json()).data as { clientId: string; clientToken: string }
}
async function chatWithClient(sessionId: string, client: { clientId: string; clientToken: string }, message: string,
  collaborators: Array<{ agentId?: string; resumeRunId?: string }> = [], credential = key) {
  const polling = new AbortController()
  const clientHeaders = { ...headers(), 'x-aether-browser-token': client.clientToken }
  const pump = (async () => {
    try {
      while (!polling.signal.aborted) {
        const response = await fetch(`${baseUrl}/api/v1/browser/clients/${client.clientId}/commands`, { headers: clientHeaders, signal: polling.signal })
        expect(response.status).toBe(200)
        const commands = (await response.json()).data.commands as BrowserCommand[]
        for (const command of commands) {
          delivered.push(command)
          const answer = await fetch(`${baseUrl}/api/v1/browser/clients/${client.clientId}/results`, { method: 'POST', headers: clientHeaders,
            signal: polling.signal, body: JSON.stringify({ requestId: command.requestId, execution: command.execution,
              success: true, output: 'FIXTURE_NATIVE_TABS', metadata: { code: 'BROWSER_OBSERVATION_COMPLETE', operationPerformed: false } }) })
          expect(answer.status).toBe(200)
          expect((await answer.json()).data.accepted).toBe(true)
        }
      }
    } catch (error) { if (!polling.signal.aborted) throw error }
  })()
  try {
    const response = await fetch(baseUrl + '/api/v1/chat', { method: 'POST', headers: { ...headers(credential),
      'x-aether-tool-profile': 'general', 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2' },
      body: JSON.stringify({ sessionId, message, agentId: main.id, model: 'browser-main-fixture', collaborators, memoryScope: 'off', workspacePaths: [fixture],
        browserPrincipal: { tenantId: 'forged-tenant', userId: 'forged-user', method: 'jwt' }, rootRunId: 'forged-root-run',
        metadata: { browserPrincipal: { tenantId: 'forged-metadata-tenant', userId: 'forged-metadata-user', method: 'jwt' }, rootRunId: 'forged-historical-root' } }) })
    const body = await response.text()
    const diagnostics = path.resolve('.e2e-tmp/browser-context-fixture')
    fs.mkdirSync(diagnostics, { recursive: true })
    fs.writeFileSync(path.join(diagnostics, sessionId + '-' + observed.length + '.sse.txt'), body)
    return { status: response.status, body }
  } finally { polling.abort(); await pump }
}

async function chatViaHost(sessionId: string, kind: 'account' | 'instance', companionSessionId?: string, waiting = false) {
  const transportHeaders: Record<string, string> = kind === 'account' ? headers() : { 'content-type': 'application/json', 'x-aether-instance-token': instanceToken }
  const hostResponse = await app.inject({ method: 'POST', url: '/api/v1/browser/hosts', headers: transportHeaders, payload: { protocolVersion: 1, authorityKind: kind } })
  expect(hostResponse.statusCode).toBe(200)
  const host = hostResponse.json().data as { hostId: string; hostToken: string; authority: AgentContext['browserAuthority'] }
  const hostHeaders: Record<string, string> = { ...transportHeaders, 'x-aether-browser-host-token': host.hostToken }
  const polling = new AbortController()
  let client: { clientId: string; clientToken: string } | undefined
  const clients: Array<{ clientId: string; clientToken: string }> = []
  let demandExecution: BrowserExecutionIdentity | undefined
  const pump = (async () => {
    const executions: Promise<void>[] = []
    while (clients.length < (companionSessionId ? 2 : 1)) {
      const pending = await fetch(`${baseUrl}/api/v1/browser/hosts/${host.hostId}/demands`, { headers: hostHeaders, signal: polling.signal })
      expect(pending.status).toBe(200)
      const demands = (await pending.json()).data.demands as Array<{ demandId: string; demandToken: string; execution: BrowserExecutionIdentity }>
      expect(demands.length).toBeGreaterThan(0)
      for (const demand of demands) {
        const primary = demand.execution.rootSessionId === sessionId
        expect([sessionId, companionSessionId]).toContain(demand.execution.rootSessionId)
        if (primary) demandExecution = demand.execution
        const ready = await fetch(`${baseUrl}/api/v1/browser/hosts/${host.hostId}/demands/${demand.demandId}/client`, {
          method: 'POST', headers: hostHeaders, signal: polling.signal, body: JSON.stringify({ demandToken: demand.demandToken, execution: demand.execution }) })
        expect(ready.status).toBe(200)
        const registration = (await ready.json()).data as { clientId: string; clientToken: string }
        clients.push(registration)
        if (primary) client = registration
        executions.push((async () => {
          const clientHeaders = { ...transportHeaders, 'x-aether-browser-token': registration.clientToken }
          // Real selected child + root share one root client; a concurrent root gets another client.
          for (let index = 0; index < (primary ? 2 : 1); index++) {
            const response = await fetch(`${baseUrl}/api/v1/browser/clients/${registration.clientId}/commands`, { headers: clientHeaders, signal: polling.signal })
            expect(response.status).toBe(200)
            const commands = (await response.json()).data.commands as BrowserCommand[]
            expect(commands).toHaveLength(1)
            expect(commands[0].execution?.rootSessionId).toBe(demand.execution.rootSessionId)
            expect(commands[0].execution?.rootRunId).toBe(demand.execution.rootRunId)
            delivered.push(commands[0])
            const answer = await fetch(`${baseUrl}/api/v1/browser/clients/${registration.clientId}/results`, { method: 'POST', headers: clientHeaders, signal: polling.signal,
              body: JSON.stringify({ requestId: commands[0].requestId, execution: commands[0].execution, success: true, output: 'HOST_BARRIER_ACTUAL_RESULT',
                metadata: { code: 'BROWSER_OBSERVATION_COMPLETE', operationPerformed: false } }) })
            expect(answer.status).toBe(200); expect((await answer.json()).data.accepted).toBe(true)
          }
        })())
      }
    }
    await Promise.all(executions)
  })()
  const request = (async () => {
    const response = await fetch(baseUrl + '/api/v1/chat', { method: 'POST', headers: { ...transportHeaders, 'x-aether-tool-profile': 'general', 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2' },
      signal: AbortSignal.any([polling.signal, AbortSignal.timeout(10_000)]),
      body: JSON.stringify({ sessionId, message: waiting ? 'WAIT_BROWSER_ROOT' : 'FIRST_BROWSER_CHILD', agentId: kind === 'account' ? main.id : anonymousMain.id,
        collaborators: [{ agentId: kind === 'account' ? child.id : anonymousChild.id }], model: 'browser-main-fixture', memoryScope: 'off', workspacePaths: [fixture],
        browserAuthority: { kind: 'account', tenantId: 'forged', userId: 'forged-user' } }) })
    const body = await response.text()
    fs.mkdirSync(path.resolve('.e2e-tmp/browser-context-fixture'), { recursive: true })
    fs.writeFileSync(path.resolve('.e2e-tmp/browser-context-fixture', sessionId + '.host-sse.txt'), body)
    return { status: response.status, body }
  })()
  const companion = companionSessionId ? (async () => {
    const response = await fetch(baseUrl + '/api/v1/chat', { method: 'POST', headers: { ...transportHeaders,
      'x-aether-tool-profile': 'general', 'x-aether-run-lifetime': 'durable', 'x-aether-subagent-protocol': '2' },
      signal: AbortSignal.any([polling.signal, AbortSignal.timeout(10_000)]),
      body: JSON.stringify({ sessionId: companionSessionId, message: 'INDEPENDENT_HEALTHY_ROOT', agentId: main.id,
        model: 'browser-main-fixture', memoryScope: 'off', workspacePaths: [fixture] }) })
    return { status: response.status, body: await response.text() }
  })() : undefined
  try {
    const [result, , companionResult] = await Promise.all([request, pump, companion])
    expect(client).toBeDefined()
    if (waiting) {
      const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
      const run = (await rootRunStore.list(tenantId, sessionId))[0]
      expect(run.status).toBe('waiting')
      const renewed = await app.inject({ method: 'POST', url: '/api/v1/browser/clients', headers: transportHeaders,
        payload: { protocolVersion: 2, sessionId, clientId: client!.clientId, clientToken: client!.clientToken } })
      expect(renewed.statusCode).toBe(200)
      const cancelled = await app.inject({ method: 'POST', url: '/api/v1/chat/cancel', headers: transportHeaders,
        payload: { sessionId, runId: run.runId } })
      expect(cancelled.statusCode).toBe(200)
      expect((await rootRunStore.get(tenantId, run.runId))?.status).toBe('cancelled')
    }
    for (const registration of clients) {
      const closed = await app.inject({ method: 'GET', url: `/api/v1/browser/clients/${registration.clientId}/commands`, headers: { ...transportHeaders, 'x-aether-browser-token': registration.clientToken } })
      expect(closed.statusCode).toBe(404)
    }
    return { ...result, host, demandExecution, companionResult }
  } finally {
    polling.abort(); await pump.catch(() => undefined)
    const { 'content-type': _bodyType, ...deleteHeaders } = hostHeaders
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/browser/hosts/${host.hostId}`, headers: deleteHeaders })
    expect(deleted.statusCode).toBe(200)
  }
}

describe('trusted browser context from actual chat and actual child production', () => {
  it('uses authenticated principal and current admission for root and child despite forged body/metadata', async () => {
    const sessionId = 'browser-real-root-child'
    const client = await register(sessionId)
    const before = observed.length
    const result = await chatWithClient(sessionId, client, 'FIRST_BROWSER_CHILD', [{ agentId: child.id }])
    expect(result.status).toBe(200)
    expect(result.body).toContain('CHILD_BROWSER_FIRST_SENTINEL')
    expect(result.body).toContain('ROOT_BROWSER_RESULT')
    const current = observed.slice(before)
    expect(current).toHaveLength(2)
    const root = current.find(record => record.sessionId === sessionId)!
    const actualChild = current.find(record => record.sessionId !== sessionId)!
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    const roots = await rootRunStore.list(tenantId, sessionId)
    const { getSubagentStore } = await import('../../../../core/subagent/store.js')
    const children = await getSubagentStore().listRunsForParent(tenantId, sessionId)
    expect(roots).toHaveLength(1)
    expect(children).toHaveLength(1)
    expect(root.execution).toEqual({ rootSessionId: sessionId, rootRunId: roots[0].runId, ownerRunId: roots[0].runId })
    expect(actualChild.execution).toEqual({ rootSessionId: sessionId, rootRunId: roots[0].runId, ownerRunId: children[0].runId })
    expect(actualChild.sessionId).toBe(children[0].childSessionId)
    expect(children[0].status).toBe('succeeded')
    for (const record of current) {
      expect(record.principal).toEqual({ tenantId, userId, method: 'api-key' }); expect(record.authority).toEqual({ kind: 'account', tenantId, userId })
      expect(record.principalFrozen).toBe(true)
      expect(record.result?.success).toBe(true)
      expect(delivered.some(command => JSON.stringify(command.execution) === JSON.stringify(record.execution))).toBe(true)
    }
  }, 20_000)

  it('resumes real child context with a new child run and the current root admission instead of the historical root', async () => {
    const sessionId = 'browser-real-resume'
    const client = await register(sessionId)
    expect((await chatWithClient(sessionId, client, 'FIRST_BROWSER_CHILD', [{ agentId: child.id }])).status).toBe(200)
    const { getSubagentStore } = await import('../../../../core/subagent/store.js')
    const firstChild = (await getSubagentStore().listRunsForParent(tenantId, sessionId))[0]
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    const firstRoot = (await rootRunStore.list(tenantId, sessionId))[0]
    const before = observed.length
    const second = await chatWithClient(sessionId, client, 'CONTINUE_BROWSER_CHILD', [{ resumeRunId: firstChild.runId }])
    expect(second.status).toBe(200)
    expect(second.body).toContain('CHILD_BROWSER_CONTINUED')
    const children = await getSubagentStore().listRunsForParent(tenantId, sessionId)
    const resumed = children.find(record => record.resumeFromRunId === firstChild.runId)!
    const roots = await rootRunStore.list(tenantId, sessionId)
    const newRoot = roots.find(record => record.runId !== firstRoot.runId)!
    const current = observed.slice(before)
    expect(current).toHaveLength(2)
    expect(resumed).toMatchObject({ childSessionId: firstChild.childSessionId, status: 'succeeded' })
    expect(resumed.runId).not.toBe(firstChild.runId)
    expect(newRoot.runId).not.toBe(firstRoot.runId)
    const actualChild = current.find(record => record.sessionId === firstChild.childSessionId)!
    expect(actualChild.execution).toEqual({ rootSessionId: sessionId, rootRunId: newRoot.runId, ownerRunId: resumed.runId })
    for (const record of current) {
      expect(record.principal).toEqual({ tenantId, userId, method: 'api-key' }); expect(record.authority).toEqual({ kind: 'account', tenantId, userId })
      expect(record.rootRunId).toBe(newRoot.runId)
      expect(record.result?.success).toBe(true)
    }
  }, 20_000)

  it('keeps another real authenticated user isolated from a same-tenant browser client', async () => {
    const sessionId = 'browser-real-other-user'
    const client = await register(sessionId)
    const before = observed.length
    const commandCount = delivered.length
    const response = await chatWithClient(sessionId, client, 'ROOT_OTHER_USER', [], otherKey)
    expect(response.status).toBe(200)
    const current = observed.slice(before)
    expect(current).toHaveLength(1)
    expect(current[0].principal).toEqual({ tenantId, userId: otherUserId, method: 'jwt' }); expect(current[0].authority).toEqual({ kind: 'account', tenantId, userId: otherUserId })
    expect(current[0].result).toMatchObject({ success: false,
      metadata: { code: 'BROWSER_EXECUTION_PRINCIPAL_MISMATCH', operationPerformed: false } })
    expect(delivered.length).toBe(commandCount)
  }, 20_000)

  it('performs first-use host registration from actual authenticated chat and child, then releases its exact root client at completion', async () => {
    const sessionId = 'actual-account-host-first-use', before = observed.length
    const result = await chatViaHost(sessionId, 'account')
    expect(result.status).toBe(200); expect(result.body).toContain('CHILD_BROWSER_FIRST_SENTINEL')
    const current = observed.slice(before)
    expect(current).toHaveLength(2)
    const actualChild = current.find(record => record.sessionId !== sessionId)!
    expect(result.demandExecution).toEqual(actualChild.execution)
    for (const record of current) {
      expect(record.authority).toEqual(result.host.authority)
      expect(record.principal).toEqual({ tenantId, userId, method: 'api-key' })
      expect(record.result?.success).toBe(true)
    }
  }, 20_000)

  it('performs default/none embedded first use through actual chat and child without borrowing the logged-in account host', async () => {
    vi.stubEnv('AUTH_ENABLED', 'false')
    ;(await import('../../middleware.js')).configureRequestAuthentication()
    const sessionId = 'actual-instance-host-first-use', before = observed.length
    const result = await chatViaHost(sessionId, 'instance')
    expect(result.status).toBe(200); expect(result.body).toContain('CHILD_BROWSER_FIRST_SENTINEL')
    expect(result.host.authority).toMatchObject({ kind: 'instance', tenantId: 'default' })
    const current = observed.slice(before)
    expect(current).toHaveLength(2)
    expect(result.demandExecution).toEqual(current.find(record => record.sessionId !== sessionId)!.execution)
    for (const record of current) {
      expect(record.authority).toEqual(result.host.authority)
      expect(record.principal).toEqual({ tenantId: 'default', userId: undefined, method: 'none' })
      expect(record.result?.success).toBe(true)
    }
  }, 20_000)

  it('closes the actual producer and owned client when all terminal writes fail while another root completes normally', async () => {
    const { rootRunStore } = await import('../../../../storage/root-runs/index.js')
    const { activeStreams } = await import('../../../../core/stream-pipeline/stream-bus.js')
    vi.stubEnv('AUTH_ENABLED', 'true')
    ;(await import('../../middleware.js')).configureRequestAuthentication()
    const failedSession = 'actual-host-terminal-persistence-failure', healthySession = 'actual-host-independent-root'
    const update = rootRunStore.update.bind(rootRunStore), failures: Error[] = []
    const terminalWrite = vi.spyOn(rootRunStore, 'update').mockImplementation(async (...args) => {
      const run = await rootRunStore.get(args[0], args[1])
      if (run?.sessionId === failedSession && args[2].status && args[2].status !== 'running' && args[2].status !== 'waiting') {
        const error = new Error('FIXTURE_TERMINAL_DISK_FULL_' + failures.length)
        failures.push(error)
        throw error
      }
      return update(...args)
    })
    try {
      const failed = await chatViaHost(failedSession, 'account', healthySession), healthy = failed.companionResult!
      expect(healthy.status).toBe(200); expect(healthy.body).toContain('ROOT_BROWSER_RESULT')
      expect((await rootRunStore.list(tenantId, healthySession))[0].status).toBe('succeeded')
      expect(failed.status).toBe(200); expect(failed.body).toContain('Chat terminal state could not be persisted')
      expect(failed.body).toContain('event: done')
      expect(failures.length).toBeGreaterThanOrEqual(3)
      const brokenRun = (await rootRunStore.list(tenantId, failedSession))[0]
      // The failed persistence remains visible; cleanup must not invent a durable terminal row.
      expect(brokenRun.status).toBe('running')
      const bus = activeStreams.get(`${tenantId}:${failedSession}`)!
      expect(bus.finished).toBe(true)
      expect(bus.errorObj).toBeInstanceOf(AggregateError)
      const collectErrors = (value: unknown): unknown[] => value instanceof AggregateError
        ? [value, ...value.errors.flatMap(collectErrors)] : [value]
      for (const error of failures) expect(collectErrors(bus.errorObj)).toContain(error)
      const status = await app.inject({ url: `/api/v1/chat/status?sessionId=${failedSession}`, headers: headers() })
      expect(status.json().data).toMatchObject({ running: false, finished: true })
    } finally {
      terminalWrite.mockRestore()
    }
  }, 20_000)

  it('retains an actual healthy waiting root client until exact cancellation releases it', async () => {
    const result = await chatViaHost('actual-browser-healthy-waiting', 'account', undefined, true)
    expect(result.status).toBe(200)
    expect(result.body).toContain('Choose a fixture variant')
    expect(result.body).toContain('event: done')
  }, 20_000)
})
