import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { adminErrorReply, adminRead, adminWrite, requireAdminPermission, registerAdminSchema, AdminHttpError } from './rbac-access.js'
import type { AdminMonitorSnapshot } from './monitor.js'
import { listRules, readRule, newRule, updateRule, deleteRule, restoreRules, ruleArchive, ruleSchema, ruleMetrics, evaluateRules } from './rules-store.js'

export function registerRuleRoutes(app: FastifyInstance, measure: () => Promise<AdminMonitorSnapshot>): void {
  registerAdminSchema(app, 'monitor_rules_v1', ruleSchema)
  app.get('/admin/rules', (req, reply) => adminRead(req, reply, 'rules.read', async tx => ({ items: await listRules(tx), metrics: ruleMetrics })))
  app.get<{Params:{id:string}}>('/admin/rules/:id', (req, reply) => adminRead(req, reply, 'rules.read', tx => readRule(tx,req.params.id)))
  app.post('/admin/rules', {bodyLimit:4096}, (req, reply) => {
    const id = randomUUID(); return adminWrite(req,reply,'rules.manage','rule.create',id,tx => newRule(tx,req.body,id))
  })
  app.patch<{Params:{id:string}}>('/admin/rules/:id', {bodyLimit:4096}, (req,reply) => adminWrite(req,reply,'rules.manage','rule.update',req.params.id,tx => updateRule(tx,req.params.id,req.body)))
  app.delete<{Params:{id:string};Querystring:{revision?:string}}>('/admin/rules/:id', (req,reply) => adminWrite(req,reply,'rules.manage','rule.delete',req.params.id,tx => deleteRule(tx,req.params.id,req.query.revision)))
  app.get('/admin/rules/archive', (req,reply) => adminRead(req,reply,'rules.read',async tx => ruleArchive(await listRules(tx))))
  app.post('/admin/rules/restore', {bodyLimit:64*1024}, (req,reply) => adminWrite(req,reply,'rules.manage','rule.restore',null,tx => restoreRules(tx,req.body)))
  app.get('/admin/rules/evaluation', async (req,reply) => {
    const actor = await requireAdminPermission(req,reply,'rules.read'); if (!actor) return reply
    if (!actor.permissions.includes('metrics.read') && !await requireAdminPermission(req,reply,'metrics.read')) return reply
    // Sampling does not hold a database transaction; re-evaluate both grants before returning any live data.
    try {
      const sample = await measure()
      return adminRead(req,reply,'rules.read',async (tx,live) => {
        if (!live.permissions.includes('metrics.read')) throw new AdminHttpError(403,'没有查看指标的权限。','permission_denied')
        return evaluateRules(await listRules(tx),sample)
      })
    } catch(error) { return adminErrorReply(reply,error) }
  })
}
