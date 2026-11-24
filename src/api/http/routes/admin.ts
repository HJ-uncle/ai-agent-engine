import { readFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { getStartupInstanceTokenState } from '../../../auth/instance-token.js'
import { getRuntimeIdentity } from '../../../runtime/identity.js'
import { ADMIN_HTML, DESKTOP_ADMIN_HTML, ADMIN_CSS, ADMIN_JS } from '../admin/page.js'
import { adminShell } from '../admin/surface.js'
import { isRequestAuthenticationRequired } from '../middleware.js'
import { adminErrorReply, requireAdminPermission } from '../admin/rbac-access.js'
import { registerRuleRoutes } from '../admin/rules-routes.js'
import { registerFamilyAdminRoutes } from '../admin/account-routes.js'
import { adminRbacRoutes } from './admin-rbac.js'
import { createAdminMonitor } from '../admin/monitor.js'
import { success } from '../response.js'

const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()

export async function adminRoutes(fastify: FastifyInstance) {
  fastify.get(adminShell.redirect, (_req, reply) => reply.redirect(adminShell.page, 308))
  // The entry hint only selects the initial view. It is public and grants no permissions.
  fastify.get(adminShell.page, (req, reply) => reply.header('X-Aether-Admin-Surface', '1').header('X-Aether-Admin-Desktop', '1')
    .header('Vary', 'X-Aether-Admin-Entry').type('text/html; charset=utf-8').send(req.headers['x-aether-admin-entry'] === 'current' ? DESKTOP_ADMIN_HTML : ADMIN_HTML))
  let icon: Buffer | undefined
  fastify.get(adminShell.icon, async (_req, reply) => reply.type('image/png').send(icon ??= await readFile(new URL('../admin/icon.png', import.meta.url))))
  fastify.get(adminShell.script, (_req, reply) => reply.type('text/javascript; charset=utf-8').send(ADMIN_JS))
  fastify.get(adminShell.style, (_req, reply) => reply.type('text/css; charset=utf-8').send(ADMIN_CSS))

  const measure = createAdminMonitor()
  registerRuleRoutes(fastify, measure)
  await adminRbacRoutes(fastify)
  registerFamilyAdminRoutes(fastify)
  fastify.get('/admin/monitor', async (request, reply) => {
    if (!await requireAdminPermission(request, reply, 'metrics.read')) return reply
    try { return reply.send(success(await measure())) } catch (error) { return adminErrorReply(reply,error) }
  })
  fastify.get('/admin/status', async (request, reply) => {
    if (!await requireAdminPermission(request, reply, 'status.read')) return reply
    return reply.send(success({
      version: getRuntimeIdentity().version,
      instanceToken: getStartupInstanceTokenState(),
      authenticationRequired: isRequestAuthenticationRequired(),
      startedAt, uptimeSeconds: Math.floor(process.uptime()),
    }))
  })
}
