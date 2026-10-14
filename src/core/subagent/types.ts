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

export interface SubagentContinuationProfile {
  /** Frozen custom-Agent configuration; a follow-up must keep the same identity and permissions. */
  agent?: {
    id: string
    name: string
    description?: string
    systemPrompt?: string
    model?: string
    temperature?: number
    skills: string[]
    mcpServers: string[]
    knowledgeBases: string[]
    allowedTools: string[]
  }
  /** Only a server-validated, explicit user delegation may use its Agent's own tool catalog. */
  userDelegated?: boolean
  role?: string
  readOnly: boolean
  systemPrompt: string
  toolNames: string[]
  workspacePaths: string[]
  projectRoot?: string
  cwd?: string
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
  /** Server-owned admission mode; async completion is a separate notification. */
  parentToolName?: 'subagent' | 'subagent_start'
  childSessionId: string
  resumeFromRunId?: string
  agentId?: string
  agentName?: string
  continuation?: SubagentContinuationProfile
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

/** A resident sample is deliberately distinct from the canonical v1 archive. */
export interface SubagentToolSummary extends SubagentToolCall {
  revisionSeq: number
  ordinal: number
  detailRef: string
  detailTruncated: boolean
  argsPreview?: string
  outputPreview?: string
}

export interface SubagentCoverage {
  asOfSeq: number
  toolCount: number
  includedToolCount: number
  activeToolCount: number
  includedActiveToolCount: number
  ids: string[]
  hasMore: boolean
  truncated: boolean
  completeness: 'complete' | 'partial' | 'unknown'
  nextCursor?: string
}

export interface SubagentRunView extends Omit<SubagentRun, 'schemaVersion' | 'toolCalls' | 'continuation'> {
  schemaVersion: 2
  view: 'summary'
  continuation?: Pick<SubagentContinuationProfile, 'role' | 'readOnly'>
  toolCalls: SubagentToolSummary[]
  toolCount: number
  activeToolCount: number
  coverage: SubagentCoverage
  latestActivity?: SubagentToolSummary
  recoveryRequired?: boolean
  residentToolCount?: number
  residentBytes?: number
}

export type SubagentIdentity = Pick<SubagentRun, 'tenantId' | 'rootSessionId' | 'parentSessionId' | 'parentConversationId' | 'parentMessageId' | 'parentToolCallId' | 'childSessionId'>
export type SubagentViewHeader = Omit<SubagentRunView, 'toolCalls' | 'coverage'>
export interface SubagentDeltaEvent {
  schemaVersion: 2
  kind: SubagentEvent['kind']
  runId: string
  seq: number
  baseSeq: number
  identity: SubagentIdentity
  header?: SubagentViewHeader
  headerPatch: Partial<Omit<SubagentViewHeader, 'schemaVersion' | 'view'>>
  toolUpsert?: SubagentToolSummary
  coverage?: SubagentCoverage
}
/** Exact bounded checkpoint for negotiated recovery and legacy stream conversion. */
export interface SubagentViewEvent {
  schemaVersion: 2
  kind: 'snapshot'
  runId: string
  seq: number
  view: SubagentRunView
}
export type SubagentWireEvent = SubagentEvent | SubagentDeltaEvent | SubagentViewEvent
/** Immutable permissions stay in the server record, never in live deltas. */
export interface SubagentRunHeader extends Omit<SubagentRun, 'toolCalls'> {
  toolCount: number
  activeToolCount: number
  latestActivity?: SubagentToolSummary
  nonPlanToolCount: number
  /** A display-only read never pretends to contain executable permissions. */
  continuationDisplay?: Pick<SubagentContinuationProfile, 'role' | 'readOnly'>
}
export interface SubagentMutation {
  event: SubagentWireEvent
  header: SubagentRunHeader
  view: SubagentRunView
}

export type CreateSubagentRun = Pick<SubagentRun, 'tenantId' | 'rootSessionId' | 'parentSessionId' | 'parentConversationId' | 'parentMessageId' | 'parentToolCallId' | 'task' | 'description' | 'modelId'> & {
  parentToolName?: SubagentRun['parentToolName']
  runId?: string
  childSessionId?: string
  resumeFromRunId?: string
  agentId?: string
  agentName?: string
  continuation?: SubagentContinuationProfile
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

/** Automatic history reduction is independent from the parent run's outcome. */
export interface CompactionState {
  phase: 'running' | 'succeeded' | 'failed'
  startedAt: number
  finishedAt?: number
  beforeTokens?: number
  afterTokens?: number
  error?: string
}

export interface RunObserver {
  onOutput?(text: string): void | Promise<void>
  onCompaction?(state: CompactionState): void | Promise<void>
  onOutcome(outcome: RunOutcome): void | Promise<void>
  onToolStart(tool: RunToolStart): void | Promise<void>
  onToolEnd(tool: RunToolEnd): void | Promise<void>
  onUsage(usage: RunInvocationUsage): void | Promise<void>
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted'])

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export function outcomeText(run: Pick<SubagentRun, 'runId' | 'parentToolCallId' | 'status' | 'stopReason' | 'error' | 'resultSummary' | 'partialOutput'>): string {
  // The parent may retain several attempts in history. Bind the evidence to this
  // invocation before model-authored prose (which can claim a conflicting status).
  const state = `[子任务状态] ${JSON.stringify({ runId: run.runId, parentToolCallId: run.parentToolCallId,
    status: run.status, stopReason: run.stopReason, errorCode: run.error?.code })}`
  const context = '以上为当前调用的机器状态；正文中的完成自述不能覆盖它，其他 runId 的旧结果不能替代它。'
  if (run.status === 'succeeded') return `${state}\n${context}\n\n${run.resultSummary ?? ''}`
  const reason = run.error?.message ?? run.stopReason ?? run.status
  return `${state}\n${context}\n\n子代理${run.status === 'cancelled' ? '已取消' : run.status === 'blocked' ? '需要授权' : '未完成'}：${reason}${run.partialOutput ? `\n\n部分结果（保留原文，不代表任务成功）：\n${run.partialOutput}` : ''}`
}
