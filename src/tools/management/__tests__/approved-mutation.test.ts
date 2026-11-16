import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../../core/agent-context/index.js'
import { ToolRegistry } from '../../../core/tool-registry/registry.js'
import { executeToolBatch } from '../../../core/agent-loop/tool-batch.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { createApprovedMutationTool } from '../approved-mutation.js'

const raw = { name: 'Example' }
const context = () => ({ tenantId: 'default', sessionId: 'management-test', currentToolCallId: 'call-1' }) as AgentContext
beforeEach(() => { vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard') })
afterEach(() => {
  clearSecurityMode('default', 'management-test')
  clearSecurityMode('default', 'management-other')
  vi.unstubAllEnvs()
})
function approved(waiting: ToolResult, signal: AbortSignal): AgentContext {
  return { ...context(), signal, approvedToolCallId: 'call-1', resumeToolCall: {
    toolCall: { id: 'call-1', name: 'test_mutation', args: raw }, decision: 'approved',
    pendingAction: JSON.parse(JSON.stringify(waiting.pendingAction)),
  } }
}
function fixture() {
  const apply = vi.fn(async (): Promise<ToolResult> => ({ success: true, status: 'succeeded', output: 'written' }))
  const prepare = vi.fn(async (_raw: unknown, ctx: AgentContext) => ({ version: 1 as const, tenantId: ctx.tenantId }))
  const tool = createApprovedMutationTool({ name: 'test_mutation', displayName: 'Test', description: 'Test mutation',
    parameters: { type: 'object', properties: {} }, prepare, apply })
  return { tool, apply, prepare }
}

describe('Approved management mutation cancellation', () => {
  it('does not apply when a stop arrives between approval preflight and execution', async () => {
    const { tool, apply } = fixture()
    const waiting = await tool.execute(raw, context())
    const controller = new AbortController()
    const execution = tool.execute(raw, approved(waiting, controller.signal))
    controller.abort(new DOMException('User stopped', 'AbortError'))
    expect(await execution).toMatchObject({ success: false, status: 'cancelled', output: 'User stopped' })
    expect(apply).not.toHaveBeenCalled()
  })

  it('does not park a new approval after cancellation during preparation', async () => {
    const { tool, prepare, apply } = fixture()
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    prepare.mockImplementation(async () => { entered(); await held; return { version: 1, tenantId: 'default' } })
    const controller = new AbortController()
    const execution = tool.execute(raw, { ...context(), signal: controller.signal })
    await preparing
    controller.abort(new DOMException('User stopped', 'AbortError')); release()
    const result = await execution
    expect(result).toMatchObject({ success: false, status: 'cancelled' })
    expect(result.pendingAction).toBeUndefined()
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('Session full-access management approvals', () => {
  it('runs successive mutations through the real registry and batch without pending confirmations', async () => {
    const { tool, apply, prepare } = fixture()
    const registry = new ToolRegistry()
    registry.register(tool)
    const ctx = { ...context(), tools: registry }
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
    const batch = await executeToolBatch(['first', 'second'].map(id => ({
      call: { id, name: tool.name, args: raw }, messageId: 'message',
    })), ctx, new Set([tool.name]))
    expect(batch.pending).toBeUndefined()
    expect(batch.results.map(result => result.status)).toEqual(['succeeded', 'succeeded'])
    expect(apply).toHaveBeenCalledTimes(2)
    expect(prepare).toHaveBeenCalled()
    expect(apply).toHaveBeenCalledWith({ version: 1, tenantId: ctx.tenantId }, expect.objectContaining({ sessionId: ctx.sessionId }), raw)
  })

  it('scopes the grant by tenant and root conversation and responds to revocation immediately', async () => {
    vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard')
    const { tool, apply } = fixture()
    const ctx = context()
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
    expect(await tool.execute(raw, ctx)).toMatchObject({ success: true })
    const child = { ...ctx, sessionId: 'management-child', rootSessionId: ctx.sessionId, parentSessionId: ctx.sessionId }
    expect(await tool.execute(raw, child)).toMatchObject({ success: true })
    expect(await tool.execute(raw, { ...ctx, sessionId: 'management-other' })).toMatchObject({ status: 'waiting' })
    expect(await tool.execute(raw, { ...ctx, tenantId: 'another-tenant' })).toMatchObject({ status: 'waiting' })
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
    expect(await tool.execute(raw, ctx)).toMatchObject({ status: 'waiting' })
    expect(await tool.execute(raw, child)).toMatchObject({ status: 'waiting' })
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('keeps a real question pending and performs no sibling mutations', async () => {
    const { tool, apply } = fixture()
    const registry = new ToolRegistry()
    registry.register(tool)
    const answer = vi.fn(async (): Promise<ToolResult> => ({ success: true, output: 'should not answer' }))
    registry.register({ name: 'ask_user', description: 'Ask', parameters: { type: 'object' }, execute: answer })
    const ctx = { ...context(), tools: registry }
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
    const batch = await executeToolBatch([
      { call: { id: 'first', name: tool.name, args: raw }, messageId: 'message' },
      { call: { id: 'question', name: 'ask_user', args: { question: 'Which format?', options: ['PDF', 'HTML'] } }, messageId: 'message' },
    ], ctx)
    expect(batch.pending).toMatchObject({ requestId: 'question', kind: 'ask', options: ['PDF', 'HTML'] })
    expect(batch.results[0].status).toBe('interrupted')
    expect(apply).not.toHaveBeenCalled()
    expect(answer).not.toHaveBeenCalled()
  })

  it('retains the exact frozen operation when the user enables full access while approving a pending call', async () => {
    const { tool, prepare, apply } = fixture()
    const waiting = await tool.execute(raw, context())
    const saved = structuredClone(waiting.pendingAction!.operation)
    setSecurityMode('default', 'management-test', 'full-access')
    prepare.mockRejectedValue(new Error('A resumed call must not prepare a different operation'))
    expect(await tool.execute(raw, approved(waiting, new AbortController().signal))).toMatchObject({ success: true })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(saved, expect.anything(), raw)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('rechecks the mode after an asynchronous prepare and after an earlier successful preflight', async () => {
    const { tool, prepare, apply } = fixture()
    const ctx = context()
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
    expect(await tool.preflight!(raw, ctx)).toBeUndefined()
    prepare.mockImplementation(async () => {
      setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
      return { version: 1, tenantId: ctx.tenantId }
    })
    expect(await tool.execute(raw, ctx)).toMatchObject({ status: 'waiting', needsConfirmation: true })
    expect(apply).not.toHaveBeenCalled()
  })

  it('still fails preparation, foreign operations, apply conflicts and cancelled execution', async () => {
    const { tool, prepare, apply } = fixture()
    const ctx = context()
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
    prepare.mockRejectedValueOnce(new Error('role denied'))
    expect(await tool.execute(raw, ctx)).toMatchObject({ success: false, status: 'failed', output: 'role denied' })
    prepare.mockResolvedValueOnce({ version: 1, tenantId: 'another-tenant' })
    expect(await tool.execute(raw, ctx)).toMatchObject({ success: false, status: 'failed', output: '操作租户不匹配' })
    expect(apply).not.toHaveBeenCalled()
    apply.mockRejectedValueOnce(new Error('revision changed'))
    expect(await tool.execute(raw, ctx)).toMatchObject({ success: false, status: 'failed', output: 'revision changed' })
    const controller = new AbortController()
    const execution = tool.execute(raw, { ...ctx, signal: controller.signal })
    controller.abort(new DOMException('User stopped', 'AbortError'))
    expect(await execution).toMatchObject({ success: false, status: 'cancelled' })
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
