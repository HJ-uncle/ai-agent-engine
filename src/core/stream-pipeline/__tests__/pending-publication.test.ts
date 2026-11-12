import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, type Client } from '@libsql/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Pending } from '../../agent-context/types.js'
import { publicPending, pendingWireFrames } from '../public-pending.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { StreamBus, busToIterable } from '../stream-bus.js'
import { sseStream } from '../sse-sink.js'
import { PluginService } from '../../../plugins/service.js'
import { createPluginManagementTools } from '../../../plugins/management-tools.js'
import { runPlugin } from '../../../plugins/runtime.js'

const scratch = path.resolve('.e2e-tmp/pending-publication-tests')
let root: string | undefined, db: Client | undefined, app: FastifyInstance | undefined, bus: StreamBus | undefined
function removeOwned(directory: string): void {
  if (!root || (directory !== root && !directory.startsWith(root + path.sep)) || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe publication test cleanup')
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing linked publication test cleanup')
    if (entry.isDirectory()) removeOwned(file); else fs.unlinkSync(file)
  }
  if (fs.readdirSync(directory).length) throw new Error('Publication fixture no longer empty')
  fs.rmdirSync(directory)
}
afterEach(async () => {
  if (bus && !bus.finished) await bus.endOrdered()
  await app?.close(); db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (root) { if (path.dirname(root) !== scratch) throw new Error('Unsafe publication fixture root'); removeOwned(root) }
  if (fs.existsSync(scratch) && !fs.lstatSync(scratch).isSymbolicLink() && fs.readdirSync(scratch).length === 0) fs.rmdirSync(scratch)
  root = undefined; db = undefined; app = undefined; bus = undefined
})
const permission = (change: Partial<Pending> = {}): Pending => ({ requestId: 'approval', toolCallId: 'tool', toolName: 'execute_cmd', messageId: 'message',
  kind: 'permission', args: { command: 'node', args: ['--version'] }, question: 'Run this exact command?', options: ['approved', 'rejected'],
  pendingAction: { type: 'command', operation: { private: 'sealed body' } }, status: 'pending', ...change })

