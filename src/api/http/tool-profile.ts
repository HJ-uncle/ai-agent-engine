import type { FastifyRequest } from 'fastify'
import type { ToolProfile } from '../../tools/tool-profile.js'

/** Request-local product capability selection; it must never change another client's registry. */
export function getRequestToolProfile(request: Pick<FastifyRequest, 'headers'>): ToolProfile {
  const profile = request.headers['x-aether-tool-profile']
  if (profile === undefined) return 'general'
  if (profile === 'code' || profile === 'general') return profile
  throw Object.assign(new Error('X-Aether-Tool-Profile must be code or general'), { statusCode: 400 })
}
