import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { commandJobs } from '../../core/command-jobs/index.js'
import { commandJobScope } from './execute-command.js'

const missing = (): ToolResult => ({ success: false, output: 'Command job not found in this session.', error: 'COMMAND_JOB_NOT_FOUND' })
const parameters = { type: 'object' as const, properties: { jobId: { type: 'string' as const, minLength: 1 } }, required: ['jobId'] }

export const commandOutputTool: Tool = {
  name: 'command_output', displayName: '读取命令输出',
  description: '读取当前会话后台命令的状态与增量stdout/stderr。首次cursor=0，后续传nextCursor；hasMore时继续读取。truncated=true表示旧输出已超出256KiB尾部限制，不能声称已读完整日志。',
  parameters: { ...parameters, properties: { ...parameters.properties, cursor: { type: 'integer', minimum: 0 } } },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs as { jobId?: unknown; cursor?: unknown }
    if (!args || typeof args.jobId !== 'string' || !args.jobId ||
      (args.cursor !== undefined && (typeof args.cursor !== 'number' || !Number.isSafeInteger(args.cursor) || args.cursor < 0))) {
      return { success: false, output: 'Expected a jobId and an optional nonnegative integer cursor.', error: 'COMMAND_INVALID_ARGUMENTS' }
    }
    try {
      const output = await commandJobs.output(commandJobScope(ctx), args.jobId, { cursor: args.cursor as number | undefined })
      return output ? { success: true, output: JSON.stringify(output), metadata: { commandJob: output.job } } : missing()
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
      return job ? { success: true, output: JSON.stringify(job), metadata: { commandJob: job } } : missing()
    } catch (error) { return { success: false, output: error instanceof Error ? error.message : String(error), error: 'COMMAND_CANCEL_FAILED' } }
  },
}

export const commandJobTools: Tool[] = [commandOutputTool, cancelCommandTool]
