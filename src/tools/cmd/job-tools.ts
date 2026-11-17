import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { commandJobs } from '../../core/command-jobs/index.js'
import { commandJobScope } from './execute-command.js'
import { getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { formatCommandReceipt, readCommandReceipt } from './command-receipt.js'

const missing = (): ToolResult => ({ success: false, output: 'Command job not found in this session.', error: 'COMMAND_JOB_NOT_FOUND' })
const parameters = { type: 'object' as const, properties: { jobId: { type: 'string' as const, minLength: 1 } }, required: ['jobId'] }

export const commandOutputTool: Tool = {
  name: 'command_output', displayName: '读取命令输出',
  description: '读取当前会话命令的状态与有序增量stdout/stderr。首次cursor=0、cursorOffset=0，后续原样传nextCursor与nextOffset；hasMore时继续读取。返回预算内command_result回执，完整输出持久化到磁盘，不会因分页丢失。',
  parameters: { ...parameters, properties: { ...parameters.properties, cursor: { type: 'integer', minimum: 0 },
    cursorOffset: { type: 'integer', minimum: 0, description: '上一回执nextOffset，原样回传；省略为0。' } } },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs as { jobId?: unknown; cursor?: unknown; cursorOffset?: unknown }
    if (!args || typeof args.jobId !== 'string' || !args.jobId ||
      [args.cursor, args.cursorOffset].some(value => value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))) {
      return { success: false, output: 'Expected a jobId and optional nonnegative integer cursor/cursorOffset.', error: 'COMMAND_INVALID_ARGUMENTS' }
    }
    try {
      const output = await readCommandReceipt(commandJobScope(ctx), args.jobId, { cursor: args.cursor as number | undefined,
        cursorOffset: args.cursorOffset as number | undefined, maxChars: getToolOutputLimit(ctx.toolProfile, ctx) })
      return output ? { success: !output.error, output: output.output, error: output.error,
        changes: output.job.changes, metadata: { commandJob: output.job } } : missing()
    } catch (error) { return { success: false, output: error instanceof Error ? error.message : String(error), error: 'COMMAND_OUTPUT_FAILED' } }
  },
}

export const cancelCommandTool: Tool = {
  name: 'cancel_command', displayName: '停止后台命令',
  description: '停止当前会话的命令及其可追踪子进程，并等待退出。使用后台execute_cmd返回的jobId；已结束的命令不会再次执行。',
  parameters,
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs as { jobId?: unknown }
    if (!args || typeof args.jobId !== 'string' || !args.jobId) return { success: false, output: 'Expected a jobId.', error: 'COMMAND_INVALID_ARGUMENTS' }
    try {
      const job = await commandJobs.cancel(commandJobScope(ctx), args.jobId, 'Stopped by cancel_command')
      if (!job) return missing()
      const receipt = formatCommandReceipt(job, { maxChars: getToolOutputLimit(ctx.toolProfile, ctx) })
      return { success: !receipt.error, output: receipt.output, error: receipt.error, changes: job.changes, metadata: { commandJob: job } }
    } catch (error) { return { success: false, output: error instanceof Error ? error.message : String(error), error: 'COMMAND_CANCEL_FAILED' } }
  },
}

export const commandJobTools: Tool[] = [commandOutputTool, cancelCommandTool]
