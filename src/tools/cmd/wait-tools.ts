import type { AgentContext, JSONSchema, Tool, ToolResult } from '../../core/agent-context/index.js'
import { commandJobs, type CommandJobSnapshot } from '../../core/command-jobs/index.js'
import { getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { commandJobScope } from './execute-command.js'
import { readCommandReceipt } from './command-receipt.js'

const DEFAULT_WAIT_MS = 10_000
const MAX_WAIT_MS = 60_000
const MAX_JOBS = 8

interface JobRequest { jobId: string; cursor?: number; cursorOffset?: number }
interface CommandError { jobId: string; error: string }

const jobProperties: NonNullable<JSONSchema['properties']> = {
  jobId: { type: 'string', minLength: 1 },
  cursor: { type: 'integer', minimum: 0, description: 'Last fully delivered output entry; use nextCursor from the previous receipt.' },
  cursorOffset: { type: 'integer', minimum: 0, description: 'Use nextOffset from the previous receipt unchanged; UTF-8 bytes within the next entry.' },
}
const waitProperty: JSONSchema = { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS, default: DEFAULT_WAIT_MS,
  description: 'Shared maximum wait in milliseconds. Zero reads immediately; timeout never cancels or restarts commands.' }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonnegativeInteger = (value: unknown): boolean => value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validJob = (value: unknown): value is JobRequest => isRecord(value) && typeof value.jobId === 'string' && value.jobId.trim().length > 0
  && nonnegativeInteger(value.cursor) && nonnegativeInteger(value.cursorOffset)
const validWait = (value: unknown): boolean => nonnegativeInteger(value) && (value === undefined || (value as number) <= MAX_WAIT_MS)

function failure(ctx: AgentContext, output: string, error: string): ToolResult {
  return { success: false, output: output.slice(0, getToolOutputLimit(ctx.toolProfile, ctx)), error }
}

/** One deadline owns every observer; neither timeout nor user abort stops a process. */
async function waitTogether(jobs: readonly JobRequest[], waitMs: number, ctx: AgentContext): Promise<Map<string, CommandError>> {
  throwIfAborted(ctx.signal)
  const failures = new Map<string, CommandError>()
  if (waitMs === 0) return failures
  const controller = new AbortController()
  const timeout = new Error('Command observation deadline reached')
  const onAbort = () => controller.abort(ctx.signal?.reason)
  ctx.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(timeout), waitMs)
  try {
    const scope = commandJobScope(ctx)
    await Promise.all(jobs.map(async job => {
      try {
        const snapshot = await commandJobs.waitForCompletion(scope, job.jobId, controller.signal)
        if (!snapshot) failures.set(job.jobId, { jobId: job.jobId, error: 'COMMAND_JOB_NOT_FOUND' })
      } catch {
        // The receipt below reads the real latest state after our observation
        // deadline. A failed observer is never evidence that a job completed.
        if (!controller.signal.aborted) failures.set(job.jobId, { jobId: job.jobId, error: 'COMMAND_WAIT_FAILED' })
      }
    }))
    throwIfAborted(ctx.signal)
    return failures
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', onAbort)
    controller.abort(timeout)
  }
}

export const waitCommandTool: Tool = {
  name: 'wait_command', displayName: '等待命令',
  description: '等待当前会话命令结束并读取有界增量输出，默认10秒、最多60秒；waitMs=0立即读取。超时返回真实running/cancelling状态，不取消、不重新执行。首次cursor=0，续读将nextCursor/nextOffset原样传为cursor/cursorOffset；hasMore时继续读取。子代理只可读取自身运行拥有的命令。',
  parameters: { type: 'object', properties: { ...jobProperties, waitMs: waitProperty }, required: ['jobId'] },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    if (!isRecord(rawArgs) || !validJob(rawArgs) || !validWait(rawArgs.waitMs)) {
      return failure(ctx, 'Expected jobId, optional nonnegative integer cursor/cursorOffset and waitMs from 0 to 60000.', 'COMMAND_INVALID_ARGUMENTS')
    }
    const args = rawArgs as JobRequest & { waitMs?: number }
    const failures = await waitTogether([args], args.waitMs ?? DEFAULT_WAIT_MS, ctx)
    const failed = failures.get(args.jobId)
    if (failed) return failure(ctx, failed.error === 'COMMAND_JOB_NOT_FOUND' ? 'Command job not found in this session.' : 'Could not observe command completion; retry this jobId.', failed.error)
    throwIfAborted(ctx.signal)
    try {
      const result = await readCommandReceipt(commandJobScope(ctx), args.jobId, {
        cursor: args.cursor, cursorOffset: args.cursorOffset, maxChars: getToolOutputLimit(ctx.toolProfile, ctx),
      })
      throwIfAborted(ctx.signal)
      return result ? { success: !result.error, output: result.output, ...(result.error ? { error: result.error } : {}),
        changes: result.job.changes, metadata: { commandJob: result.job } }
        : failure(ctx, 'Command job not found in this session.', 'COMMAND_JOB_NOT_FOUND')
    } catch {
      throwIfAborted(ctx.signal)
      return failure(ctx, 'Could not read command output; retry this jobId with the same cursor/cursorOffset.', 'COMMAND_OUTPUT_FAILED')
    }
  },
}

