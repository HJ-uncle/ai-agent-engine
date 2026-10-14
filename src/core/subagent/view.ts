import type { SubagentRun, SubagentRunView, SubagentToolSummary, SubagentDeltaEvent, SubagentCoverage } from './types.js'

export const SUBAGENT_VIEW_MAX_TOOLS = 64
export const SUBAGENT_VIEW_MAX_ACTIVE_TOOLS = 32
export const SUBAGENT_VIEW_MAX_BYTES = 256 * 1024
export interface SubagentViewBudget { maxTools?: number; maxActiveTools?: number; maxBytes?: number }
export interface SubagentViewMerge {
  status: 'merged' | 'conflict' | 'invalid'
  view: SubagentRunView
  reason?: string
}
export interface SubagentDeltaReduction {
  status: 'applied' | 'verified-duplicate' | 'gap' | 'invalid'
  view?: SubagentRunView
  reason?: string
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const terminal = (status: unknown): boolean => ['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted'].includes(String(status))
const identityKeys = ['runId', 'tenantId', 'rootSessionId', 'parentSessionId', 'parentConversationId',
  'parentMessageId', 'parentToolCallId', 'childSessionId'] as const
const usageKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'estimated', 'unknown'] as const

/** UTF-8 budgets also bound allocation: never encode an entire oversized input. */
function textPreview(value: string, maxBytes: number): { value: string; truncated: boolean } {
  // Persisted summaries are already small. Native byteLength avoids repeated
  // per-character work without encoding an unbounded original tool output.
  if (value.length <= maxBytes && Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false }
  let bytes = 0, end = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    end += character.length
  }
  return { value: value.slice(0, end), truncated: end !== value.length }
}

/** Produce valid JSON for args; an arbitrary substring is not a JSON document. */
function argumentPreview(value: unknown): { args: unknown; text: string; truncated: boolean } {
  let nodes = 0, truncated = false
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 96 || depth > 4) { truncated = true; return '[详情已归档]' }
    if (typeof item === 'string') {
      const preview = textPreview(item, 192)
      truncated ||= preview.truncated
      return preview.value
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) {
      if (item.length > 12) truncated = true
      return item.slice(0, 12).map(entry => visit(entry, depth + 1))
    }
    const data = object(item)
    if (data) {
      const entries: [string, unknown][] = []
      for (const key in data) {
        if (!Object.hasOwn(data, key)) continue
        if (entries.length === 12) { truncated = true; break }
        entries.push([key, data[key]])
      }
      return Object.fromEntries(entries.map(([key, entry]) => {
        const preview = textPreview(key, 96)
        truncated ||= preview.truncated
        return [preview.value, visit(entry, depth + 1)]
      }))
    }
    if (item !== undefined) truncated = true
    return null
  }
  let args = visit(value, 0), text = JSON.stringify(args)
  if (Buffer.byteLength(text, 'utf8') > 1024) {
    truncated = true
    let length = 384
    do {
      args = { preview: textPreview(text, length).value, truncated: true }
      const bounded = JSON.stringify(args)
      if (Buffer.byteLength(bounded, 'utf8') <= 1024) { text = bounded; break }
      length = Math.floor(length / 2)
    } while (length > 0)
  }
  return { args, text, truncated }
}

function toolRevision(tool: SubagentRun['toolCalls'][number] | SubagentToolSummary, seq: number): number {
  const revision = (tool as Partial<SubagentToolSummary>).revisionSeq
  return integer(revision) && revision <= seq ? revision : seq
}
function recentTools(a: SubagentToolSummary, b: SubagentToolSummary): number {
  return b.revisionSeq - a.revisionSeq || (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0)
    || b.ordinal - a.ordinal || a.id.localeCompare(b.id)
}

