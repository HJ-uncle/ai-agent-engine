export type CommandJobStatus = 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'

/** All timestamps are Unix epoch milliseconds. No PID or environment is exposed or persisted. */
export interface CommandJobSnapshot {
  schemaVersion: 1
  jobId: string
  sessionId: string
  ownerSessionId: string
  runId?: string
  ownerRunId?: string
  turnId?: string
  toolCallId?: string
  version: number
  status: CommandJobStatus
  command: string
  args: string[]
  cwd: string
  background: boolean
  createdAt: number
  updatedAt: number
  finishedAt?: number
  exitCode: number | null
  signal: string | null
  error?: { code: string; message: string }
  /** Last output sequence; zero before any output. */
  cursor: number
  /** Cursor immediately before the first retained entry. Older cursors have a gap. */
  earliestCursor: number
}

export interface CommandOutputEntry { seq: number; stream: 'stdout' | 'stderr'; text: string }
export interface CommandJobOutput {
  job: CommandJobSnapshot
  entries: CommandOutputEntry[]
  nextCursor: number
  earliestCursor: number
  truncated: boolean
  hasMore: boolean
}

/** Every lookup requires tenant and root session; optional selectors can only narrow access. */
export interface CommandJobScope {
  tenantId: string
  sessionId: string
  runId?: string
  ownerSessionId?: string
  ownerRunId?: string
}

export interface CommandJobLaunch {
  tenantId: string
  sessionId: string
  ownerSessionId: string
  runId?: string
  ownerRunId?: string
  turnId?: string
  toolCallId?: string
  command: string
  args: string[]
  cwd: string
  background: boolean
  timeoutMs: number
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export const COMMAND_OUTPUT_BYTES = 256 * 1024
export const COMMAND_PAGE_BYTES = 64 * 1024
export const commandJobIsTerminal = (status: CommandJobStatus): boolean => status !== 'running' && status !== 'cancelling'
