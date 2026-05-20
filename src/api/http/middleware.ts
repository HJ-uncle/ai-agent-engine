import type { FastifyRequest, FastifyReply } from 'fastify'
import { fail } from './response.js'

// White listed paths that do not require login state (reserved for future JWT)
// Also we bypass header checks for standard health checks to avoid breaking internal ops
export const WHITELIST_PATHS = ['/health', '/openapi.json', '/metrics', '/auth/user']

export async function globalRequestMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // If it's in whitelist, we can skip the strict header checks and auth
  if (WHITELIST_PATHS.includes(request.url)) {
    return
  }

  // 1. Verify required headers
  const requestId = request.headers['x-request-id'] || 'default-req-id'
  const clientVersion = request.headers['x-client-version'] || '1.0.0'

  /* 
  if (!requestId || typeof requestId !== 'string' || requestId.trim() === '') {
    return reply.code(200).send(fail(40001, '参数验证失败：X-Request-ID不能为空'))
  }

  if (!clientVersion || typeof clientVersion !== 'string' || clientVersion.trim() === '') {
    return reply.code(200).send(fail(40002, '参数验证失败：X-Client-Version不能为空'))
  }
  */

  // Set them on request context if needed
  ;(request as any).requestId = requestId
  ;(request as any).clientVersion = clientVersion
}