export function summarizeSubagentTool(tool: SubagentRun['toolCalls'][number] | SubagentToolSummary,
  runId: string, seq: number, ordinal: number): SubagentToolSummary {
  const existing = tool as Partial<SubagentToolSummary>
  const args = argumentPreview(tool.args)
  const output = tool.output === undefined ? undefined : textPreview(tool.output, 2048)
  const suppliedArgs = typeof existing.argsPreview === 'string' ? textPreview(existing.argsPreview, 1024) : undefined
  const suppliedOutput = typeof existing.outputPreview === 'string' ? textPreview(existing.outputPreview, 2048) : undefined
  const name = textPreview(tool.name, 512)
  const error = tool.error ? { ...tool.error, code: textPreview(tool.error.code, 256).value,
    message: textPreview(tool.error.message, 1024).value } : undefined
  return { id: tool.id, name: name.value, args: args.args, status: tool.status,
    ...(output ? { output: output.value } : {}), ...(error ? { error } : {}),
    ...(tool.startedAt === undefined ? {} : { startedAt: tool.startedAt }),
    ...(tool.finishedAt === undefined ? {} : { finishedAt: tool.finishedAt }),
    ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
    ordinal: integer(existing.ordinal) && existing.ordinal > 0 ? existing.ordinal : ordinal,
    revisionSeq: toolRevision(tool, seq),
    detailRef: existing.detailRef || `/subagent/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(tool.id)}?atSeq=${seq}`,
    argsPreview: suppliedArgs?.value ?? args.text,
    ...(suppliedOutput || output ? { outputPreview: suppliedOutput?.value ?? output?.value } : {}),
    detailTruncated: existing.detailTruncated === true || args.truncated || output?.truncated === true
      || suppliedArgs?.truncated === true || suppliedOutput?.truncated === true || name.truncated,
  }
}

function checkedCoverage(view: SubagentRunView): boolean {
  const coverage = view.coverage
  return view.schemaVersion === 2 && view.view === 'summary' && Array.isArray(view.toolCalls)
    && integer(view.lastSeq) && !!coverage && coverage.asOfSeq === view.lastSeq && integer(coverage.toolCount)
    && coverage.toolCount === view.toolCount && integer(coverage.activeToolCount)
    && coverage.activeToolCount === view.activeToolCount && coverage.activeToolCount <= coverage.toolCount
    && Array.isArray(coverage.ids) && new Set(coverage.ids).size === coverage.ids.length
    && coverage.includedToolCount === coverage.ids.length && coverage.includedToolCount <= coverage.toolCount
    && integer(coverage.includedActiveToolCount) && coverage.includedActiveToolCount <= coverage.activeToolCount
    && view.toolCalls.length === coverage.includedToolCount
    && view.toolCalls.every(tool => coverage.ids.includes(tool.id) && integer(tool.revisionSeq) && tool.revisionSeq > 0
      && tool.revisionSeq <= view.lastSeq && integer(tool.ordinal) && tool.ordinal > 0)
    && new Set(view.toolCalls.map(tool => tool.id)).size === view.toolCalls.length
    && view.toolCalls.filter(tool => tool.status === 'running').length === coverage.includedActiveToolCount
    && ['complete', 'partial', 'unknown'].includes(coverage.completeness)
    && (coverage.completeness !== 'complete' || coverage.includedToolCount === coverage.toolCount
      && coverage.includedActiveToolCount === coverage.activeToolCount && coverage.hasMore === false)
}

