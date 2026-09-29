export type RunStatus = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'interrupted'

export interface RunError {
  code: string
  message: string
  retryable: boolean
}

export interface RunUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  estimated?: boolean
  unknown?: boolean
}

export interface SubagentToolCall {
  id: string
  name: string
  args: unknown
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  output?: string
  error?: RunError
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

export interface SubagentRun {
  schemaVersion: 1
  runId: string
  tenantId: string
  rootSessionId: string
  parentSessionId: string
  parentConversationId: string
  parentMessageId: string
  parentToolCallId: string
  childSessionId: string
  task: string
  description: string
  modelId: string
  status: RunStatus
  lastSeq: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  stopReason?: string
  error?: RunError
  resultSummary?: string
  partialOutput?: string
  externalEffectStatus?: 'unknown'
  usage: RunUsage
  toolCalls: SubagentToolCall[]
  transcriptRef: string
}

export interface SubagentEvent {
  schemaVersion: 1
  kind: 'created' | 'started' | 'cancelling' | 'tool.started' | 'tool.completed' | 'usage.updated' | 'output.updated' | 'finished'
  runId: string
  seq: number
  snapshot: SubagentRun
}

export type CreateSubagentRun = Pick<SubagentRun, 'tenantId' | 'rootSessionId' | 'parentSessionId' | 'parentConversationId' | 'parentMessageId' | 'parentToolCallId' | 'task' | 'description' | 'modelId'> & {
  runId?: string
  childSessionId?: string
}

export type RunOutcome = {
  status: 'succeeded' | 'failed' | 'cancelled' | 'blocked'
  output?: string
  partialOutput?: string
  stopReason?: string
  error?: RunError
}

export interface RunToolStart {
  toolCallId: string
  name: string
  args: unknown
}

export interface RunToolEnd {
  toolCallId: string
  name: string
  success: boolean
  output: string
  error?: RunError
  durationMs?: number
}

/** Each usage callback describes one completed model invocation, never the cumulative parent total. */
export interface RunInvocationUsage {
  invocationId: string
  promptTokens: number
  completionTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  cacheWriteTokens?: number
  estimated?: boolean
  unknown?: boolean
}

export interface RunObserver {
  onOutput?(text: string): void | Promise<void>
  onOutcome(outcome: RunOutcome): void | Promise<void>
  onToolStart(tool: RunToolStart): void | Promise<void>
  onToolEnd(tool: RunToolEnd): void | Promise<void>
  onUsage(usage: RunInvocationUsage): void | Promise<void>
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted'])

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export function outcomeText(run: SubagentRun): string {
  if (run.status === 'succeeded') return run.resultSummary ?? ''
  const reason = run.error?.message ?? run.stopReason ?? run.status
  return `子代理${run.status === 'cancelled' ? '已取消' : run.status === 'blocked' ? '需要授权' : '未完成'}：${reason}${run.partialOutput ? `\n\n部分结果：\n${run.partialOutput}` : ''}`
}
