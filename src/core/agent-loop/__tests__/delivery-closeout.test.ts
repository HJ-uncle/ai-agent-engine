import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, ToolCall, ToolResult } from '../../agent-context/types.js'
import type { LLMAdapter, LLMAdapterOptions } from '../../llm-adapter/types.js'
import { DeliveryCloseout } from '../delivery-closeout.js'
import { ReActStrategy } from '../react.js'
import { deliverFilesTool } from '../../../tools/results/index.js'

const storage = vi.hoisted(() => ({ getPlan: vi.fn(), stalePaths: vi.fn(), stage: vi.fn() }))
vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class {
  getPlan = storage.getPlan
  list = async () => []
} }))
vi.mock('../../../storage/results/index.js', () => ({ finalResults: {
  stage: storage.stage, stalePaths: storage.stalePaths, prepare: async () => undefined, retainToolImages: async () => [],
}, TOOL_RESULT_IMAGE_ASSETS: '__aetherResultImageAssets' }))

const scope = { rootRunId: 'root', turnId: 'turn' }
const pendingPlan = { revision: 1, updatedAt: 1, plan: [{ id: 'delivery-step', step: 'Deliver verified files', status: 'in_progress' }] }
beforeEach(() => {
  storage.getPlan.mockReset().mockResolvedValue(pendingPlan)
  storage.stalePaths.mockReset().mockResolvedValue([])
  storage.stage.mockReset().mockResolvedValue([{ id: 'asset', path: 'report.docx' }])
})
function pair(name: string, args: Record<string, unknown>, id: string, success = true): Message[] {
  return [{ id: 'call:' + id, role: 'assistant', content: '', metadata: scope, toolCall: { name, args, id } },
    { id: 'result:' + id, role: 'tool', content: '', metadata: { ...scope, success, status: success ? 'succeeded' : 'failed' }, toolName: name, toolCallId: id }]
}
const delivery = { name: 'deliver_files', args: { items: [{ path: 'report.docx' }] }, id: 'deliver' }
const clear = { name: 'deliver_files', args: { items: [] }, id: 'clear' }
const plan = { name: 'plan_update', args: { plan: [{ id: 'delivery-step', step: 'Deliver verified files', status: 'completed' }] }, id: 'plan' }
function fixture(turns: Array<ToolCall[] | string>, options: { fail?: string; afterDelivery?: Message; history?: Message[]; rootRunId?: string } = {}) {
  const history: Message[] = [...(options.history ?? [])]
  const requests: LLMAdapterOptions[] = []
  const names = ['deliver_files', 'plan_update', 'office_document', 'execute_cmd']
  const definitions = names.map(name => ({ name, description: name, parameters: {} }))
  const execute = vi.fn(async (name: string): Promise<ToolResult> => ({ success: name !== options.fail, output: '{}' }))
  const ctx = {
    tenantId: 'tenant', sessionId: 'session', ...scope, ...(options.rootRunId ? { rootRunId: options.rootRunId } : {}), tokenBudget: 100_000,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    history: { append: vi.fn(async (message: Message) => { history.push(message); return message.id ?? 'saved' }),
      getHistory: vi.fn(async () => [...history]), getRawTokenCount: async () => 0 },
    tools: { list: () => definitions, has: () => true, executionMode: () => 'serial', execute },
    runObserver: { onOutcome: vi.fn(), onToolEnd: vi.fn(async ({ name }: { name: string }) => {
      if (name === 'deliver_files' && options.afterDelivery) history.push(options.afterDelivery)
    }) },
  } as unknown as AgentContext
  let index = 0
  const llm: LLMAdapter = { model: 'test', provider: 'test', complete: vi.fn(), countTokens: () => 0,
    stream: async function* (_messages, request) {
      requests.push(request!)
      const turn = turns[index++] ?? 'Final answer.'
      if (typeof turn === 'string') yield { done: true, content: turn }
      else yield { done: true, toolCalls: turn.map((call, i) => ({ ...call, args: JSON.stringify(call.args), index: i })) }
    } }
  return { ctx, execute, history, requests, async run() {
    const frames = []
    for await (const frame of new ReActStrategy(llm, { maxIterations: 6 }).run('Create the report.', ctx)) frames.push(frame)
    return frames
  } }
}
const offered = (request: LLMAdapterOptions) => request.tools?.map(tool => tool.name)