/** Canonical v1 archives stay intact; the live protocol explicitly carries a bounded v2 view. */
export function projectSubagentRunView(input: SubagentRun | SubagentRunView, budget: SubagentViewBudget = {}): SubagentRunView {
  if (!input || !['1', '2'].includes(String(input.schemaVersion)) || !integer(input.lastSeq)) throw new Error('Invalid subagent view version or sequence')
  if (input.schemaVersion === 2 && (input.view !== 'summary' || !checkedCoverage(input))) throw new Error('Invalid subagent coverage')
  for (const key of identityKeys) if (typeof input[key] !== 'string' || Buffer.byteLength(input[key], 'utf8') > 4096) throw new Error(`Invalid subagent identity: ${key}`)
  for (const key of ['resumeFromRunId', 'agentId', 'modelId', 'transcriptRef'] as const)
    if (input[key] !== undefined && (typeof input[key] !== 'string' || Buffer.byteLength(input[key], 'utf8') > 4096)) throw new Error(`Invalid subagent reference: ${key}`)
  if (input.parentToolName !== undefined && !['subagent', 'subagent_start'].includes(input.parentToolName)) throw new Error('Invalid subagent parent tool mode')
  if (!Array.isArray(input.toolCalls)) throw new Error('Invalid subagent tools')
  if (!['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted'].includes(input.status)) throw new Error('Invalid subagent status')
  for (const key of usageKeys) {
    const value = input.usage?.[key]
    if (value !== undefined && (key === 'estimated' || key === 'unknown' ? typeof value !== 'boolean'
      : typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Invalid subagent usage')
  }
  const maxTools = Math.min(SUBAGENT_VIEW_MAX_TOOLS, Math.max(0, Math.floor(budget.maxTools ?? SUBAGENT_VIEW_MAX_TOOLS)))
  const maxActive = Math.min(SUBAGENT_VIEW_MAX_ACTIVE_TOOLS, maxTools, Math.max(0, Math.floor(budget.maxActiveTools ?? SUBAGENT_VIEW_MAX_ACTIVE_TOOLS)))
  const maxBytes = Math.min(SUBAGENT_VIEW_MAX_BYTES, Math.max(16 * 1024, Math.floor(budget.maxBytes ?? SUBAGENT_VIEW_MAX_BYTES)))
  const canonical = input.schemaVersion === 1
  const toolCount = canonical ? input.toolCalls.length : input.toolCount
  const activeToolCount = canonical ? input.toolCalls.filter(tool => tool.status === 'running').length : input.activeToolCount
  let detailTruncated = input.schemaVersion === 2 && input.coverage.truncated
  const clip = (text: string | undefined, bytes: number): string | undefined => {
    if (text === undefined) return undefined
    const preview = textPreview(text, bytes)
    detailTruncated ||= preview.truncated
    return preview.value
  }
  const tools = new Map<string, SubagentToolSummary>()
  input.toolCalls.forEach((tool, index) => {
    const revision = (tool as Partial<SubagentToolSummary>).revisionSeq
    if (!tool || typeof tool.id !== 'string' || !tool.id || Buffer.byteLength(tool.id, 'utf8') > 4096
      || integer(revision) && revision > input.lastSeq) throw new Error('Invalid or future subagent tool revision')
    const detailRef = (tool as Partial<SubagentToolSummary>).detailRef
    if (detailRef !== undefined && (typeof detailRef !== 'string' || Buffer.byteLength(detailRef, 'utf8') > 8192)) throw new Error('Invalid subagent detail reference')
    if (!['running', 'succeeded', 'failed', 'cancelled'].includes(tool.status) || typeof tool.name !== 'string'
      || revision !== undefined && (!integer(revision) || revision < 1)) throw new Error('Invalid subagent tool summary')
    const existing = tools.get(tool.id)
    // Build only selected details below. Sorting metadata must not copy every historical output.
    const meta: SubagentToolSummary = { ...tool, revisionSeq: toolRevision(tool, input.lastSeq),
      ordinal: integer((tool as Partial<SubagentToolSummary>).ordinal) ? (tool as SubagentToolSummary).ordinal : index + 1,
      detailRef: (tool as Partial<SubagentToolSummary>).detailRef
        ?? `/subagent/runs/${encodeURIComponent(input.runId)}/tools/${encodeURIComponent(tool.id)}?atSeq=${input.lastSeq}`,
      detailTruncated: (tool as Partial<SubagentToolSummary>).detailTruncated === true }
    if (!existing || recentTools(meta, existing) < 0) tools.set(tool.id, meta)
  })
  if (toolCount < tools.size || activeToolCount < [...tools.values()].filter(tool => tool.status === 'running').length) throw new Error('Subagent counts do not cover resident tools')
  const recent = [...tools.values()].sort(recentTools)
  const latest = recent[0]
  const selected = new Map<string, SubagentToolSummary>()
  for (const tool of recent.filter(tool => tool.status === 'running').slice(0, maxActive)) selected.set(tool.id, tool)
  if (latest && maxTools > 0 && (latest.status !== 'running' || selected.has(latest.id))) selected.set(latest.id, latest)
  for (const tool of recent) {
    if (selected.size >= maxTools) break
    if (tool.status !== 'running') selected.set(tool.id, tool)
  }
  let toolCalls = [...selected.values()].sort(recentTools).map(tool => summarizeSubagentTool(tool, input.runId, input.lastSeq, tool.ordinal))
  const usage = Object.fromEntries(usageKeys.filter(key => input.usage?.[key] !== undefined).map(key => [key, input.usage[key]])) as SubagentRun['usage']
  const view: SubagentRunView = {
    schemaVersion: 2, view: 'summary',
    runId: input.runId, tenantId: input.tenantId, rootSessionId: input.rootSessionId,
    parentSessionId: input.parentSessionId, parentConversationId: input.parentConversationId,
    parentMessageId: input.parentMessageId, parentToolCallId: input.parentToolCallId, childSessionId: input.childSessionId,
    ...(input.parentToolName === undefined ? {} : { parentToolName: input.parentToolName }),
    ...(input.resumeFromRunId === undefined ? {} : { resumeFromRunId: input.resumeFromRunId }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.agentName === undefined ? {} : { agentName: clip(input.agentName, 512) }),
    ...(input.continuation ? { continuation: { readOnly: input.continuation.readOnly,
      ...(input.continuation.role === undefined ? {} : { role: clip(input.continuation.role, 512) }) } } : {}),
    task: clip(input.task, 2048) ?? '', description: clip(input.description, 1024) ?? '', modelId: input.modelId,
    status: input.status, lastSeq: input.lastSeq, createdAt: input.createdAt, updatedAt: input.updatedAt,
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.stopReason === undefined ? {} : { stopReason: clip(input.stopReason, 1024) }),
    ...(input.error ? { error: { code: clip(input.error.code, 256) ?? '', message: clip(input.error.message, 1024) ?? '', retryable: input.error.retryable } } : {}),
    ...(input.resultSummary === undefined ? {} : { resultSummary: clip(input.resultSummary, 8192) }),
    ...(input.partialOutput === undefined ? {} : { partialOutput: clip(input.partialOutput, 8192) }),
    ...(input.externalEffectStatus === undefined ? {} : { externalEffectStatus: input.externalEffectStatus }),
    ...(input.schemaVersion === 2 && input.recoveryRequired ? { recoveryRequired: true } : {}),
    usage, transcriptRef: input.transcriptRef, toolCount, activeToolCount, toolCalls,
    coverage: { asOfSeq: input.lastSeq, toolCount, activeToolCount, includedToolCount: 0,
      includedActiveToolCount: 0, ids: [], hasMore: true, truncated: true, completeness: 'unknown' },
    residentToolCount: toolCalls.length, residentBytes: 0,
  }
  const updateCoverage = () => {
    const completeSource = canonical || input.coverage.completeness === 'complete'
    const complete = completeSource && toolCalls.length === toolCount && !view.recoveryRequired
    view.toolCalls = toolCalls
    view.residentToolCount = toolCalls.length
    view.coverage = { asOfSeq: input.lastSeq, toolCount, includedToolCount: toolCalls.length,
      activeToolCount, includedActiveToolCount: toolCalls.filter(tool => tool.status === 'running').length,
      ids: toolCalls.map(tool => tool.id), hasMore: !complete, truncated: !complete || detailTruncated || toolCalls.some(tool => tool.detailTruncated),
      completeness: input.schemaVersion === 2 && input.coverage.completeness === 'unknown' ? 'unknown' : complete ? 'complete' : 'partial' }
    view.latestActivity = latest ? toolCalls.find(tool => tool.id === latest.id) : undefined
  }
  updateCoverage()
  if (Buffer.byteLength(JSON.stringify(view), 'utf8') > maxBytes) {
    // First discard repeated previews, preserving IDs, revisions and machine status.
    detailTruncated = true
    toolCalls = toolCalls.map(tool => ({ ...tool, args: null, argsPreview: undefined, output: undefined, outputPreview: undefined,
      error: tool.error ? { ...tool.error, message: '' } : undefined, detailTruncated: true }))
    updateCoverage()
    while (toolCalls.length && Buffer.byteLength(JSON.stringify(view), 'utf8') > maxBytes) {
      toolCalls.pop()
      updateCoverage()
    }
    if (Buffer.byteLength(JSON.stringify(view), 'utf8') > maxBytes) throw new Error('Subagent header exceeds projection byte budget')
  }
  view.residentBytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
  view.residentBytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
  if (view.residentBytes > maxBytes) {
    while (toolCalls.length && view.residentBytes > maxBytes) {
      toolCalls.pop()
      detailTruncated = true
      updateCoverage()
      view.residentBytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
    }
    if (view.residentBytes > maxBytes) throw new Error('Subagent header exceeds projection byte budget')
  }
  return view
}

/** Coverage enrichment is independent of the published sequence and never changes billing twice. */
export function mergeSubagentViews(existing: SubagentRunView, incoming: SubagentRunView): SubagentViewMerge {
  const reject = (reason: string, status: 'conflict' | 'invalid' = 'conflict'): SubagentViewMerge => ({ status, view: existing, reason })
  if (!checkedCoverage(existing) || !checkedCoverage(incoming)) return reject('Invalid subagent coverage', 'invalid')
  if (identityKeys.some(key => existing[key] !== incoming[key])) return reject('Subagent identity conflict', 'invalid')
  if (incoming.lastSeq < existing.lastSeq) return { status: 'merged', view: existing }
  if (terminal(existing.status) && existing.status !== incoming.status) return reject('Terminal subagent cannot change outcome')
  if (incoming.lastSeq > existing.lastSeq) return { status: 'merged', view: projectSubagentRunView(incoming) }
  if (existing.status !== incoming.status) return reject('Status conflict at the same subagent sequence')
  for (const key of usageKeys) if (existing.usage[key] !== undefined && incoming.usage[key] !== undefined
    && existing.usage[key] !== incoming.usage[key]) return reject(`Usage conflict at the same subagent sequence: ${key}`)
  for (const key of ['createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'durationMs'] as const)
    if (existing[key] !== undefined && incoming[key] !== undefined && existing[key] !== incoming[key]) return reject(`Header conflict at the same subagent sequence: ${key}`)
  const bothKnown = existing.coverage.completeness !== 'unknown' && incoming.coverage.completeness !== 'unknown'
  if (bothKnown && (existing.toolCount !== incoming.toolCount || existing.activeToolCount !== incoming.activeToolCount)) return reject('Tool count conflict at the same subagent sequence')
  const merged = new Map(existing.toolCalls.map(tool => [tool.id, tool]))
  for (const tool of incoming.toolCalls) {
    if (tool.revisionSeq > incoming.lastSeq) return reject('Future tool revision', 'invalid')
    const previous = merged.get(tool.id)
    if (previous && (previous.name !== tool.name || previous.revisionSeq === tool.revisionSeq && previous.status !== tool.status
      || previous.status !== 'running' && tool.status === 'running' && tool.revisionSeq >= previous.revisionSeq)) return reject('Tool status conflict at the same subagent sequence')
    if (!previous || tool.revisionSeq > previous.revisionSeq || tool.revisionSeq === previous.revisionSeq
      && tool.detailTruncated === false && previous.detailTruncated === true) merged.set(tool.id, tool)
  }
  const preferred = existing.coverage.completeness === 'unknown' ? incoming : existing
  const toolCalls = [...merged.values()]
  const sourceComplete = preferred.coverage.completeness !== 'unknown' && toolCalls.length === preferred.toolCount
    && toolCalls.filter(tool => tool.status === 'running').length === preferred.activeToolCount
  const enriched: SubagentRunView = { ...preferred, usage: { ...existing.usage, ...incoming.usage }, toolCalls,
    recoveryRequired: existing.recoveryRequired && incoming.recoveryRequired || undefined,
    coverage: { ...preferred.coverage, ids: toolCalls.map(tool => tool.id), includedToolCount: toolCalls.length,
      includedActiveToolCount: toolCalls.filter(tool => tool.status === 'running').length,
      hasMore: !sourceComplete, completeness: sourceComplete ? 'complete' : preferred.coverage.completeness } }
  try { return { status: 'merged', view: projectSubagentRunView(enriched) } }
  catch (error) { return reject(error instanceof Error ? error.message : 'Invalid merged subagent view', 'invalid') }
}

/** A delta can advance only the exact cached prefix. Gaps never apply future header or usage fields. */
export function applySubagentDelta(existing: SubagentRunView | undefined, event: SubagentDeltaEvent): SubagentDeltaReduction {
  const invalid = (reason: string): SubagentDeltaReduction => ({ status: 'invalid', ...(existing ? { view: existing } : {}), reason })
  if (event.schemaVersion !== 2 || !integer(event.seq) || !integer(event.baseSeq) || event.seq !== event.baseSeq + 1
    || !event.identity || typeof event.runId !== 'string' || !event.runId
    || identityKeys.some(key => key !== 'runId' && typeof event.identity[key] !== 'string')) return invalid('Invalid subagent delta sequence or identity')
  if (!['created', 'started', 'cancelling', 'tool.started', 'tool.completed', 'usage.updated', 'output.updated', 'finished'].includes(event.kind)
    || ['tool.started', 'tool.completed'].includes(event.kind) && !event.toolUpsert) return invalid('Invalid subagent delta kind or missing tool')
  if (existing && (existing.runId !== event.runId || identityKeys.some(key => key !== 'runId' && existing[key] !== event.identity[key]))) return invalid('Subagent delta identity mismatch')
  const patch = event.headerPatch ?? {}
  if (identityKeys.some(key => key === 'runId' ? patch.runId !== undefined && patch.runId !== event.runId
    : patch[key] !== undefined && patch[key] !== event.identity[key])) return invalid('Subagent delta header identity mismatch')
  if (patch.lastSeq !== undefined && patch.lastSeq !== event.seq) return invalid('Subagent delta header sequence mismatch')
  if (event.toolUpsert && (event.toolUpsert.revisionSeq !== event.seq || !integer(event.toolUpsert.ordinal)
    || event.toolUpsert.ordinal < 1 || !event.toolUpsert.id)) return invalid('Invalid subagent tool delta revision')
  if (existing && event.seq < existing.lastSeq) return { status: 'verified-duplicate', view: existing }
  if (existing && event.seq === existing.lastSeq) {
    if (patch.status !== undefined && patch.status !== existing.status) return invalid('Conflicting duplicate subagent status')
    for (const key of usageKeys) if (patch.usage?.[key] !== undefined && existing.usage[key] !== patch.usage[key]) return invalid('Conflicting duplicate subagent usage')
    const previous = event.toolUpsert && existing.toolCalls.find(tool => tool.id === event.toolUpsert!.id)
    if (previous && previous.revisionSeq === event.toolUpsert!.revisionSeq && previous.status !== event.toolUpsert!.status) return invalid('Conflicting duplicate subagent tool')
    for (const key of ['toolCount', 'activeToolCount', 'updatedAt', 'createdAt', 'startedAt', 'finishedAt'] as const)
      if (patch[key] !== undefined && existing[key] !== patch[key]) return invalid('Conflicting duplicate subagent header')
    if (event.toolUpsert && !previous) return { status: 'gap', view: { ...existing, recoveryRequired: true },
      reason: 'Duplicate tool delta is outside the verified resident coverage' }
    return { status: 'verified-duplicate', view: existing }
  }
  if (existing && (existing.lastSeq !== event.baseSeq || existing.recoveryRequired)) return { status: 'gap',
    view: { ...existing, recoveryRequired: true }, reason: 'Subagent delta base sequence is unavailable' }
  if (!existing && (event.baseSeq !== 0 || !event.header || event.kind !== 'created')) return { status: 'gap', reason: 'Subagent delta creation header is unavailable' }
  if (event.header && (event.header.runId !== event.runId || event.header.lastSeq !== event.seq
    || identityKeys.some(key => key !== 'runId' && event.header![key] !== event.identity[key]))) return invalid('Subagent creation header mismatch')
  const header = { ...(existing ?? event.header!), ...patch, schemaVersion: 2 as const, view: 'summary' as const,
    runId: event.runId, ...event.identity, lastSeq: event.seq }
  if (existing && terminal(existing.status) && header.status !== existing.status) return invalid('Terminal subagent delta cannot change status')
  const tools = new Map((existing?.toolCalls ?? []).map(tool => [tool.id, tool]))
  if (event.toolUpsert) {
    const previous = tools.get(event.toolUpsert.id)
    if (previous && previous.status !== 'running' && event.toolUpsert.status === 'running') return invalid('Terminal tool delta cannot return to running')
    tools.set(event.toolUpsert.id, event.toolUpsert)
  }
  if (event.kind === 'finished' && terminal(header.status) && header.activeToolCount === 0) {
    for (const [id, tool] of tools) if (tool.status === 'running') tools.set(id, {
      ...tool, status: 'cancelled', revisionSeq: event.seq, finishedAt: header.finishedAt ?? header.updatedAt,
      detailRef: `/subagent/runs/${encodeURIComponent(event.runId)}/tools/${encodeURIComponent(id)}?atSeq=${event.seq}`,
    })
  }
  const toolCalls = [...tools.values()]
  const complete = (!existing || existing.coverage.completeness === 'complete') && toolCalls.length === header.toolCount
  const coverage: SubagentCoverage = { asOfSeq: event.seq, toolCount: header.toolCount, activeToolCount: header.activeToolCount,
    includedToolCount: toolCalls.length, includedActiveToolCount: toolCalls.filter(tool => tool.status === 'running').length,
    ids: toolCalls.map(tool => tool.id), completeness: complete ? 'complete' : existing?.coverage.completeness === 'unknown' ? 'unknown' : 'partial',
    hasMore: !complete, truncated: !complete }
  if (event.coverage && (event.coverage.asOfSeq !== event.seq || event.coverage.toolCount !== header.toolCount
    || event.coverage.activeToolCount !== header.activeToolCount)) return invalid('Subagent delta coverage mismatch')
  try { return { status: 'applied', view: projectSubagentRunView({ ...header, toolCalls, coverage }) } }
  catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid subagent delta view') }
}