export const waitCommandsTool: Tool = {
  name: 'wait_commands', displayName: '等待多个命令',
  description: '并发等待当前会话1至8个不同命令，共用一个deadline（默认10秒、最多60秒），每项保留独立状态、错误和增量游标。全部输出共享当前调用预算；逐项将nextCursor/nextOffset原样传为cursor/cursorOffset，hasMore继续读取。超时仍运行的命令返回running/cancelling，不取消、不重启。子代理仅可读取自身运行的命令。',
  parameters: { type: 'object', properties: {
    jobs: { type: 'array', minItems: 1, maxItems: MAX_JOBS, items: { type: 'object', properties: jobProperties, required: ['jobId'] } },
    waitMs: waitProperty,
  }, required: ['jobs'] },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    if (!isRecord(rawArgs) || !Array.isArray(rawArgs.jobs) || rawArgs.jobs.length < 1 || rawArgs.jobs.length > MAX_JOBS
      || !rawArgs.jobs.every(validJob) || new Set(rawArgs.jobs.map(job => job.jobId)).size !== rawArgs.jobs.length || !validWait(rawArgs.waitMs)) {
      return failure(ctx, 'Expected 1-8 unique jobs with jobId, optional nonnegative cursor/cursorOffset and waitMs from 0 to 60000.', 'COMMAND_INVALID_ARGUMENTS')
    }
    const jobs = rawArgs.jobs as JobRequest[]
    const envelope = { type: 'command_results', version: 1, results: [] as unknown[] }
    const limit = getToolOutputLimit(ctx.toolProfile, ctx)
    const itemLimit = Math.floor((limit - JSON.stringify(envelope).length - (jobs.length - 1)) / jobs.length)
    // A complete per-item error must fit before any receipt is read. This also
    // handles caller-controlled long IDs without leaking/truncating cursors.
    if (jobs.some(job => JSON.stringify({ jobId: job.jobId, error: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL' }).length > itemLimit)) {
      return failure(ctx, 'Output allowance too small; retry fewer jobs with the same cursors.', 'COMMAND_OUTPUT_BUDGET_TOO_SMALL')
    }
    const failures = await waitTogether(jobs, (rawArgs.waitMs as number | undefined) ?? DEFAULT_WAIT_MS, ctx)
    const snapshots = new Map<string, CommandJobSnapshot>()
    const results = await Promise.all(jobs.map(async job => {
      const observedError = failures.get(job.jobId)
      if (observedError) return observedError
      throwIfAborted(ctx.signal)
      try {
        const result = await readCommandReceipt(commandJobScope(ctx), job.jobId, {
          cursor: job.cursor, cursorOffset: job.cursorOffset, maxChars: itemLimit,
        })
        throwIfAborted(ctx.signal)
        if (result) snapshots.set(job.jobId, result.job)
        if (result?.receipt && !result.error) return result.receipt
        const error = { jobId: job.jobId, error: result ? 'COMMAND_OUTPUT_BUDGET_TOO_SMALL' : 'COMMAND_JOB_NOT_FOUND' }
        failures.set(job.jobId, error)
        return error
      } catch {
        throwIfAborted(ctx.signal)
        const error = { jobId: job.jobId, error: 'COMMAND_OUTPUT_FAILED' }
        failures.set(job.jobId, error)
        return error
      }
    }))
    throwIfAborted(ctx.signal)
    const commandSnapshots = jobs.flatMap(job => snapshots.has(job.jobId) ? [snapshots.get(job.jobId)!] : [])
    return { success: failures.size === 0, output: JSON.stringify({ ...envelope, results }),
      ...(failures.size ? { error: 'COMMAND_WAIT_PARTIAL_FAILURE' } : {}),
      changes: commandSnapshots.flatMap(job => job.changes ?? []),
      metadata: { commandJobs: commandSnapshots, commandErrors: [...failures.values()] } }
  },
}

export const commandWaitTools: Tool[] = [waitCommandTool, waitCommandsTool]
