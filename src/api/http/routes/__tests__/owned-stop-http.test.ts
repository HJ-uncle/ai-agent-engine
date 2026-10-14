/** Real buildServer/socket contracts: held SSE, initial discovery, and later manual-turn isolation. No provider calls. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, closeDb, getDb } from '../../../../storage/sqlite/db.js'
import { closeMemoryDb } from '../../../../storage/memory/db.js'
import { rootRunStore } from '../../../../storage/root-runs/index.js'
import { withHistoryLock } from '../../../../storage/conversation/serialization.js'
import { getExecutionOwners } from '../../../../core/collaboration/execution-owner.js'
import { ReActStrategy } from '../../../../core/agent-loop/index.js'
import { activeStreams } from '../../../../core/stream-pipeline/stream-bus.js'
import { buildServer } from '../../server.js'
import { stopOwnedSession } from '../chat.js'
import * as tools from '../../../../tools/registry-factory.js'
import { commandJobs } from '../../../../core/command-jobs/index.js'
import * as conversation from '../conversation.js'

const barrier = () => { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
let root: string, base: string, app: FastifyInstance | undefined
const holds: ReturnType<typeof barrier>[] = []
beforeEach(async () => {
  root = path.resolve('.e2e-tmp', 'owned-http-' + randomUUID()); fs.mkdirSync(root, { recursive: true })
  for (const [key, value] of Object.entries({ DATA_DIR: path.join(root, 'agent.db'), MEMORY_DB_PATH: path.join(root, 'memory.db'),
    KNOWLEDGE_DB_PATH: path.join(root, 'knowledge.db'), MCP_CONFIG_PATH: path.join(root, 'mcp.json'), AETHER_GLOBAL_DIR: path.join(root, 'global'),
    SKILLS_ROOT: path.join(root, 'skills'), WORKSPACE_ROOT: root, HISTORY_BACKEND: 'jsonl', ENABLE_LONG_TERM_MEMORY: 'false',
    AUTH_ENABLED: 'false', ENGINE_INSTANCE_TOKEN: '', LLM_PRIMARY_MODEL: 'fixture-model', OPENAI_API_KEY: 'fixture-key', QA_LOG_ENABLED: 'false' })) vi.stubEnv(key, value)
  fs.mkdirSync(path.join(root, 'skills'))
  await initDb()
  app = await buildServer(); base = await app.listen({ host: '127.0.0.1', port: 0 })
})
afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release()
  await app?.close()
  for (const [key, bus] of activeStreams) if (key.startsWith('default:owned-')) {
    if (bus.disconnectTimeout) clearTimeout(bus.disconnectTimeout)
    activeStreams.delete(key)
  }
  const receipts = await Promise.all([closeMemoryDb(), closeDb()])
  for (const receipt of receipts) if (receipt) expect(receipt.healthy, JSON.stringify(receipt)).toBe(true)
  vi.restoreAllMocks(); vi.unstubAllEnvs(); app = undefined
  if (!root.startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe owned HTTP fixture path')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
})
const hold = () => { const value = barrier(); holds.push(value); return value }
function chat(sessionId: string, inlineMcpServers: unknown[] = []) {
  return fetch(base + '/api/v1/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aether-tool-profile': 'general' },
    body: JSON.stringify({ message: 'Synthetic task', sessionId, model: 'fixture-model', memoryScope: 'off', workspacePaths: [root], inlineMcpServers }) })
}
function hungDiscovery() {
  const marker = path.join(root, 'owned-processes.json'), script = path.join(root, 'discovery.cjs')
  fs.writeFileSync(script, `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid}));process.stdin.resume();setInterval(()=>{},1000);`)
  return { marker, server: { id: 'hung-inline', name: 'hung-inline', transportType: 'stdio', command: process.execPath, args: [script], timeoutMs: 0 } }
}
async function ownedProcesses(marker: string): Promise<{ parent: number; child: number }> {
  await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 10_000 })
  return JSON.parse(fs.readFileSync(marker, 'utf8'))
}
async function command(sessionId: string, marker: string, runId?: string) {
  const launched = await commandJobs.start({ tenantId: 'default', sessionId, ownerSessionId: sessionId, runId, ownerRunId: runId,
    command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, marker))},String(process.pid));setInterval(()=>{},1000)`],
    cwd: root, env: { ...process.env }, background: true })
  await vi.waitFor(() => expect(fs.existsSync(path.join(root, marker))).toBe(true), { timeout: 10_000 })
  return { job: launched, pid: Number(fs.readFileSync(path.join(root, marker), 'utf8')) }
}
function holdCommandTerminalAck(jobId: string) {
  const entered = hold(), receipt = hold(), db = getDb(), batch = db.batch.bind(db)
  vi.spyOn(db, 'batch').mockImplementation(async (statements, mode) => {
    const result = await batch(statements, mode)
    if (statements.some(statement => typeof statement !== 'string' && !Array.isArray(statement) && Array.isArray(statement.args)
      && statement.args[2] === jobId && typeof statement.args[5] === 'string' && JSON.parse(statement.args[5]).status === 'cancelled')) {
      entered.release(); await receipt.promise
    }
    return result
  })
  return { entered, receipt }
}

describe('owned server stop HTTP boundary', () => {
  it('server.close aborts a real held SSE producer before waiting for its socket and joins the executor', async () => {
    const entered = hold(), aborted = hold(), executorDone = hold(); let signal!: AbortSignal
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_input, ctx) {
      signal = ctx.signal!; entered.release(); yield 'synthetic producer started'
      if (signal.aborted) aborted.release(); else signal.addEventListener('abort', aborted.release, { once: true })
      await aborted.promise; await executorDone.promise
      await ctx.runObserver?.onOutcome?.({ status: 'cancelled', stopReason: 'shutdown' })
    })
    const response = await chat('owned-held-sse'), body = response.text()
    await entered.promise; expect(signal.aborted).toBe(false)
    let closed = false
    const closing = app!.close().then(() => { closed = true })
    await aborted.promise
    expect(signal.aborted).toBe(true); expect(closed).toBe(false)
    expect(() => getExecutionOwners().reservePreparation(new AbortController())).toThrow('not accepting')
    executorDone.release(); await closing
    expect(await body).toContain('synthetic producer started')
    expect((await rootRunStore.list('default', 'owned-held-sse')).at(-1)?.status).toBe('cancelled')
    expect(app!.server.listening).toBe(false)
  }, 20_000)

  it('server.close joins actual initial MCP discovery and its owned process tree without a root or model dispatch', async () => {
    const discovery = hungDiscovery(), strategy = vi.spyOn(ReActStrategy.prototype, 'run')
    const response = chat('owned-discovery-shutdown', [discovery.server])
    const processes = await ownedProcesses(discovery.marker)
    await app!.close()
    expect((await response).status).toBe(499)
    await vi.waitFor(() => { expect(alive(processes.parent)).toBe(false); expect(alive(processes.child)).toBe(false) }, { timeout: 10_000 })
    expect(strategy).not.toHaveBeenCalled()
    expect(await rootRunStore.list('default', 'owned-discovery-shutdown')).toEqual([])
    expect(app!.server.listening).toBe(false)
  }, 30_000)

  it('a stop queued behind a held history lease does not capture a later manual preparation or durable root', async () => {
    const discovery = hungDiscovery(), sessionId = 'owned-later-manual'
    const old = chat(sessionId, [discovery.server]); const processes = await ownedProcesses(discovery.marker)
    const held = hold(), historyEntered = hold()
    const history = withHistoryLock('default', async () => { historyEntered.release(); await held.promise })
    await historyEntered.promise
    let stopped = false
    const stopping = stopOwnedSession('default', sessionId, 'Stop original request').then(result => { stopped = true; return result })
    const original = tools.createToolRegistry; let laterSignal: AbortSignal | undefined
    vi.spyOn(tools, 'createToolRegistry').mockImplementation(async options => { laterSignal = options?.signal; return original(options) })
    const producerEntered = hold(), producerDone = hold(); let producerSignal: AbortSignal | undefined
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_input, ctx) {
      producerSignal = ctx.signal; producerEntered.release(); yield 'later manual started'
      ctx.signal?.addEventListener('abort', producerDone.release, { once: true }); await producerDone.promise
      await ctx.runObserver?.onOutcome?.({ status: ctx.signal?.aborted ? 'cancelled' : 'succeeded', stopReason: 'completed' })
    })
    const next = chat(sessionId)
    await vi.waitFor(() => expect(laterSignal).toBeDefined(), { timeout: 10_000 })
    expect(laterSignal!.aborted).toBe(false); expect(stopped).toBe(false)
    held.release(); await history
    await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 10_000 })
    expect(await stopping).toBe(true); expect((await old).status).toBe(499)
    await producerEntered.promise
    expect(producerSignal!.aborted).toBe(false)
    expect((await rootRunStore.list('default', sessionId)).at(-1)?.status).toBe('running')
    expect(alive(processes.parent)).toBe(false); expect(alive(processes.child)).toBe(false)
    producerDone.release(); expect(await (await next).text()).toContain('later manual started')
    expect((await rootRunStore.list('default', sessionId)).at(-1)?.status).toBe('succeeded')
  }, 30_000)

  it('the real session cancel endpoint freezes old discovery and rootless commands before its first await, leaving a later manual turn intact', async () => {
    const sessionId = 'owned-endpoint-later-manual', discovery = hungDiscovery()
    const old = chat(sessionId, [discovery.server]); const processes = await ownedProcesses(discovery.marker)
    const priorCommand = await command(sessionId, 'old-command.pid'), ack = holdCommandTerminalAck(priorCommand.job.jobId)
    const held = hold(), historyEntered = hold()
    const history = withHistoryLock('default', async () => { historyEntered.release(); await held.promise })
    await historyEntered.promise
    let cancelled = false
    const cancelling = fetch(base + '/api/v1/chat/cancel', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }) }).then(async response => { cancelled = true; return { status: response.status, body: await response.json() } })
    await ack.entered.promise
    await vi.waitFor(() => { expect(alive(processes.parent)).toBe(false); expect(alive(processes.child)).toBe(false) }, { timeout: 10_000 })
    expect(cancelled).toBe(false); expect(alive(priorCommand.pid)).toBe(false)
    const original = tools.createToolRegistry; let laterSignal: AbortSignal | undefined
    vi.spyOn(tools, 'createToolRegistry').mockImplementation(async options => { laterSignal = options?.signal; return original(options) })
    const entered = hold(), finished = hold(); let producerSignal: AbortSignal | undefined
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_input, ctx) {
      producerSignal = ctx.signal; entered.release(); yield 'later endpoint manual'
      ctx.signal?.addEventListener('abort', finished.release, { once: true }); await finished.promise
      await ctx.runObserver?.onOutcome?.({ status: ctx.signal?.aborted ? 'cancelled' : 'succeeded' })
    })
    const next = chat(sessionId), laterCommand = await command(sessionId, 'later-command.pid')
    await vi.waitFor(() => expect(laterSignal).toBeDefined(), { timeout: 10_000 })
    expect(laterSignal!.aborted).toBe(false); expect(alive(laterCommand.pid)).toBe(true)
    held.release(); await history; await entered.promise
    expect(cancelled).toBe(false); expect(producerSignal!.aborted).toBe(false)
    ack.receipt.release()
    expect(await cancelling).toMatchObject({ status: 200, body: { data: { cancelled: true, settled: true } } })
    expect((await old).status).toBe(499)
    expect((await commandJobs.get({ tenantId: 'default', sessionId }, priorCommand.job.jobId))?.status).toBe('cancelled')
    expect((await commandJobs.get({ tenantId: 'default', sessionId }, laterCommand.job.jobId))?.status).toBe('running')
    expect(alive(laterCommand.pid)).toBe(true); expect(producerSignal!.aborted).toBe(false)
    finished.release(); expect(await (await next).text()).toContain('later endpoint manual')
    expect((await rootRunStore.list('default', sessionId)).at(-1)?.status).toBe('succeeded')
    await commandJobs.cancel({ tenantId: 'default', sessionId }, laterCommand.job.jobId, 'Fixture finished')
  }, 40_000)

  it('a real root cancel accepts the exact durable cancelled receipt after the producer releases its owner during a held command ACK', async () => {
    const sessionId = 'owned-released-cancel', entered = hold(), abort = hold()
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_input, ctx) {
      entered.release(); yield 'owned release race'
      if (ctx.signal!.aborted) abort.release(); else ctx.signal!.addEventListener('abort', abort.release, { once: true })
      await abort.promise
      await ctx.runObserver?.onOutcome?.({ status: 'succeeded' })
    })
    const response = await chat(sessionId), body = response.text(); await entered.promise
    const run = (await rootRunStore.list('default', sessionId)).at(-1)!, stored = (await rootRunStore.get('default', run.runId))!
    const service = getExecutionOwners(), owner = service.find('default', run.runId, stored.attemptId)!
    const ownerRecord = service.record(owner), db = getDb()
    const priorCommand = await command(sessionId, 'released-command.pid', run.runId), ack = holdCommandTerminalAck(priorCommand.job.jobId)
    let cancelled = false
    const cancelling = fetch(base + '/api/v1/chat/cancel', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, runId: run.runId }) }).then(async value => { cancelled = true; return { status: value.status, body: await value.json() } })
    await ack.entered.promise; await body
    await vi.waitFor(() => expect(service.find('default', run.runId, stored.attemptId)).toBeUndefined(), { timeout: 10_000 })
    expect(() => service.record(owner)).toThrow('A live root capability is required')
    expect(cancelled).toBe(false); expect(alive(priorCommand.pid)).toBe(false)
    expect((await rootRunStore.get('default', run.runId))?.status).toBe('cancelled')
    ack.receipt.release()
    expect(await cancelling).toMatchObject({ status: 200, body: { data: { cancelled: true, settled: true } } })
    expect((await rootRunStore.get('default', run.runId))?.attemptId).toBe(stored.attemptId)
    await expect(rootRunStore.terminalReceipt({ ...ownerRecord.binding, generation: 'wrong-generation' }, db, ownerRecord.epoch)).rejects.toThrow('RECEIPT_UNKNOWN')
    await expect(rootRunStore.terminalReceipt({ ...ownerRecord.binding, rootAttemptId: 'wrong-attempt' }, db, ownerRecord.epoch)).rejects.toThrow('RECEIPT_MISSING')
    await expect(rootRunStore.terminalReceipt(ownerRecord.binding, db, ownerRecord.epoch + 1)).rejects.toThrow('DATASOURCE_MISMATCH')
    const saved = (await db.execute({ sql: 'SELECT state FROM root_runs WHERE tenant_id=? AND run_id=?', args: ['default', run.runId] })).rows[0].state
    const laterState = { ...JSON.parse(String(saved)), attemptId: 'later-manual-attempt' }
    await db.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [JSON.stringify(laterState), 'default', run.runId] })
    try {
      // A surviving old collaboration close cannot certify the latest attempt.
      await expect(rootRunStore.terminalReceipt(ownerRecord.binding, db, ownerRecord.epoch)).rejects.toThrow('RECEIPT_UNKNOWN')
    } finally {
      await db.execute({ sql: 'UPDATE root_runs SET state=? WHERE tenant_id=? AND run_id=?', args: [saved, 'default', run.runId] })
    }
  }, 30_000)

  it('server.close stops and joins terminal maintenance while another real HTTP root is running without rewriting business success', async () => {
    const maintenanceEntered = hold(), maintenanceDone = hold(), otherEntered = hold(), otherDone = hold()
    let maintenanceSignal: AbortSignal | undefined, otherSignal: AbortSignal | undefined
    vi.spyOn(conversation, 'autoCompactSession').mockImplementation(async (_tenant, _session, _logger, _parent, options) => {
      maintenanceSignal = options?.signal; maintenanceEntered.release()
      await maintenanceDone.promise
      return undefined
    })
    vi.spyOn(ReActStrategy.prototype, 'run').mockImplementation(async function* (_input, ctx) {
      if (ctx.sessionId === 'owned-terminal-maintenance') {
        yield '\x00__usage__' + JSON.stringify({ currentPromptTokens: 999_999_999 })
        await ctx.runObserver?.onOutcome?.({ status: 'succeeded', stopReason: 'completed' })
        yield 'successful task before maintenance'
      } else {
        otherSignal = ctx.signal; otherEntered.release(); yield 'other independent root'
        await otherDone.promise
        await ctx.runObserver?.onOutcome?.({ status: ctx.signal?.aborted ? 'cancelled' : 'succeeded' })
      }
    })
    const successful = await chat('owned-terminal-maintenance'), successBody = successful.text()
    await maintenanceEntered.promise
    const terminal = (await rootRunStore.list('default', 'owned-terminal-maintenance')).at(-1)!
    const stored = (await rootRunStore.get('default', terminal.runId))!, service = getExecutionOwners()
    const owner = service.find('default', terminal.runId, stored.attemptId)!
    expect(service.record(owner).phase).toBe('closed'); expect(terminal.status).toBe('succeeded')
    expect(maintenanceSignal?.aborted).toBe(false)
    const other = await chat('owned-maintenance-other'), otherBody = other.text(); await otherEntered.promise
    let closed = false
    const closing = app!.close().then(() => { closed = true })
    await vi.waitFor(() => { expect(maintenanceSignal?.aborted).toBe(true); expect(otherSignal?.aborted).toBe(true) }, { timeout: 3_000 })
    expect(closed).toBe(false)
    otherDone.release(); expect(await otherBody).toContain('other independent root')
    expect((await rootRunStore.list('default', 'owned-maintenance-other')).at(-1)?.status).toBe('cancelled')
    expect(closed).toBe(false)
    expect((await rootRunStore.get('default', terminal.runId))?.status).toBe('succeeded')
    maintenanceDone.release(); await closing
    expect(await successBody).toContain('successful task before maintenance')
    expect((await rootRunStore.get('default', terminal.runId))?.status).toBe('succeeded')
    expect(service.find('default', terminal.runId, stored.attemptId)).toBeUndefined()
  }, 25_000)
})
