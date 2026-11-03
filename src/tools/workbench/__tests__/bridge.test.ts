import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { WorkbenchBridge, WorkbenchBridgeError } from '../bridge.js'
import { workbenchRoutes } from '../../../api/http/routes/workbench.js'
import type { AuthContext } from '../../../auth/types.js'
import { pino } from 'pino'
import { ToolRegistry } from '../../../core/tool-registry/registry.js'

const bridges: WorkbenchBridge[] = []
const identity = { tenantId: 'tenant', userId: 'user' }
const context = (signal?: AbortSignal, rootRunId = 'run-a'): AgentContext => ({ tenantId: 'tenant', sessionId: 'chat', rootRunId,
  browserPrincipal: { ...identity, method: 'jwt' }, signal, workspaceDir: process.cwd(),
  tools: new ToolRegistry(), history: {} as AgentContext['history'], logger: pino({ level: 'silent' }) })
const create = () => { const bridge = new WorkbenchBridge({ leaseMs: 1000, pollMs: 5, commandMs: 1000 }); bridges.push(bridge); return bridge }
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose() })

describe('workbench execution receipts', () => {
  it('requires a client receipt and exact run identity before completing an open', async () => {
    const bridge = create(), client = bridge.register(identity, 'chat', ['artifact.open'])
    const pending = bridge.execute('artifact.open', { path: 'file.docx' }, context())
    const [command] = await bridge.poll(identity, client.clientId, client.clientToken)
    expect(command.execution).toEqual({ rootSessionId: 'chat', rootRunId: 'run-a', ownerRunId: 'run-a' })
    expect(bridge.result(identity, client.clientId, client.clientToken, command.requestId, { ...command.execution, rootRunId: 'other' }, { success: true, output: 'wrong' })).toBe(false)
    expect(bridge.result(identity, client.clientId, client.clientToken, command.requestId, command.execution, { success: true, output: 'opened', metadata: { operationPerformed: true } })).toBe(true)
    expect(await pending).toMatchObject({ success: true, output: 'opened' })
  })
  it('rejects another user, token and session without exposing commands', async () => {
    const bridge = create(), client = bridge.register(identity, 'chat', ['workspace.context'])
    await expect(bridge.poll({ ...identity, userId: 'other' }, client.clientId, client.clientToken)).rejects.toBeInstanceOf(WorkbenchBridgeError)
    await expect(bridge.poll(identity, client.clientId, 'x'.repeat(43))).rejects.toBeInstanceOf(WorkbenchBridgeError)
    expect(await bridge.execute('workspace.context', {}, { ...context(), sessionId: 'other' })).toMatchObject({ success: false, metadata: { code: 'WORKBENCH_UNAVAILABLE' } })
  })
  it('cancellation before delivery removes the action instead of replaying it later', async () => {
    const bridge = create(), client = bridge.register(identity, 'chat', ['artifact.open']), controller = new AbortController()
    const pending = bridge.execute('artifact.open', {}, context(controller.signal)); controller.abort()
    expect(await pending).toMatchObject({ success: false, metadata: { operationPerformed: false } })
    expect(await bridge.poll(identity, client.clientId, client.clientToken)).toEqual([])
  })
  it('delivered cancellation reports uncertainty and rejects a late success', async () => {
    const bridge = create(), client = bridge.register(identity, 'chat', ['artifact.open']), controller = new AbortController()
    const pending = bridge.execute('artifact.open', {}, context(controller.signal))
    const [command] = await bridge.poll(identity, client.clientId, client.clientToken); controller.abort()
    expect(await pending).toMatchObject({ metadata: { operationPerformed: 'unknown' } })
    expect(bridge.active(identity, client.clientId, client.clientToken, command.requestId, command.execution)).toBe(false)
    expect(bridge.result(identity, client.clientId, client.clientToken, command.requestId, command.execution, { success: true, output: 'late' })).toBe(false)
  })
  it('settles pending work on disconnect and advertises real supported actions only', async () => {
    const bridge = create(), client = bridge.register(identity, 'chat', ['workspace.context'])
    expect(bridge.status(context())).toEqual({ connected: true, actions: ['workspace.context'] })
    expect(await bridge.execute('artifact.open', {}, context())).toMatchObject({ metadata: { code: 'WORKBENCH_UNSUPPORTED' } })
    const pending = bridge.execute('workspace.context', {}, context())
    bridge.unregister(identity, client.clientId, client.clientToken)
    expect(await pending).toMatchObject({ metadata: { operationPerformed: false } })
    expect(bridge.status(context()).connected).toBe(false)
  })
  it('HTTP preserves exact result booleans and validates run identity', async () => {
    const bridge = create(), app = Fastify()
    app.addHook('onRequest', async request => {
      ;(request as FastifyRequest & { authContext?: Partial<AuthContext> }).authContext = identity
    })
    await app.register(workbenchRoutes, { bridge })
    try {
      const registered = await app.inject({ method: 'POST', url: '/workbench/clients', payload: { sessionId: 'chat', actions: ['workspace.context'] } })
      expect(registered.headers['cache-control']).toBe('no-store')
      const client = registered.json().data
      const pending = bridge.execute('workspace.context', {}, context())
      const polled = await app.inject({ method: 'POST', url: `/workbench/clients/${client.clientId}/poll`, payload: { clientToken: client.clientToken } })
      const [command] = polled.json().data.commands
      const body = { clientToken: client.clientToken, requestId: command.requestId, execution: command.execution,
        result: { success: true, output: '{}', metadata: { code: 'WORKBENCH_COMPLETED', operationPerformed: 'true' } } }
      expect((await app.inject({ method: 'POST', url: `/workbench/clients/${client.clientId}/results`, payload: body })).statusCode).toBe(400)
      const accepted = await app.inject({ method: 'POST', url: `/workbench/clients/${client.clientId}/results`, payload: { ...body, result: { ...body.result, metadata: { ...body.result.metadata, operationPerformed: true } } } })
      expect(accepted.json().data.accepted).toBe(true)
      expect((await pending).success).toBe(true)
    } finally { await app.close() }
  })
})
