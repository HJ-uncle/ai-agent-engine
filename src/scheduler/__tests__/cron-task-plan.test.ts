/** Real cron selection -> HTTP /chat -> shared ReAct -> SQLite plan/history. Only the LLM is controlled. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LLMAdapter, LLMAdapterOptions } from '../../core/llm-adapter/types.js'
import type { Message } from '../../core/agent-context/types.js'
import type { CronJob } from '../../storage/cron/index.js'
import type { TaskPlan } from '../../storage/todo/index.js'
import { TodoStore } from '../../storage/todo/index.js'
import { CronStore } from '../../storage/cron/index.js'
import { rootRunStore } from '../../storage/root-runs/index.js'
import { closeDb, getDb, initDb } from '../../storage/sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../storage/sqlite/local-process-client.js'
import { CronScheduler } from '../cron-scheduler.js'
import { configureRequestAuthentication } from '../../api/http/middleware.js'

let fixture: string, baseUrl: string, app: FastifyInstance, scheduler: CronScheduler
const databaseClients: LocalSqliteProcessClient[] = []
const todoStore = new TodoStore(), cronStore = new CronStore()
const requests: Array<{ session: string; options?: LLMAdapterOptions; messages: Message[] }> = []
const streams: Array<{ sessionId: string; frames: Array<Record<string, unknown>> }> = []
const collection: Promise<void>[] = []
let jobs: CronJob[]
function sessionOf(job: CronJob): string {
  if (job.configuration.target.kind !== 'session' || job.sessionId === null) throw new Error('Cron plan fixture requires a reuse session')
  return job.sessionId
}
const tenantId = 'default'
vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'c7'.repeat(32) })

function parseSse(raw: string): Array<Record<string, unknown>> {
  return raw.split(/\r?\n\r?\n/).flatMap(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    if (!data || data === '[DONE]') return []
    return [JSON.parse(data) as Record<string, unknown>]
  })
}
async function startHttp(): Promise<void> {
  app = Fastify()
  app.decorateRequest('authContext', null)
  app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId } }) })
  await app.register((await import('../../api/http/routes/chat.js')).chatRoutes, { prefix: '/api/v1' })
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  scheduler = new CronScheduler(baseUrl)
}
function connect(): LocalSqliteProcessClient {
  const db = getDb() as LocalSqliteProcessClient
  databaseClients.push(db)
  return db
}

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-cron-plan-'))
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(fixture, 'agent.db'), WORKSPACE_ROOT: path.join(fixture, 'scratch'),
    HISTORY_BACKEND: 'sqlite', MEMORY_DB_PATH: path.join(fixture, 'memory.db'), AETHER_GLOBAL_DIR: path.join(fixture, 'global'),
    MCP_CONFIG_PATH: path.join(fixture, 'mcp.json'), SKILLS_ROOT: path.join(fixture, 'skills'), OSM_MODE: 'off', AUTH_ENABLED: 'false',
    AETHER_INSTANCE_TOKEN: '', LOG_LEVEL: 'silent', QA_LOG_ENABLED: 'false', ENABLE_LONG_TERM_MEMORY: 'false',
    AGENT_TOTAL_TOKEN_LIMIT: '', DEFAULT_SECURITY_MODE: 'safe', AUTO_COMPACT_THRESHOLD_RATIO: '0.92' })) vi.stubEnv(key, value)
  configureRequestAuthentication()
  closeDb(); connect(); await initDb()
  const { SQLiteAgentStore } = await import('../../storage/agent/index.js')
  const agent = await new SQLiteAgentStore().create(tenantId, { name: '自动化计划助手', systemPrompt: 'AUTOMATION_PLAN_PROFILE',
    model: 'cron-plan-fixture', allowedTools: [], skills: [], mcpServers: [], knowledgeBases: [] })
  jobs = await Promise.all(['alpha', 'beta'].map(name => cronStore.create(tenantId, { name: `计划自动化 ${name}`, cronExpr: '* * * * *',
    message: `执行自动化 ${name} 的调查与验证工作`, sessionId: `cron-plan-${name}`, agentId: agent.id, enabled: true })))
  const { skillsRegistry } = await import('../../skills/index.js')
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([])
  const resolver = await import('../../core/llm-adapter/resolve-model.js')
  const { resolveCapabilities } = await import('../../core/model-capabilities/index.js')
  vi.spyOn(resolver, 'resolveModelConfig').mockImplementation(async ({ model, parent }) => ({ model: model ?? parent?.model ?? 'cron-plan-fixture',
    provider: 'fixture', capabilities: resolveCapabilities({ model: 'gpt-4o', provider: 'openai' }), thinkingEnabled: false }))
  vi.spyOn(resolver, 'createAdapterFromResolved').mockImplementation(config => {
    const adapter: LLMAdapter = { model: config.model, provider: 'fixture', countTokens: value => Math.ceil(value.length / 4),
      complete: async () => { throw new Error('Unexpected completion transport') },
      async *stream(messages, options) {
        const lastUser = messages.map(message => message.role).lastIndexOf('user')
        const user = String(messages[lastUser]?.content)
        const name = user.includes('alpha') ? 'alpha' : 'beta'
        const session = `cron-plan-${name}`
        requests.push({ session, options, messages: structuredClone(messages) })
        const currentReceipts = messages.slice(lastUser).filter(message => message.role === 'tool' && message.toolName === 'plan_update')
        if (currentReceipts.length >= 2) {
          yield { done: true, finishReason: 'stop', content: `${name} 的自动化调查与验证已完成`, promptTokens: 30, completionTokens: 10 }
          return
        }
        const previousReceipt = messages.filter(message => message.role === 'tool' && message.toolName === 'plan_update').at(-1)
        const previous = previousReceipt ? JSON.parse(String(previousReceipt.content)) as TaskPlan : undefined
        const completed = currentReceipts.length === 1
        const plan = [
          { ...(previous?.plan[0] ? { id: previous.plan[0].id } : {}), step: `调查 ${name}`, status: completed ? 'completed' : 'in_progress' },
          { ...(previous?.plan[1] ? { id: previous.plan[1].id } : {}), step: `验证 ${name}`, status: completed ? 'completed' : 'pending' },
        ]
        yield { done: true, finishReason: 'tool_calls', promptTokens: 20, completionTokens: 10,
          toolCalls: [{ id: `plan-${name}-${messages.length}`, name: 'plan_update', args: JSON.stringify({ plan }), index: 0 }] }
      },
    }
    return adapter
  })
  const originalFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await originalFetch(input, init)
    if (String(input).endsWith('/api/v1/chat') && response.headers.get('content-type')?.includes('text/event-stream')) {
      const body = JSON.parse(String(init?.body)) as { sessionId: string }
      collection.push(response.clone().text().then(raw => { streams.push({ sessionId: body.sessionId, frames: parseSse(raw) }) }))
    }
    return response
  })
  await startHttp()
}, 30_000)

afterAll(async () => {
  scheduler?.stop()
  await Promise.allSettled(collection)
  await app?.close()
  closeDb()
  for (const db of databaseClients) db.close()
  await Promise.all(databaseClients.map(db => db.whenClosed()))
  await (await import('../../storage/memory/db.js')).closeMemoryDb()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); configureRequestAuthentication()
  const resolved = path.resolve(fixture)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-cron-plan-')) throw new Error('Unsafe cron plan fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function runScheduled(): Promise<void> {
  const initial = new Map(await Promise.all(jobs.map(async job => [sessionOf(job), (await rootRunStore.list(tenantId, sessionOf(job))).length] as const)))
  const count = collection.length
  // Each test asks for a distinct real occurrence; persistent claims deliberately reject replays.
  const at = Math.max(Math.floor(Date.now() / 60000) * 60000, ...jobs.map(job => (job.lastRunAt ?? 0) + 60000))
  for (const job of jobs) await getDb().execute({ sql: 'UPDATE cron_jobs SET next_run_at=? WHERE id=? AND tenant_id=?', args: [at, job.id, tenantId] })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 1)
  try { await scheduler.checkAndRun() } finally { clock.mockRestore() }
  jobs = await Promise.all(jobs.map(async job => (await cronStore.getById(job.id, tenantId))!))
  await vi.waitFor(async () => {
    for (const job of jobs) {
      const runs = await rootRunStore.list(tenantId, sessionOf(job))
      expect(runs).toHaveLength(initial.get(sessionOf(job))! + 1)
      expect(runs.at(-1)?.status).toBe('succeeded')
    }
  }, { timeout: 10_000, interval: 20 })
  expect(collection.length - count).toBe(2)
  await Promise.all(collection.slice(count))
}
function todoRows(frame: Record<string, unknown>): Array<{ sessionId: string; title: string; status: string }> | undefined {
  const value = frame.todo
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const todos = (value as Record<string, unknown>).todos
  return Array.isArray(todos) ? todos as Array<{ sessionId: string; title: string; status: string }> : undefined
}
function assertSilentStreams(selected: typeof streams): void {
  for (const stream of selected) {
    expect(stream.frames.some(frame => todoRows(frame) !== undefined)).toBe(true)
    expect(stream.frames.filter(frame => frame.toolStart || frame.toolEnd || frame.toolCall || frame.toolResult)).toEqual([])
    const ownTodos = stream.frames.flatMap(frame => { const rows = todoRows(frame); return rows ? [rows] : [] }).at(-1)!
    expect(ownTodos).toHaveLength(2)
    expect(ownTodos.every(todo => todo.sessionId === stream.sessionId && todo.status === 'done')).toBe(true)
  }
}

describe('automation uses the shared silent task plan service', () => {
  it('runs actual enabled cron jobs through chat and ReAct with session plans despite empty Agent tools and safe mode', async () => {
    await runScheduled()
    expect(streams).toHaveLength(2)
    assertSilentStreams(streams)
    for (const job of jobs) {
      const plan = await todoStore.getPlan(tenantId, sessionOf(job))
      expect(plan.plan).toHaveLength(2)
      expect(plan.plan.every(item => item.status === 'completed')).toBe(true)
      expect(plan.plan.map(item => item.step)).toEqual(sessionOf(job).endsWith('alpha') ? ['调查 alpha', '验证 alpha'] : ['调查 beta', '验证 beta'])
      expect((await cronStore.getById(job.id, tenantId))?.lastRunAt).toBeGreaterThan(0)
      const calls = requests.filter(call => call.session === sessionOf(job))
      expect(calls).toHaveLength(3)
      expect(calls[0].options?.systemPrompt).toContain('AUTOMATION_PLAN_PROFILE')
      expect(calls[0].options?.systemPrompt).toContain('内建任务计划')
      expect(calls[0].options?.tools?.map(tool => tool.name)).toEqual(['plan_update'])
      const history = new (await import('../../storage/conversation/history.js')).SQLiteConversationHistory()
      const receipts = (await history.getFullHistory({ tenantId, sessionId: sessionOf(job) })).filter(message => message.role === 'tool' && message.toolName === 'plan_update')
      expect(receipts).toHaveLength(2)
    }
    expect(new Set((await Promise.all(jobs.map(job => todoStore.getPlan(tenantId, sessionOf(job))))).flatMap(plan => plan.plan.map(item => item.id))).size).toBe(4)
  }, 20_000)

  it('reopens database and scheduler, then resumes each job with the same persisted plan ids', async () => {
    // A focused rerun of only this test must seed its own persisted baseline.
    if ((await todoStore.getPlan(tenantId, sessionOf(jobs[0]))).plan.length === 0) await runScheduled()
    const before = new Map(await Promise.all(jobs.map(async job => [sessionOf(job), await todoStore.getPlan(tenantId, sessionOf(job))] as const)))
    scheduler.stop(); await app.close()
    const prior = connect(); closeDb(); await prior.whenClosed(); connect(); await initDb()
    for (const job of jobs) expect(await todoStore.getPlan(tenantId, sessionOf(job))).toEqual(before.get(sessionOf(job)))
    await startHttp()
    const requestCount = requests.length, streamCount = streams.length
    await runScheduled()
    assertSilentStreams(streams.slice(streamCount))
    for (const job of jobs) {
      const plan = await todoStore.getPlan(tenantId, sessionOf(job))
      expect(plan.plan.map(item => item.id)).toEqual(before.get(sessionOf(job))!.plan.map(item => item.id))
      expect(await todoStore.list(tenantId, sessionOf(job))).toHaveLength(2)
      const resumed = requests.slice(requestCount).find(call => call.session === sessionOf(job))!
      expect(resumed.options?.systemPrompt).toContain(before.get(sessionOf(job))!.plan[0].id)
      expect(resumed.messages.some(message => message.role === 'tool' && message.toolName === 'plan_update')).toBe(true)
    }
    expect(await todoStore.list('another-tenant', sessionOf(jobs[0]))).toEqual([])
  }, 20_000)
})
