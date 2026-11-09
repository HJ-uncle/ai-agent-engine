import { createHash } from 'node:crypto'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/types.js'
import { serviceForOwner } from '../../core/collaboration/execution-owner.js'
import { getSubagentRunner, type SubagentWait } from '../../core/subagent/runner.js'
import { outcomeText } from '../../core/subagent/types.js'
import { getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { fitResultPage, SUBAGENT_RESULT_PAGE_BYTES } from '../../core/subagent/result.js'

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
const batchWaitParameters = { type: 'object', properties: {
  runId: { type: 'string', description: 'Single target; mutually exclusive with runIds.' },
  runIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, uniqueItems: true, description: 'Wait for all targets together; prefer this for multiple tasks.' },
  timeoutMs: { type: 'integer', minimum: 0, maximum: 60000, description: 'One shared deadline; batch default 60000.' },
}, additionalProperties: false }
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
  description: '有界等待本次父任务实际启动的任务。多个目标用runIds（1–8个，不与runId同传），共用截止时间，收齐后一次回传；超时或新消息提前返回已完成和待完成项。completed需真实执行、结果持久投影和任务票据均完成，不等于任务成功；pending不取消任务。批量回执引用父会话结果通知，不重复正文。', parameters: batchWaitParameters,
  execute: guarded(async (raw, ctx) => {
    const args = argsOnly(raw, ['runId', 'runIds', 'timeoutMs']), runner = getSubagentRunner()
    const timeoutMs = timeout(args.timeoutMs)
    if ((args.runId !== undefined) === (args.runIds !== undefined)) throw new Error('Provide exactly one of runId or runIds')
    const single = args.runId !== undefined
    if (!single && (!Array.isArray(args.runIds) || args.runIds.length < 1 || args.runIds.length > 8)) throw new Error('runIds must contain 1..8 unique nonempty IDs')
    const runIds = single ? [text(args.runId, 'runId')] : (args.runIds as unknown[]).map(value => text(value, 'runIds item'))
    if (new Set(runIds).size !== runIds.length) throw new Error('runIds must contain unique IDs')
    const result = single ? await runner.waitOwned(ctx, runIds[0], { timeoutMs }).then(item => ({
      state: item.state, runs: [item], reason: item.state === 'pending' ? item.reason : undefined,
    })) : await runner.waitManyOwned(ctx, runIds, { timeoutMs })
    if (single && result.runs[0].state === 'pending') return waited(result.runs[0])
    const runs = await Promise.all(result.runs.map(async item => {
      if (item.state === 'pending') return item
      const run = item.run
      const projection = await runner.store.ownedParentProjection(ctx.tenantId, run.runId, run.lastSeq)
      if (!projection.acknowledged || !projection.disposition) throw new Error('SUBAGENT_RESULT_PROJECTION_UNKNOWN')
      return { state: item.state, runId: run.runId, childSessionId: run.childSessionId, status: run.status,
        stopReason: run.stopReason, errorCode: run.error?.code, projection: projection.disposition,
        ...(projection.disposition === 'suppressed' ? {} : { resultMessageId: 'subagent-result:' + run.runId }) }
    }))
    // Completed bodies already have canonical parent-history notifications. Repeating
    // them here multiplies context and can cut a multi-result JSON receipt in half.
    await canonical(ctx)
    const note = 'completed为等待完成，成败看status。结果正文见resultMessageId对应父会话通知；suppressed表示通知未写入，不能据此验收。'
    const receipt = (items: Array<Record<string, unknown>>) => single ? { ...items[0], note }
      : { state: result.state, ...(result.reason ? { reason: result.reason } : {}), runs: items, note }
    const limit = getToolOutputLimit(ctx.toolProfile, ctx)
    let output = JSON.stringify(receipt(runs))
    if (output.length > limit) output = JSON.stringify(receipt(runs.map(item => item.state === 'pending' ? item
      : { ...item, childSessionId: undefined, stopReason: undefined, errorCode: undefined })))
    if (output.length > limit) throw new Error('Tool output allowance is too small for the batch wait receipt; wait for fewer targets together')
    return { success: true, output, metadata: { subagentObservation: single
      ? { state: result.state, run: runs[0] }
      : { state: result.state, reason: result.reason, runs } } }
  }),
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

export const subagentReadResultTool: Tool = {
  name: 'subagent_read_result', displayName: '读取子代理完整结果',
  description: '按 UTF-8 字节分页读取子代理已落盘且经过哈希校验的完整最终回答或部分结果。只读当前父会话所属 runId；子代理仅可读当前协作根任务中的同伴结果。先 offset=0，随后严格使用 nextOffset，直到 hasMore=false。结果引用不能代表执行成功，终态仍以机器状态为准。旧记录无完整引用时明确报错，不把摘要当全文。',
  parameters: { type: 'object', properties: { runId: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
    limitBytes: { type: 'integer', minimum: 4, maximum: SUBAGENT_RESULT_PAGE_BYTES } }, required: ['runId'], additionalProperties: false },
  execute: guarded(async (raw, ctx) => {
    const args = argsOnly(raw, ['runId', 'offset', 'limitBytes']), runId = text(args.runId, 'runId')
    if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)
      || args.limitBytes !== undefined && (!Number.isSafeInteger(args.limitBytes) || Number(args.limitBytes) < 4 || Number(args.limitBytes) > SUBAGENT_RESULT_PAGE_BYTES))
      throw new RangeError('Invalid result page range')
    const { service, runtime, binding } = await canonical(ctx), store = getSubagentRunner().store
    if (store.db !== service.db) throw new Error('Subagent result datasource mismatch')
    if (binding.kind === 'child' && !(await runtime.store.executionInvocations(binding)).some(run => run.runId === runId))
      throw new Error('Subagent result does not belong to the current collaboration')
    const allowance = getToolOutputLimit(ctx.toolProfile, ctx)
    const page = await store.getResultPage(binding.tenantId, binding.kind === 'root' ? binding.sessionId : binding.rootSessionId, runId,
      { rootSessionId: binding.rootSessionId, offset: args.offset as number | undefined,
        limitBytes: Math.min(Number(args.limitBytes ?? 16 * 1024), Math.max(4, allowance)) })
    if (!page) throw new Error('Owned subagent result not found')
    const fitted = fitResultPage(page, allowance)
    await runtime.store.assertProducer(service.db, binding); service.producerForExecution(ctx.executionOwner!); ctx.signal?.throwIfAborted()
    return { success: true, output: JSON.stringify(fitted), metadata: { subagentResultPage: {
      runId, resultRef: fitted.resultRef, resultHash: fitted.resultHash, resultKind: fitted.resultKind, offset: fitted.offset,
      totalBytes: fitted.totalBytes, hasMore: fitted.hasMore, nextOffset: fitted.nextOffset } } }
  }),
}

export const asyncSubagentTools = [subagentSendTool, subagentWaitTool, subagentCancelTool, subagentParticipantsTool, subagentInboxTool, subagentReadResultTool]
export const readonlySubagentTools = [subagentWaitTool, subagentParticipantsTool, subagentInboxTool, subagentReadResultTool]
