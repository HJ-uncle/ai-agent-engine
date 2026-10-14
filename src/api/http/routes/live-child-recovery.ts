import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Client } from '@libsql/client'
import { getDb } from '../../../storage/sqlite/db.js'
import { ChildRecoveryRequiredError, requireChildRecovery } from '../../../core/subagent/child-usage-authority.js'
import { PublishedRecoveryLeases } from '../../../core/subagent/recovery-leases.js'
import { PUBLISHED_CHILD_PAGE_BYTES } from '../../../core/subagent/published-store.js'
import { fail } from '../response.js'

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
export function checkedChildEnvelope<T>(value: T): T {
  if (bytes(value) > PUBLISHED_CHILD_PAGE_BYTES) requireChildRecovery('response_budget')
  return value
}
/** Recovery errors describe observation only. No provider/storage error text or
 * attacker-controlled identity can inflate the failure envelope. */
export function sendChildRecoveryFailure(reply: FastifyReply, error: unknown) {
  const reason = error instanceof ChildRecoveryRequiredError ? error.reason : 'evidence_unavailable'
  return reply.code(409).send(checkedChildEnvelope(fail(40901, 'Child recovery required', { recoveryRequired: true, reason })))
}
export { childProjectionReferences } from '../../../core/subagent/child-recovery-projection.js'
const services = new WeakMap<Client, PublishedRecoveryLeases>()
export function childRecoveryService(): PublishedRecoveryLeases {
  const db = getDb(); let service = services.get(db)
  if (!service) { service = new PublishedRecoveryLeases(db); services.set(db, service) }
  return service
}
type ReaderQuery = { sessionId?: string; snapshotId?: string; cursor?: string; limit?: string; part?: string; childRecoveryProtocol?: string }
function reader(request: FastifyRequest<{ Querystring: ReaderQuery }>) {
  const { sessionId, snapshotId, childRecoveryProtocol, cursor, limit } = request.query
  if (childRecoveryProtocol !== '1' || typeof sessionId !== 'string' || !sessionId || typeof snapshotId !== 'string' || !snapshotId) requireChildRecovery('invalid_selector')
  if (limit !== undefined && (typeof limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(limit))) requireChildRecovery('invalid_limit')
  const tenantId = (request as FastifyRequest & { authContext?: { tenantId?: string } }).authContext?.tenantId ?? 'default'
  return { auth: { tenantId, parentSessionId: sessionId }, snapshotId, cursor: cursor ?? null, limit: limit === undefined ? 64 : Number(limit) }
}
/** Page authority comes entirely from the signed lease and trusted actor. Query
 * owner/tenant/attempt/stream fields are not accepted as alternate selectors. */
export function registerChildRecoveryPages(app: FastifyInstance, enabled: boolean): void {
  app.get<{Querystring:ReaderQuery}>('/chat/snapshot/body',async(request,reply)=>{
    try{
      if(!enabled)requireChildRecovery('protocol_unavailable')
      const selected=reader(request),part=request.query.part
      if(selected.cursor!==null||part!==undefined&&(typeof part!=='string'||!/^(0|[1-9][0-9]{0,3})$/.test(part)))requireChildRecovery('invalid_selector')
      return reply.send(checkedChildEnvelope(await childRecoveryService().body(selected.auth,selected.snapshotId,part===undefined?0:Number(part))))
    }catch(error){return sendChildRecoveryFailure(reply,error)}
  })
  app.get<{ Querystring: ReaderQuery }>('/chat/snapshot/children', async (request, reply) => {
    try {
      if (!enabled) requireChildRecovery('protocol_unavailable')
      const selected = reader(request)
      return reply.send(checkedChildEnvelope(await childRecoveryService().read(selected.auth, selected.snapshotId, selected.cursor, selected.limit)))
    } catch (error) { return sendChildRecoveryFailure(reply, error) }
  })
  app.get<{ Querystring: ReaderQuery; Params: { runId: string } }>('/chat/snapshot/children/:runId', async (request, reply) => {
    try {
      if (!enabled) requireChildRecovery('protocol_unavailable')
      const selected = reader(request)
      if (selected.cursor !== null) requireChildRecovery('invalid_selector')
      const result = await childRecoveryService().lookup(selected.auth, selected.snapshotId, request.params.runId)
      return reply.send(checkedChildEnvelope({ code: 200, message: 'OK', timestamp: Date.now(), data: { protocolVersion: 1, ...result } }))
    } catch (error) { return sendChildRecoveryFailure(reply, error) }
  })
  app.get<{ Querystring: ReaderQuery }>('/chat/snapshot/projection', async (request, reply) => {
    try {
      if (!enabled) requireChildRecovery('protocol_unavailable')
      const selected = reader(request)
      return reply.send(checkedChildEnvelope(await childRecoveryService().projection(selected.auth, selected.snapshotId, selected.cursor, selected.limit)))
    } catch (error) { return sendChildRecoveryFailure(reply, error) }
  })
}
