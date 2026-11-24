import { revalidateAccountAuth } from '../../auth/accounts.js'
import { configureDesktopOwnership, isOwnedDesktopRequest } from './desktop-ownership.js'
export { isOwnedDesktopRequest } from './desktop-ownership.js'
import { isPublicAccountRoute } from './routes/accounts.js'
import { isPublicExternalAccountRoute, isExternalAccountCallback } from './routes/account-external.js'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { fail } from './response.js'
import { ADMIN_HEADER, adminKeyInWorkloadHeaders } from '../../auth/admin-key-format.js'
import { auditAdminGateDenial, requireAdminPermission } from './admin/rbac-access.js'
import { adminHeaders, isAdminPath, isPublicAdminShell } from './admin/surface.js'
import { logger } from '../../observability/index.js'
import type { AuthMiddleware } from '../../auth/types.js'
import { createAuthMiddleware } from '../../auth/index.js'
import { configureInstanceToken, hasValidInstanceToken, hasOwnedInstanceToken, isPublicInstanceProbe } from '../../auth/instance-token.js'
import type { AuthContext } from '../../auth/types.js'
import { browserAuthorityFromTrustedState, type BrowserHostAuthority } from '../../core/browser-authority.js'
import { getRuntimeIdentity } from '../../runtime/identity.js'
import { controllerSubject, type ControllerSubject } from '../../core/collaboration/controller-origin.js'
import { INTERNAL_CONTINUATION_HEADER, resolveInternalContinuation } from './internal-continuation.js'

// White listed paths that do not require login state (reserved for future JWT)
// Also we bypass header checks for standard health checks to avoid breaking internal ops
// 只有不返回租户数据的存活探针公开；实例令牌（如配置）仍由 auth hook 校验。
export const WHITELIST_PATHS = ['/health', '/meta']

// The server replaces this during build, after all startup configuration has
// been applied.  Keeping a fallback makes isolated route tests deterministic.
let authMiddleware: AuthMiddleware = createAuthMiddleware()
let authenticationRequired = process.env.AUTH_ENABLED !== 'false'

export interface RequestAuthenticationStartup {
  /** Actual host passed to listen(), captured before project settings are loaded. */
  listenHost?: string
  /** Process-launcher decision; never derive this from a request or business settings. */
  desktopOwned?: boolean
}

/** A local session capability, not an instance-admin role or a replacement tenant. */
export function canUseDesktopSessionFullAccess(request: FastifyRequest): boolean {
  const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  return !!auth && auth.method !== 'none' && auth.roles?.includes('tenant-admin') === true && isOwnedDesktopRequest(request)
}

/** Read the same frozen boundary used by the request gate; settings cannot enable dispatch. */
export function isRequestAuthenticationRequired(): boolean { return authenticationRequired }

/** Authenticated actor or a configured process-local gate, never a supplied body authority. */
export function browserAuthorityFromRequest(request: FastifyRequest): BrowserHostAuthority | undefined {
  const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  return browserAuthorityFromTrustedState(auth, { authenticationRequired, gateVerified: hasOwnedInstanceToken(request.headers),
    instanceId: getRuntimeIdentity().instanceId })
}
export function controllerSubjectFromRequest(request: FastifyRequest): ControllerSubject | undefined {
  const authority = browserAuthorityFromRequest(request)
  const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  if (!authority || !auth) return undefined
  return controllerSubject(authority, authority.kind === 'instance' ? 'local-instance'
    : auth.method === 'none' ? 'local-instance' : auth.method)
}

export function configureRequestAuthentication(startup: RequestAuthenticationStartup = {}): void {
  authMiddleware = createAuthMiddleware()
  authenticationRequired = process.env.AUTH_ENABLED !== 'false'
  configureDesktopOwnership(startup.desktopOwned === true, startup.listenHost, authenticationRequired)
  configureInstanceToken()
}

/**
 * 统一请求头验证和上下文提取
 */
export async function globalRequestMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // If it's in whitelist, we can skip the strict header checks and auth
  if (WHITELIST_PATHS.includes(request.url)) {
    return
  }

  // 1. Verify required headers
  const requestId = request.headers['x-request-id'] || 'default-req-id'
  const clientVersion = request.headers['x-client-version'] || '1.0.0'

  // Set them on request context
  ;(request as any).requestId = requestId
  ;(request as any).clientVersion = clientVersion
}

