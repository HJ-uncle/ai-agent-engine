import { BlockList, isIP } from 'node:net'
import { isPublicAccountRoute } from './routes/accounts.js'
import { isPublicExternalAccountRoute, isExternalAccountCallback } from './routes/account-external.js'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { fail } from './response.js'
import { logger } from '../../observability/index.js'
import type { AuthMiddleware } from '../../auth/types.js'
import { createAuthMiddleware } from '../../auth/index.js'
import { configureInstanceToken, hasValidInstanceToken, hasOwnedInstanceToken, isPublicInstanceProbe } from '../../auth/instance-token.js'
import type { AuthContext } from '../../auth/types.js'
import { browserAuthorityFromTrustedState, type BrowserHostAuthority } from '../../core/browser-authority.js'
import { getRuntimeIdentity } from '../../runtime/identity.js'
import { controllerSubject, type ControllerSubject } from '../../core/collaboration/controller-origin.js'

// White listed paths that do not require login state (reserved for future JWT)
// Also we bypass header checks for standard health checks to avoid breaking internal ops
// 只有不返回租户数据的存活探针公开；实例令牌（如配置）仍由 auth hook 校验。
export const WHITELIST_PATHS = ['/health', '/meta']

// The server replaces this during build, after all startup configuration has
// been applied.  Keeping a fallback makes isolated route tests deterministic.
let authMiddleware: AuthMiddleware = createAuthMiddleware()
let authenticationRequired = process.env.AUTH_ENABLED !== 'false'
let desktopOwnedLoopback = false

export interface RequestAuthenticationStartup {
  /** Actual host passed to listen(), captured before project settings are loaded. */
  listenHost?: string
  /** Process-launcher decision; never derive this from a request or business settings. */
  desktopOwned?: boolean
}

const loopbackAddresses = new BlockList()
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackAddresses.addAddress('::1', 'ipv6')
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const family = isIP(address)
  return family !== 0 && loopbackAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

/** A local session capability, not an instance-admin role or a replacement tenant. */
export function canUseDesktopSessionFullAccess(request: FastifyRequest): boolean {
  const auth = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  return desktopOwnedLoopback && !!auth && auth.method !== 'none' &&
    auth.roles?.includes('tenant-admin') === true &&
    isLoopbackAddress(request.raw.socket.remoteAddress) && hasOwnedInstanceToken(request.headers)
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
  desktopOwnedLoopback = startup.desktopOwned === true && !authenticationRequired && isLoopbackAddress(startup.listenHost)
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

/**
 * 请求日志记录中间件
 */
export async function loggingMiddleware(request: FastifyRequest, reply: FastifyReply) {
  if (WHITELIST_PATHS.includes(request.url)) return

  const reqLogger = logger.child({ requestId: request.id })
  reqLogger.info({ method: request.method, url: request.url.split('?', 1)[0] }, 'Incoming request')
}

/**
 * API 鉴权中间件
 */
export async function authMiddlewareHook(request: FastifyRequest, reply: FastifyReply) {
  const pathname = request.url.split('?', 1)[0]
  // Browser redirects cannot carry the desktop instance header. The callback requires
  // its single-use state and only persists a pending identity; it never returns credentials.
  if (isExternalAccountCallback(request.method, pathname)) return
  // Check before the legacy whitelist and AUTH_ENABLED switch: neither can bypass an owned instance's token.
  if (!isPublicInstanceProbe(request.method, request.url) && !hasValidInstanceToken(request.headers)) {
    return reply.code(401).send(fail(40100, 'Invalid or missing instance token'))
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
      return reply.code(401).send(fail(40100, err instanceof Error ? err.message : 'Unauthorized'))
    }
  }
}