describe('public pending display versus private approval authority', () => {
  it('preserves ordinary questions, multiple question groups, answers, IDs and small command arguments', () => {
    const ask = permission({ kind: 'ask', toolName: 'ask_user', args: { questions: [{ question: '完整问题🙂'.repeat(3000), options: [{ label: '一', description: '详情' }], multiSelect: true }] },
      question: '原始问题', status: 'answered', output: '用户的完整回答'.repeat(1000), pendingAction: undefined })
    const { pendingAction: _private, ...expected } = ask
    expect(publicPending(ask)).toEqual(expected)
    expect(publicPending(permission())).toEqual({ ...permission(), pendingAction: undefined })
    expect(Object.hasOwn(publicPending(permission()), 'pendingAction')).toBe(false)
    const wire = pendingWireFrames(permission(), { sessionId: 'session' })
    expect(wire.join('')).not.toContain('sealed body')
    expect(JSON.parse(wire[0].slice('\x00__ask_user__'.length))).not.toHaveProperty('command')
    expect(JSON.parse(wire[1].slice('\x00__permission_request__'.length)).args).toEqual(permission().args)
  })

  it('labels UTF-8 bounded legacy permission summaries without mutating any sealed input', () => {
    const body = '原始源码🙂'.repeat(30000)
    const pending = permission({ args: { id: 'plugin-id', expectedRevision: 3, files: { 'main.mjs': body } }, question: '确认\n' + body,
      pendingAction: { type: 'plugin_update', operation: { input: { files: { 'main.mjs': body } } } }, status: 'answered', output: 'approved' })
    const before = JSON.stringify(pending), display = publicPending(pending)
    expect(JSON.stringify(pending)).toBe(before)
    expect(display).toMatchObject({ requestId: 'approval', toolCallId: 'tool', messageId: 'message', status: 'answered', output: 'approved',
      args: { id: 'plugin-id', expectedRevision: 3 }, displaySummary: { source: 'durable_approval', fields: ['args', 'question'] } })
    expect(Buffer.byteLength(JSON.stringify(display.args))).toBeLessThanOrEqual(2048)
    expect(Buffer.byteLength(display.question!)).toBeLessThanOrEqual(1024)
    expect(display.question).not.toContain('\ufffd')
    expect(display.question).toContain('展示摘要')
    expect(display).not.toHaveProperty('pendingAction')
  })

  it('publishes eight real merge approvals over SSE while durable sealed sources exceed 1 MiB and resume unchanged', async () => {
    fs.mkdirSync(scratch, { recursive: true }); root = fs.mkdtempSync(path.join(scratch, 'run-'))
    vi.stubEnv('AUTH_ENABLED', 'false')
    db = createClient({ url: 'file:' + path.join(root, 'run.db').replace(/\\/g, '/') })
    let store = new RootRunStore(() => db!)
    let plugins = new PluginService(path.join(root, 'plugins'))
    const manifest = { apiVersion: 1 as const, id: 'publication-fixture', name: 'Publication fixture', version: '1.0.0', description: 'Large approved source edits', runtime: 'node' as const,
      tools: [{ name: 'answer', description: 'Return an approved revision value', entry: 'main.mjs', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
    const initial = await plugins.create('default', { manifest, files: { 'main.mjs': 'console.log(JSON.stringify({result:0}))\n', 'README.md': 'Retained original file' } })
    const run = await store.create('default', 'publication-session', 'fixture-model', [root], {})
    bus = new StreamBus(new AbortController())
    app = Fastify()
    let connected!: () => void; const connection = new Promise<void>(resolve => { connected = resolve })
    app.get('/events', async (_request, reply) => { connected(); await sseStream(busToIterable(bus!), reply) })
    const url = await app.listen({ host: '127.0.0.1', port: 0 })
    const receiving = fetch(url + '/events', { signal: AbortSignal.timeout(20000) }).then(response => response.text())
    await connection
    const publish = async (value: unknown) => { const frame = '\x00__run__' + JSON.stringify(value); expect(Buffer.byteLength(frame)).toBeLessThan(128 * 1024); await bus!.publish(frame) }
    await publish(run)
    for (let iteration = 1; iteration <= 8; iteration++) {
      const tool = createPluginManagementTools(plugins).find(item => item.name === 'plugin_update')!
      const code = 'console.log(JSON.stringify({result:' + iteration + '}))\n// SEALED_SOURCE_' + iteration + ' ' + 'large retained source '.repeat(5000)
      const args = { id: initial.id, expectedRevision: iteration, fileMode: 'merge', files: { 'main.mjs': code } }
      const context = { tenantId: 'default', sessionId: run.sessionId, currentToolCallId: 'call-' + iteration } as AgentContext
      const prepared = await tool.preflight!(args, context)
      expect(prepared?.needsConfirmation, prepared?.output).toBe(true)
      const pending = permission({ requestId: context.currentToolCallId!, toolCallId: context.currentToolCallId!, toolName: tool.name, args,
        pendingAction: prepared!.pendingAction, question: prepared!.pendingAction?.reason as string })
      const waiting = await store.pending('default', run.runId, pending)
      await publish(waiting)
      for (const frame of pendingWireFrames(pending, { sessionId: run.sessionId, rootRunId: run.runId, turnId: run.turnId })) await bus.publish(frame)
      // Close/reopen SQLite and run startup recovery while waiting. Resumption
      // must use durable authority, never SSE data or an in-memory candidate.
      db.close(); db = createClient({ url: 'file:' + path.join(root, 'run.db').replace(/\\/g, '/') })
      store = new RootRunStore(() => db!); await store.initialize()
      plugins = new PluginService(path.join(root, 'plugins'))
      const accepted = await store.answer('default', run.sessionId, run.runId, pending.requestId, pending.toolCallId, tool.name, 'approved')
      expect(accepted.pending.args).toEqual(args)
      expect(accepted.pending.pendingAction).toEqual(prepared!.pendingAction)
      expect(accepted.run.pending).toHaveLength(iteration)
      expect(accepted.run.pending.every(item => item.status === 'answered' && item.output === 'approved' && !item.pendingAction)).toBe(true)
      await publish(accepted.run)
      const resumedContext = { ...context, approvedToolCallId: pending.toolCallId, resumeToolCall: {
        toolCall: { id: pending.toolCallId, name: tool.name, args: accepted.pending.args }, decision: 'approved' as const, pendingAction: accepted.pending.pendingAction } }
      const result = await createPluginManagementTools(plugins).find(item => item.name === tool.name)!.execute(accepted.pending.args, resumedContext)
      expect(result.success, result.output).toBe(true)
      expect((await plugins.get('default', initial.id)).files).toMatchObject({ 'main.mjs': code, 'README.md': 'Retained original file' })
    }
    const durable = (await store.get('default', run.runId))!
    expect(Buffer.byteLength(JSON.stringify(durable))).toBeGreaterThan(1024 * 1024)
    expect(durable.pending).toHaveLength(8)
    const terminal = await store.update('default', run.runId, { status: 'succeeded' })
    await publish(terminal); await bus.endOrdered()
    const sse = await receiving
    expect(sse).toContain('event: done'); expect(sse).not.toContain('publication_recovery_required')
    expect(sse).not.toContain('SEALED_SOURCE_'); expect(sse).not.toContain('pendingAction')
    const envelopes = sse.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
    expect(envelopes.filter(item => item.run).at(-1).run).toMatchObject({ runId: run.runId, status: 'succeeded' })
    expect(envelopes.filter(item => item.permissionRequest)).toHaveLength(8)
    expect(bus.snapshot().publicationRecovery).toBeUndefined()
    const executed = await runPlugin(await plugins.snapshot('default', initial.id, 9, { allowDraft: true }), 'answer', {})
    expect(executed.result).toBe(8)
  }, 30000)
})
