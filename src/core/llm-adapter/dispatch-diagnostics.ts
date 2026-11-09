import { createHash } from 'node:crypto'
import type { Logger } from 'pino'
import { MUTATION_REPETITION_PROMPT, READONLY_REPETITION_PROMPT, WORKFLOW_REVIEW_PROMPT } from '../agent-loop/tool-progress.js'
import type { LLMRequestAttemptEvent, RequestDispatchDiagnosticV2, RequestDispatchStage } from './types.js'
import { requestContextMessage } from './request-context.js'

function systemText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap(block => block && typeof block === 'object' && typeof block.text === 'string'
    ? [block.text] : []).join('\n')
}

/** Local final-wire evidence is separate from a provider receipt; task bodies never leave this helper. */
export function requestDispatchDiagnostic(
  request: { messages?: unknown; system?: unknown }, requestStage: RequestDispatchStage = 'unknown', requestContext?: string,
): RequestDispatchDiagnosticV2 {
  const messages = Array.isArray(request.messages) ? request.messages : []
  const systemMessages = messages.filter(message => message && typeof message === 'object'
    && (message.role === 'system' || message.role === 'developer'))
  const common = { schemaVersion: 2 as const, requestStage, wireMessageCount: messages.length }
  try {
    const wireSystem = { system: request.system ?? null,
      messages: systemMessages.map(message => ({ role: message.role, content: message.content })) }
    // Only the engine-supplied context that survived final wire serialization
    // can set advisory flags. Matching arbitrary user/tool prose is not proof.
    const expectedTail = requestContext ? requestContextMessage(requestContext).content : undefined
    const last = messages.at(-1)
    const tail = last?.role === 'assistant' && last.prefix === true ? messages.at(-2) : last
    const wireTail = tail?.role === 'user' && (typeof tail.content === 'string' ? tail.content
      : Array.isArray(tail.content) && tail.content.at(-1)?.type === 'text' ? tail.content.at(-1).text : undefined)
    const trustedTail = expectedTail && wireTail === expectedTail ? expectedTail : ''
    const text = [systemText(request.system), ...systemMessages.map(message => systemText(message.content)), trustedTail].join('\n')
    return { ...common, availability: 'captured',
      systemPromptSha256: createHash('sha256').update(JSON.stringify(wireSystem)).digest('hex'),
      workflowHintPresent: text.includes(WORKFLOW_REVIEW_PROMPT),
      readonlyHintPresent: text.includes(READONLY_REPETITION_PROMPT),
      mutationHintPresent: text.includes(MUTATION_REPETITION_PROMPT) }
  } catch {
    return { ...common, availability: 'unavailable' }
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Keep a bounded allowlist even if a future callback carries request bodies or credentials. */
export function logRequestDispatch(
  event: LLMRequestAttemptEvent, logger: Pick<Logger, 'info'> & Partial<Pick<Logger, 'child'>>, owner?: { subagentRunId: string },
): void {
  if (event.type !== 'start' || !uuid.test(event.requestAttemptId)) return
  const diagnostic = event.dispatchDiagnostic
  const systemPromptSha256 = diagnostic?.systemPromptSha256
  const validHash = typeof systemPromptSha256 === 'string' && /^[a-f0-9]{64}$/.test(systemPromptSha256)
  const schemaVersion = diagnostic?.schemaVersion === 2 ? 2 : 1
  const validVersion = diagnostic?.schemaVersion === 1 || diagnostic?.schemaVersion === 2
  const requestStage = diagnostic?.requestStage === 'normal' || diagnostic?.requestStage === 'finalization'
    ? diagnostic.requestStage : 'unknown'
  const validCount = typeof diagnostic?.wireMessageCount === 'number'
    && Number.isSafeInteger(diagnostic.wireMessageCount) && diagnostic.wireMessageCount >= 0
  const wireMessageCount = validCount ? diagnostic!.wireMessageCount : 0
  const captured = diagnostic?.availability === 'captured' && validVersion && validHash && validCount
  try {
    // Root/request loggers retain their configured level. Only this allowlisted
    // record opts into info, so LOG_LEVEL=warn cannot hide dispatch evidence.
    const sink = typeof logger.child === 'function' ? logger.child({}, { level: 'info' }) : logger
    sink.info({ event: 'llm.dispatch.start', requestAttemptId: event.requestAttemptId, schemaVersion,
      availability: captured ? 'captured' : 'unavailable', requestStage, wireMessageCount,
      ...(captured ? { systemPromptSha256 } : {}),
      ...(captured && typeof diagnostic?.workflowHintPresent === 'boolean' ? { workflowHintPresent: diagnostic.workflowHintPresent } : {}),
      ...(captured && typeof diagnostic?.readonlyHintPresent === 'boolean' ? { readonlyHintPresent: diagnostic.readonlyHintPresent } : {}),
      ...(captured && diagnostic?.schemaVersion === 2 && typeof diagnostic.mutationHintPresent === 'boolean' ? { mutationHintPresent: diagnostic.mutationHintPresent } : {}),
      ...(owner && uuid.test(owner.subagentRunId) ? { subagentRunId: owner.subagentRunId } : {}),
    }, 'Local adapter request start; provider receipt is not implied')
  } catch { /* Diagnostic persistence cannot prevent an admitted request from running. */ }
}
