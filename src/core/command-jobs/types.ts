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
  /** Lightweight receipts; full before/after content lives in the changes API. */
  changes?: Record<string, unknown>[]
  changeTracking?: CommandChangeTracking
}

export interface CommandChangeTracking {
  status: 'observing' | 'complete' | 'partial' | 'unavailable'
  root: string
  note: string
  limits?: { maxFiles: number; maxBytes: number; maxFileBytes: number; maxEntries: number; maxDepth: number; maxScanMs: number; maxChanges: number }
  excludedDirectories?: string[]
  skippedCount?: number
  skippedSamples?: string[]
  skippedReasons?: Record<string, number>
  concurrentChangesExcluded?: number
  recordedCount?: number
}

export interface CommandChangeObserver {
  initial: CommandChangeTracking
  finish(): Promise<{ changes: Record<string, unknown>[]; tracking: CommandChangeTracking }>
  dispose(): void
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

declare const capturedScopeAuthority: unique symbol
/** Same-manager handle identities, captured before an asynchronous stop can admit a later turn. */
export type CommandScopeCapture = Readonly<{ [capturedScopeAuthority]: 'command-scope' }>

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
  /** Optional deadline. Omit for a command that runs until it exits or is cancelled. */
  timeoutMs?: number
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Prepared after admission, before spawn. Never serialized or accepted over HTTP. */
  observeChanges?: (job: CommandJobSnapshot) => Promise<CommandChangeObserver>
}

export const COMMAND_OUTPUT_BYTES = 256 * 1024
export const COMMAND_PAGE_BYTES = 64 * 1024
export const commandJobIsTerminal = (status: CommandJobStatus): boolean => status !== 'running' && status !== 'cancelling'
