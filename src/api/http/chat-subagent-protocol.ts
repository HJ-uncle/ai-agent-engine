import type { FastifyRequest } from 'fastify'
import type { SubagentRun, SubagentRunView } from '../../core/subagent/types.js'
import { sessionSubagentRunsAtWatermark } from './chat-usage.js'

/** Absence preserves the complete v1 contract; malformed opt-ins are rejected. */
export function getRequestSubagentProtocol(request: Pick<FastifyRequest, 'headers'>): 1 | 2 {
  const value = request.headers['x-aether-subagent-protocol']
  if (value === undefined) return 1
  if (value === '2') return 2
  throw Object.assign(new Error('X-Aether-Subagent-Protocol must be 2'), { statusCode: 400 })
}

export function publishedSubagentRuns(runs: (SubagentRun | SubagentRunView)[],
  published: (SubagentRun | SubagentRunView)[], ctx: { tenantId: string; sessionId: string },
  protocol: 1 | 2, activeTurnId?: string): (SubagentRun | SubagentRunView)[] {
  if (protocol === 2) return sessionSubagentRunsAtWatermark(runs, ctx, activeTurnId,
    published.map(snapshot => ({ subagentEvent: { snapshot } })))
  const visible = new Map<string, SubagentRun>()
  for (const run of [...runs.filter(item => activeTurnId === undefined || item.parentConversationId !== activeTurnId),
    ...published.filter(item => activeTurnId !== undefined && item.parentConversationId === activeTurnId)]) {
    if (run.tenantId !== ctx.tenantId || run.parentSessionId !== ctx.sessionId) continue
    if (run.schemaVersion !== 1) throw Object.assign(new Error('SUBAGENT_RECOVERY_REQUIRED: Complete legacy snapshot is unavailable'), { statusCode: 409 })
    const previous = visible.get(run.runId)
    if (!previous || previous.lastSeq < run.lastSeq) visible.set(run.runId, run)
  }
  return [...visible.values()]
}

/** Legacy viewers receive exact canonical records, never relabelled bounded views. */
export function subagentProjectionForViewer(projection: Record<string, unknown>[],
  published: (SubagentRun | SubagentRunView)[], protocol: 1 | 2): Record<string, unknown>[] {
  const byId = new Map(published.map(run => [run.runId, run]))
  const canonical = (value: unknown): SubagentRun | SubagentRunView => {
    const data = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
    const run = typeof data?.runId === 'string' ? byId.get(data.runId) : undefined
    if (!run || run.schemaVersion !== protocol) throw Object.assign(new Error('SUBAGENT_RECOVERY_REQUIRED: Projection watermark is unavailable'), { statusCode: 409 })
    return run
  }
  return projection.map(envelope => {
    const event = envelope.subagentEvent as { runId?: string; kind?: string; seq?: number; snapshot?: unknown } | undefined
    if (event) {
      const run = canonical(event.snapshot ?? event)
      return { ...envelope, subagentEvent: protocol === 2
        ? { schemaVersion: 2, kind: 'snapshot', runId: run.runId, seq: run.lastSeq, view: run }
        : { schemaVersion: 1, kind: event.kind ?? 'output.updated', runId: run.runId, seq: run.lastSeq, snapshot: run } }
    }
    for (const field of ['toolResult', 'toolEnd']) {
      const tool = envelope[field] as { subagent?: unknown; metadata?: Record<string, unknown> } | undefined
      if (tool?.subagent) return { ...envelope, [field]: { ...tool, subagent: canonical(tool.subagent) } }
      if (tool?.metadata?.subagent) return { ...envelope, [field]: { ...tool, metadata: { ...tool.metadata, subagent: canonical(tool.metadata.subagent) } } }
    }
    return envelope
  })
}
