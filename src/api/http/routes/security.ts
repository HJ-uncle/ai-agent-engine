import type { FastifyInstance } from 'fastify'
import { success, fail, paginateArray } from '../response.js'
import { policyEngine, type PolicyRule } from '../../../security/policy-engine.js'
import { auditLogStore, type AuditCategory, type AuditDecision } from '../../../security/audit-log.js'
import {
  loadNetworkPolicy, saveNetworkPolicy, DEFAULT_NETWORK_POLICY, type NetworkPolicy,
} from '../../../security/network-policy.js'

export async function securityRoutes(fastify: FastifyInstance) {
  // ── Policy rules CRUD ────────────────────────────────────────────────
  fastify.get<{ Querystring: { current?: number; pageSize?: number } }>(
    '/security/policies',
    async (request, reply) => {
      const rules = await policyEngine.listRules()
      return reply.code(200).send(paginateArray(rules, request.query.current, request.query.pageSize))
    },
  )

  fastify.post<{ Body: PolicyRule }>('/security/policies', async (request, reply) => {
    const rule = await policyEngine.upsertRule({ ...request.body, id: undefined })
    return reply.code(200).send(success(rule))
  })

  fastify.put<{ Params: { id: string }; Body: Partial<PolicyRule> }>(
    '/security/policies/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10)
      const rules = await policyEngine.listRules()
      const existing = rules.find((r) => r.id === id)
      if (!existing) return reply.code(200).send(fail(40400, `规则不存在: ${id}`))
      const merged: PolicyRule = { ...existing, ...request.body, id }
      const saved = await policyEngine.upsertRule(merged)
      return reply.code(200).send(success(saved))
    },
  )

  fastify.delete<{ Params: { id: string } }>('/security/policies/:id', async (request, reply) => {
    await policyEngine.deleteRule(parseInt(request.params.id, 10))
    return reply.code(200).send(success({ deleted: true }))
  })

  fastify.post('/security/policies/reset', async (_request, reply) => {
    await policyEngine.resetDefaults()
    return reply.code(200).send(success({ reset: true }))
  })

  // ── Audit log ───────────────────────────────────────────────────────
  fastify.get<{
    Querystring: {
      current?: number; pageSize?: number
      category?: AuditCategory; decision?: AuditDecision; since?: number
    }
  }>('/security/audit-log', async (request, reply) => {
    const { current = 1, pageSize = 50, category, decision, since } = request.query
    const tenantId = (request as any).authContext?.tenantId
    const offset = (Number(current) - 1) * Number(pageSize)
    const { list, total } = await auditLogStore.query({
      tenantId, category, decision, since,
      limit: Number(pageSize), offset,
    })
    return reply.code(200).send({
      code: 200,
      message: 'ok',
      data: list,
      pagination: {
        current: Number(current),
        pageSize: Number(pageSize),
        total,
        totalPages: Math.ceil(total / Number(pageSize)),
      },
      timestamp: Date.now(),
    })
  })

  fastify.delete<{ Querystring: { days?: number } }>('/security/audit-log', async (request, reply) => {
    const days = Math.max(1, parseInt(String(request.query.days ?? 30), 10))
    const removed = await auditLogStore.purgeOlderThan(days)
    return reply.code(200).send(success({ removed, days }))
  })

  // ── Network policy ──────────────────────────────────────────────────
  fastify.get('/security/network-policy', async (_request, reply) => {
    const policy = await loadNetworkPolicy()
    return reply.code(200).send(success(policy))
  })

  fastify.put<{ Body: NetworkPolicy }>('/security/network-policy', async (request, reply) => {
    // 合并用户提交字段和默认值，做简单校验
    const policy: NetworkPolicy = {
      ...DEFAULT_NETWORK_POLICY,
      ...request.body,
      allowedProtocols: Array.isArray(request.body.allowedProtocols) && request.body.allowedProtocols.length > 0
        ? request.body.allowedProtocols
        : DEFAULT_NETWORK_POLICY.allowedProtocols,
    }
    await saveNetworkPolicy(policy)
    return reply.code(200).send(success(policy))
  })

  fastify.post('/security/network-policy/reset', async (_request, reply) => {
    await saveNetworkPolicy({ ...DEFAULT_NETWORK_POLICY })
    return reply.code(200).send(success(DEFAULT_NETWORK_POLICY))
  })
}