describe('bounded delivery closeout', () => {
  it('returns unresolved plan ids and closeout evidence without mutating plan status', async () => {
    const f = fixture([])
    const result = await deliverFilesTool.execute(delivery.args, f.ctx)
    const receipt = JSON.parse(result.output)
    expect(result.success).toBe(true)
    expect(receipt.pendingPlan).toEqual({ revision: 1, steps: pendingPlan.plan, omittedSteps: 0 })
    expect(receipt.note).toContain('登记步骤已有本回执证据')
    expect(receipt.note).toContain('先用items:[]撤销')
    expect(pendingPlan.plan[0].status).toBe('in_progress')
  })

  it('does not turn a saved-plan read failure into a failed file registration or an empty plan', async () => {
    storage.getPlan.mockRejectedValue(new Error('plan read unavailable'))
    const result = await deliverFilesTool.execute(delivery.args, fixture([]).ctx)
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output).pendingPlan).toEqual({ status: 'unavailable' })
  })
  it('offers one evidence-based plan update, then only a final answer without completing anything automatically', async () => {
    const f = fixture([[delivery], [plan], 'Delivered.'])
    await f.run()
    expect(offered(f.requests[1])).toEqual(['deliver_files', 'plan_update'])
    expect(offered(f.requests[2])).toEqual([])
    expect(f.requests[1].requestContext).toContain('Never mark unfinished work completed')
    expect(f.execute.mock.calls.map(call => call[0])).toEqual(['deliver_files', 'plan_update'])
    expect(storage.getPlan).toHaveBeenCalled()
    expect(pendingPlan.plan[0].status).toBe('in_progress')
    expect(f.ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' }))
  })

  it('a failed plan update still ends closeout, preserving the unresolved saved plan', async () => {
    const f = fixture([[delivery], [plan], 'Files delivered; the plan update failed.'], { fail: 'plan_update' })
    await f.run()
    expect(offered(f.requests[2])).toEqual([])
    expect(f.requests).toHaveLength(3)
    expect(pendingPlan.plan[0].status).toBe('in_progress')
  })

  it('blocks document editing after registration and does not repeatedly offer a closeout opportunity', async () => {
    const edit = { name: 'office_document', id: 'edit', args: { action: 'edit' } }
    const f = fixture([[delivery], [edit], [edit]])
    await f.run()
    expect(f.execute.mock.calls.map(call => call[0])).toEqual(['deliver_files'])
    expect(offered(f.requests[2])).toEqual([])
    expect(f.requests).toHaveLength(3)
    expect(f.ctx.runObserver?.onOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'DELIVERY_CLOSEOUT_UNRESOLVED' }) }))
  })

  it('blocks later editing and commands in the same batch as a successful registration', async () => {
    const edit = { name: 'office_document', id: 'edit', args: { action: 'edit' } }
    const command = { name: 'execute_cmd', id: 'command', args: { command: 'repair' } }
    const f = fixture([[delivery, edit, command], 'Delivered.'])
    await f.run()
    expect(f.execute.mock.calls.map(call => call[0])).toEqual(['deliver_files'])
    expect(f.history.filter(message => message.role === 'tool' && ['edit', 'command'].includes(message.toolCallId ?? '')).map(message => JSON.parse(String(message.content)).code))
      .toEqual(['FINAL_DELIVERY_CLOSEOUT', 'FINAL_DELIVERY_CLOSEOUT'])
  })

  it('successful withdrawal before a repair in the same batch permits the repair', async () => {
    const edit = { name: 'office_document', id: 'edit', args: { action: 'edit' } }
    const f = fixture([[delivery, clear, edit], 'Repair requires validation.'])
    await f.run()
    expect(f.execute.mock.calls.map(call => call[0])).toEqual(['deliver_files', 'deliver_files', 'office_document'])
    expect(offered(f.requests[1])).toContain('office_document')
  })

  it.each([false, true])('empty registration never enters closeout (failed=%s)', async failed => {
    const f = fixture([[clear], 'No delivery.'], { fail: failed ? 'deliver_files' : undefined })
    await f.run()
    expect(offered(f.requests[1])).toContain('office_document')
  })

  it('failed nonempty delivery never enters closeout', async () => {
    const f = fixture([[delivery], 'Delivery failed.'], { fail: 'deliver_files' })
    await f.run()
    expect(offered(f.requests[1])).toContain('office_document')
  })

  it('explicitly clearing the list reopens repair work', async () => {
    const f = fixture([[delivery], [clear], 'Repair needed.'])
    await f.run()
    expect(offered(f.requests[2])).toContain('office_document')
  })

  it('a new user instruction reopens work inside the same root', async () => {
    const f = fixture([[delivery], 'Revising.'], { afterDelivery: { id: 'steering', role: 'user', content: 'Change the title.', metadata: scope } })
    await f.run()
    expect(offered(f.requests[1])).toContain('office_document')
  })

  it('a later root does not inherit closeout from prior delivery', async () => {
    const f = fixture(['Revising.'], { rootRunId: 'new-root', history: pair(delivery.name, delivery.args, delivery.id) })
    await f.run()
    expect(offered(f.requests[0])).toContain('office_document')
  })

  it('changed staged sources reopen targeted validation and require registration again', async () => {
    storage.stalePaths.mockResolvedValue(['report.docx'])
    const f = fixture([[delivery], 'The delivery must be refreshed.'])
    await f.run()
    expect(offered(f.requests[1])).toContain('office_document')
    expect(f.requests[1].requestContext).toContain('staged final file list is stale')
  })

  it('failed withdrawal and repeated nonempty registration cannot renew closeout', () => {
    const closeout = new DeliveryCloseout()
    const history = [...pair(delivery.name, delivery.args, delivery.id), ...pair(clear.name, clear.args, clear.id, false)]
    closeout.observe(history, scope)
    expect(closeout.phase).toBe('answer')
    closeout.observe([...history, ...pair(delivery.name, delivery.args, 'again')], scope)
    expect(closeout.phase).toBe('answer')
  })

  it('restores current-root closeout but peer-agent mail cannot unlock it', () => {
    const closeout = new DeliveryCloseout()
    const history = [...pair(delivery.name, delivery.args, delivery.id), { id: 'peer', role: 'user' as const, content: 'Edit again.',
      metadata: { ...scope, collaborationDelivery: { version: 1, messageId: 'peer' } } }]
    closeout.observe(history, scope)
    expect(closeout.phase).toBe('reconcile')
    closeout.observe([...history, { id: 'user-steering', role: 'user', content: 'Revise it.',
      metadata: { ...scope, collaborationDelivery: { source: 'user-controller' } } }], scope)
    expect(closeout.phase).toBeUndefined()
  })
})
