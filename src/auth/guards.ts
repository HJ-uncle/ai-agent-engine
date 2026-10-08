/**
 * RBAC 路由守卫
 *
 * 基于 AuthContext.roles 的角色检查。设计约定：
 *  - AUTH_ENABLED=false（本地开发/零配置模式）：放行，不检查角色
 *  - 凭证缺失（method='none'）且 AUTH_ENABLED=true：拒绝
 *  - roles 未声明：视为普通用户，拒绝管理操作
 *  - roles 与要求角色有交集：放行
 */

import type { FastifyReply, FastifyRequest } from 'fastify'
import { fail } from '../api/http/response.js'
import type { AuthContext } from './types.js'

export const ERROR_FORBIDDEN = 41015

/**
 * 创建要求任一角色通过的 Fastify preHandler。
 * @param roles 允许通过的角色列表（任一匹配即可）
 */
export function requireRoles(...roles: string[]) {
  return async function requireRolesHandler(request: FastifyRequest, reply: FastifyReply) {
    // 本地开发模式（零配置哲学）：与全局鉴权降级保持一致
    const authContext = (request as any).authContext as AuthContext | undefined
    // Local mode may have no context at all.  Never let a previously
    // authenticated non-admin context become admin merely because a mutable
    // environment value changed while the server was running.
    if (process.env.AUTH_ENABLED === 'false' && (!authContext || authContext.method === 'none')) return
    if (!authContext || authContext.method === 'none') {
      return reply.code(200).send(fail(ERROR_FORBIDDEN, '该操作需要登录后执行'))
    }

    const userRoles = authContext.roles ?? []
    const allowed = roles.some((r) => userRoles.includes(r))
    if (!allowed) {
      return reply.code(200).send(
        fail(ERROR_FORBIDDEN, `权限不足：需要以下角色之一 [${roles.join(', ')}]`),
      )
    }
  }
}

/** skill 导入默认要求的角色 */
export const SKILL_IMPORT_ROLES = ['admin', 'skill-manager']
