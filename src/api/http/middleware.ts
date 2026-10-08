import { isPublicAccountRoute } from './routes/accounts.js'
import { isPublicExternalAccountRoute, isExternalAccountCallback } from './routes/account-external.js'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { fail } from './response.js'
import { logger } from '../../observability/index.js'
import type { AuthMiddleware } from '../../auth/types.js'
import { createAuthMiddleware } from '../../auth/index.js'
import { configureInstanceToken, hasValidInstanceToken, isPublicInstanceProbe } from '../../auth/instance-token.js'

// White listed paths that do not require login state (reserved for future JWT)
// Also we bypass header checks for standard health checks to avoid breaking internal ops
// 只有不返回租户数据的存活探针公开；实例令牌（如配置）仍由 auth hook 校验。
export const WHITELIST_PATHS = ['/health', '/meta']

// The server replaces this during build, after all startup configuration has
// been applied.  Keeping a fallback makes isolated route tests deterministic.
let authMiddleware: AuthMiddleware = createAuthMiddleware()
let authenticationRequired = process.env.AUTH_ENABLED !== 'false'

export function configureRequestAuthentication(): void {
  authMiddleware = createAuthMiddleware()
  authenticationRequired = process.env.AUTH_ENABLED !== 'false'
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
