import type { FastifyRequest, FastifyReply } from 'fastify'
import { fail } from './response.js'
import { logger } from '../../observability/index.js'
import { createAuthMiddleware } from '../../auth/index.js'

// White listed paths that do not require login state (reserved for future JWT)
// Also we bypass header checks for standard health checks to avoid breaking internal ops
export const WHITELIST_PATHS = ['/health', '/openapi.json', '/metrics', '/meta', '/auth/user']

const authMiddleware = createAuthMiddleware()

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
  reqLogger.info({ method: request.method, url: request.url }, 'Incoming request')
}

/**
 * API 鉴权中间件
 */
export async function authMiddlewareHook(request: FastifyRequest, reply: FastifyReply) {
  // skip auth if in whitelist
  if (WHITELIST_PATHS.includes(request.url)) return

  try {
    const authContext = await authMiddleware.authenticate({
      headers: request.headers as Record<string, string | string[] | undefined>,
    })
    ;(request as any).authContext = authContext
  } catch (err) {
    // Only reject if auth is enabled
    if (process.env.AUTH_ENABLED !== 'false') {
      return reply.code(200).send(fail(40100, err instanceof Error ? err.message : 'Unauthorized'))
    }
  }
}
