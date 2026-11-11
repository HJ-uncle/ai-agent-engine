import { describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../../core/agent-context/index.js'
import { createApprovedMutationTool } from '../approved-mutation.js'

const raw = { name: 'Example' }
const context = () => ({ tenantId: 'default', sessionId: 'management-test', currentToolCallId: 'call-1' }) as AgentContext
function approved(waiting: ToolResult, signal: AbortSignal): AgentContext {
  return { ...context(), signal, approvedToolCallId: 'call-1', resumeToolCall: {
    toolCall: { id: 'call-1', name: 'test_mutation', args: raw }, decision: 'approved',
    pendingAction: JSON.parse(JSON.stringify(waiting.pendingAction)),
  } }
}
function fixture() {
  const apply = vi.fn(async (): Promise<ToolResult> => ({ success: true, status: 'succeeded', output: 'written' }))
  const prepare = vi.fn(async () => ({ version: 1 as const, tenantId: 'default' }))
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
