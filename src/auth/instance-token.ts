import { createHash, timingSafeEqual } from 'node:crypto'

export const INSTANCE_TOKEN_HEADER = 'x-aether-instance-token'

/** This process-local gate is independent of optional tenant authentication and never returns the secret. */
export function hasValidInstanceToken(
  headers: Record<string, string | string[] | undefined>,
  expected = process.env.AETHER_INSTANCE_TOKEN,
): boolean {
  if (expected === undefined) return true // Standalone deployments retain their existing authentication contract.
  const supplied = headers[INSTANCE_TOKEN_HEADER]
  if (!expected || typeof supplied !== 'string' || !supplied) return false
  // Fixed-size digests keep comparison timing independent of the supplied token length.
  return timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(expected).digest())
}

export function isPublicInstanceProbe(method: string, url: string): boolean {
  const pathname = url.split('?', 1)[0]
  return (method === 'GET' || method === 'HEAD') && (pathname === '/health' || pathname === '/meta')
}
