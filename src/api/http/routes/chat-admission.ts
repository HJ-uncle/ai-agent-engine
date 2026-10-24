import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthContext } from '../../../auth/types.js'
import type { RootRunStore } from '../../../storage/root-runs/index.js'
import type { ConversationHistory } from '../../../core/agent-context/types.js'
import { admissionError, validateNamespace } from '../../../storage/root-admission/index.js'
import { readAdmissionSeed, projectTerminalAdmissionUsers } from '../../../storage/root-admission/projection.js'
import { withHistoryLock } from '../../../storage/conversation/serialization.js'
import { success } from '../response.js'
import { getRequestToolProfile, getRequestRunLifetime } from '../tool-profile.js'
import { getRequestSubagentProtocol } from '../chat-subagent-protocol.js'

/** Uses the same trusted middleware actor as /chat; body/query tenant fields are never authority. */
const tenantFrom = (request: FastifyRequest) => (request as FastifyRequest & { authContext?: AuthContext }).authContext?.tenantId ?? 'default'
interface ReceiptBody { sessionId: string; namespace: { id: string; generation: string }; requestKey: string; bodyDigest: string }
export async function registerUserAdmissionRoutes(app: FastifyInstance, roots: RootRunStore, history: ConversationHistory): Promise<void> {
  app.get<{ Querystring: { sessionId: string } }>('/chat/admission/context', { schema: { querystring: {
    type: 'object', required: ['sessionId'], additionalProperties: false, properties: { sessionId: { type: 'string', minLength: 1, maxLength: 256 } },
  } } }, async request => {
    const tenantId = tenantFrom(request), sessionId = request.query.sessionId
    const context = await roots.userAdmissionContext(tenantId, sessionId)
    return success({ protocolVersion: 1, tenantId, sessionId,
      transport: { toolProfile: getRequestToolProfile(request), runLifetime: getRequestRunLifetime(request), subagentProtocol: getRequestSubagentProtocol(request) },
      ...context })
  })
  app.post<{ Body: ReceiptBody }>('/chat/admission/receipt', { schema: { body: {
    type: 'object', required: ['sessionId', 'namespace', 'requestKey', 'bodyDigest'], additionalProperties: false,
    properties: { sessionId: { type: 'string', minLength: 1, maxLength: 256 }, requestKey: { type: 'string', minLength: 1, maxLength: 256 },
      bodyDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, namespace: { type: 'object', additionalProperties: false, required: ['id', 'generation'],
        properties: { id: { type: 'string', minLength: 1, maxLength: 256 }, generation: { type: 'string', minLength: 1, maxLength: 256 } } } },
  } } }, async request => {
    return withHistoryLock(tenantFrom(request), async () => {
    const tenantId = tenantFrom(request), { sessionId, requestKey, bodyDigest } = request.body
    const namespace = validateNamespace(request.body.namespace)
    const accepted = await roots.findUserAdmission(tenantId, sessionId, { namespace, requestKey, bodyDigest })
    if (!accepted) return success({ protocolVersion: 1, namespace, sessionId, requestKey, status: 'absent' as const })
    const scope = { tenantId, sessionId }, db = await roots.admissionDatabase()
    await projectTerminalAdmissionUsers(db, history, scope, accepted.run.runId)
    const seed = await readAdmissionSeed(db, scope, accepted.run.runId)
    // The reserved ID is not proof of an assistant transcript row. Keep the
    // observed final projection identity separate and tag its root revision.
    const assistant = await history.getMessageById(accepted.run.assistantMessageId, tenantId, accepted.run.sessionId)
    if (assistant && (assistant.role !== 'assistant' || assistant.conversationId !== accepted.run.turnId)) admissionError('ADMISSION_ASSISTANT_PROJECTION_CONFLICT', 503)
    return success({ protocolVersion: 1, status: 'accepted' as const, receipt: accepted.receipt, run: roots.public(accepted.run),
      projection: { rootVersion: accepted.run.version, rootAttemptId: accepted.attemptId,
        user: { messageId: seed.anchor.userMessageId, state: seed.projected ? 'projected' as const : 'pending' as const },
        assistant: { anchorMessageId: seed.anchor.assistantAnchorId, state: assistant ? 'persisted' as const : 'unwritten' as const,
          ...(assistant ? { messageId: assistant.id } : {}) } } })
    })
  })
}