/** Match registered templates and encoded management namespaces, including unmatched administrative URLs. */
export function isManagementRequest(request: FastifyRequest, pathname = request.url.split('?', 1)[0]): boolean {
  if (isAdminPath(pathname) || isAdminPath(request.routeOptions?.url ?? '')) return true
  if (!pathname.startsWith('/') || !pathname.slice(0, 20).includes('%')) return false
  // Stop at the first slash (literal or encoded); a malformed arbitrary ID must not unmask the namespace in logs.
  const segment = pathname.slice(1).split(/\/|%2f/i, 1)[0]
  if (segment.length > 15) return false
  try { return decodeURIComponent(segment) === 'admin' } catch { return false }
}
/**
 * 请求日志记录中间件
 */
export async function loggingMiddleware(request: FastifyRequest, reply: FastifyReply) {
  if (WHITELIST_PATHS.includes(request.url)) return

  const reqLogger = logger.child({ requestId: request.id })
  const pathname = request.url.split('?', 1)[0], template = request.routeOptions?.url
  const url = isManagementRequest(request, pathname) ? (template && isAdminPath(template) ? template : '/admin/*') : pathname
  reqLogger.info({ method: request.method, url }, 'Incoming request')
}

/**
 * API 鉴权中间件
 */
export async function authMiddlewareHook(request: FastifyRequest, reply: FastifyReply) {
  const pathname = request.url.split('?', 1)[0]
  const admin = isManagementRequest(request, pathname)
  if (admin) {
    // Include failures from this hook in the same no-store policy as successful responses.
    reply.headers(adminHeaders)
    if (isPublicAdminShell(request.method, pathname)) return
  }
  if ((!admin && request.headers[ADMIN_HEADER] !== undefined) || adminKeyInWorkloadHeaders(request.headers)) {
    if (admin) await auditAdminGateDenial(request,'invalid_credential_scope')
    return reply.code(401).send(fail(40100, '后台凭据只可用于管理后台。'))
  }
  // Engine-owned source-change continuations reuse the authenticated principal
  // captured when the original request was admitted. The capability is
  // process-local and short-lived; it does not bypass the route's tenant/run
  // identity checks.
  const continuation = admin ? undefined : resolveInternalContinuation(request.headers[INTERNAL_CONTINUATION_HEADER])
  if (continuation) {
    if (continuation.method === 'session') {
      try { await revalidateAccountAuth(continuation) } catch { return reply.code(401).send(fail(40100, '登录已失效，请重新登录。')) }
    }
    ;(request as any).authContext = continuation
    return
  }
  // Browser redirects cannot carry the desktop instance header. The callback requires
  // its single-use state and only persists a pending identity; it never returns credentials.
  if (isExternalAccountCallback(request.method, pathname)) return
  // Check before the legacy whitelist and AUTH_ENABLED switch: neither can bypass an owned instance's token.
  if (!isPublicInstanceProbe(request.method, request.url) && !hasValidInstanceToken(request.headers)) {
    if (admin) await auditAdminGateDenial(request,'instance_token_required')
    return reply.code(401).send(fail(40100, 'Invalid or missing instance token'))
  }
  if (admin && request.headers[ADMIN_HEADER] !== undefined) {
    // A bad/disabled dedicated key never falls through to a privileged business credential.
    await requireAdminPermission(request, reply); return
  }
  if (isPublicInstanceProbe(request.method, request.url)) return
  if (isPublicAccountRoute(request.method, pathname)) return
  // Link flows use these same endpoints and still need a verified current actor.
  if (isPublicExternalAccountRoute(request.method, pathname) && !request.headers.authorization && !request.headers['x-api-key']) return
  // skip auth if in whitelist
  if (WHITELIST_PATHS.includes(request.url)) return

  try {
    const authContext = await authMiddleware.authenticate({
      headers: request.headers as Record<string, string | string[] | undefined>,
    })
    ;(request as any).authContext = authContext
  } catch (err) {
    const presentedCredential = Boolean(request.headers.authorization || request.headers['x-api-key'])
    if (authenticationRequired || presentedCredential) {
      if (admin) await auditAdminGateDenial(request,'authentication_required')
      return reply.code(401).send(fail(40100, !admin && err instanceof Error ? err.message : 'Unauthorized'))
    }
  }
}
