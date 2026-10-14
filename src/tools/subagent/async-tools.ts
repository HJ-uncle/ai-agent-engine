import { createHash } from 'node:crypto'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/types.js'
import { serviceForOwner } from '../../core/collaboration/execution-owner.js'
import { getSubagentRunner, type SubagentWait } from '../../core/subagent/runner.js'
import { outcomeText } from '../../core/subagent/types.js'

function argsOnly(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Arguments must be an object')
  const args = raw as Record<string, unknown>
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unknown or authority-bearing tool argument')
  return args
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`)
  return value
}
function page(args: Record<string, unknown>): { cursor?: string; limit?: number } {
  if (args.cursor !== undefined && typeof args.cursor !== 'string') throw new Error('Invalid cursor')
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 64)) throw new Error('Page limit must be 1..64')
  return { cursor: args.cursor as string | undefined, limit: args.limit as number | undefined }
}
function timeout(value: unknown): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 60_000)) throw new Error('Wait timeout must be 0..60000 ms')
  return value as number | undefined
}
async function canonical(ctx: AgentContext) {
  if (!ctx.executionOwner) throw new Error('A canonical execution owner is required')
  ctx.signal?.throwIfAborted()
  const service = serviceForOwner(ctx.executionOwner), runtime = service.collaboration
  const producer = service.producerForExecution(ctx.executionOwner), binding = runtime.executionBinding(producer)
  if (binding.tenantId !== ctx.tenantId || binding.sessionId !== ctx.sessionId || binding.rootRunId !== ctx.rootRunId
    || binding.rootSessionId !== (ctx.rootSessionId ?? ctx.sessionId) || binding.turnId !== ctx.turnId
    || binding.kind === 'child' && binding.invocationRunId !== ctx.runId) throw new Error('Collaboration context does not match its canonical producer')
  await runtime.store.assertProducer(service.db, binding)
  service.producerForExecution(ctx.executionOwner); ctx.signal?.throwIfAborted()
  return { service, runtime, producer, binding }
}
function guarded(execute: (args: unknown, ctx: AgentContext) => Promise<ToolResult>): Tool['execute'] {
  return async (args, ctx) => {
    try { return await execute(args, ctx) }
    catch (error) { return { success: false, output: error instanceof Error ? error.message : String(error), metadata: { code: 'SUBAGENT_CONTROL_FAILED' } } }
  }
}
const pageParameters = { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 64 } }, additionalProperties: false }
const waitParameters = { type: 'object', properties: { runId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 0, maximum: 60000 } }, required: ['runId'], additionalProperties: false }
function waited(result: SubagentWait): ToolResult {
  return { success: true, output: result.state === 'pending' ? JSON.stringify(result) : outcomeText(result.run),
    metadata: { subagentObservation: result } }
}

export const subagentSendTool: Tool = {
  name: 'subagent_send', displayName: '发送子代理消息',
  description: '向当前根任务中的 participantId 发送消息。发送者由当前执行身份确定，不能指定 sender。返回 queued 仅代表持久接纳，不代表对方已读取或处理。相同 requestKey 只能重试完全相同的接收者与正文。',
  parameters: { type: 'object', properties: { recipientParticipantId: { type: 'string' }, message: { type: 'string' }, requestKey: { type: 'string' } }, required: ['recipientParticipantId', 'message'], additionalProperties: false },
  execute: guarded(async (raw, ctx) => {
    const args = argsOnly(raw, ['recipientParticipantId', 'message', 'requestKey'])
    const recipientParticipantId = text(args.recipientParticipantId, 'recipientParticipantId'), message = text(args.message, 'message')
    const requestKey = text(args.requestKey ?? ctx.currentToolCallId, 'requestKey')
    const { service, runtime, producer, binding } = await canonical(ctx)
    let receipt
    try { receipt = await runtime.send(producer, { recipientParticipantId, message, requestKey }) }
    catch (error) {
      // Only the exact immutable payload can reconcile an uncertain COMMIT ACK.
      const prior = await runtime.receipt(producer, requestKey)
      if (!prior || prior.recipientParticipantId !== recipientParticipantId || prior.payloadHash !== createHash('sha256').update(message).digest('hex')
        || prior.payloadBytes !== Buffer.byteLength(message)) throw error
      receipt = prior
    }
    await runtime.store.assertProducer(service.db, binding); service.producerForExecution(ctx.executionOwner!)
    return { success: true, output: JSON.stringify(receipt), metadata: { collaborationReceipt: receipt } }
  }),
}
export const subagentWaitTool: Tool = {
  name: 'subagent_wait', displayName: '等待子代理',
  description: '有界等待本次父任务实际启动的 runId。completed 需要真实执行、最终结果持久投影和任务票据均已完成；pending 不代表取消。超时只结束本次观察。', parameters: waitParameters,
  execute: guarded(async (raw, ctx) => { const args = argsOnly(raw, ['runId', 'timeoutMs']); return waited(await getSubagentRunner().waitOwned(ctx, text(args.runId, 'runId'), { timeoutMs: timeout(args.timeoutMs) })) }),
}
export const subagentCancelTool: Tool = {
  name: 'subagent_cancel', displayName: '取消子代理',
  description: '取消本次父任务实际启动的精确 runId，并有界等待真实执行清理与结果落盘。pending 仅代表已请求取消，不能宣称子代理已终止。', parameters: waitParameters,
  execute: guarded(async (raw, ctx) => { const args = argsOnly(raw, ['runId', 'timeoutMs']); return waited(await getSubagentRunner().cancelOwned(ctx, text(args.runId, 'runId'), { timeoutMs: timeout(args.timeoutMs) })) }),
}
export const subagentParticipantsTool: Tool = {
  name: 'subagent_participants', displayName: '查看协作参与者',
  description: '分页查看当前 canonical 根任务的参与者（每页至多 64）。cursor 绑定当前根任务和接纳前缀，不能用于其它根任务。', parameters: pageParameters,
  execute: guarded(async (raw, ctx) => {
    const options = page(argsOnly(raw, ['cursor', 'limit'])), { service, runtime, binding } = await canonical(ctx)
    const result = await runtime.store.participants(binding, options)
    await runtime.store.assertProducer(service.db, binding); service.producerForExecution(ctx.executionOwner!)
    return { success: true, output: JSON.stringify({ participantId: binding.participantId, ...result }) }
  }),
}
export const subagentInboxTool: Tool = {
  name: 'subagent_inbox', displayName: '查看协作收件回执',
  description: '分页查看当前真实参与者自己的收件队列回执（不含正文）。queued 仅代表已接纳；正文由执行边界自动整合，不表示模型已处理。不能指定其它收件人。', parameters: pageParameters,
  execute: guarded(async (raw, ctx) => {
    const options = page(argsOnly(raw, ['cursor', 'limit'])), { service, runtime, binding } = await canonical(ctx)
    const result = await runtime.store.receipts(binding, binding.participantId, options)
    await runtime.store.assertProducer(service.db, binding); service.producerForExecution(ctx.executionOwner!)
    return { success: true, output: JSON.stringify({ participantId: binding.participantId, ...result }) }
  }),
}

export const asyncSubagentTools = [subagentSendTool, subagentWaitTool, subagentCancelTool, subagentParticipantsTool, subagentInboxTool]
export const readonlySubagentTools = [subagentWaitTool, subagentParticipantsTool, subagentInboxTool]
