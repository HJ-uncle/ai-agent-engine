import { getDb } from '../storage/sqlite/db.js'
import type { AuthContext, AuthMiddleware } from './types.js'
import { createHash } from 'node:crypto'

export class DefaultAuthMiddleware implements AuthMiddleware {
  private jwtSecret: Uint8Array

  constructor() {
    const secret = process.env.JWT_SECRET ?? 'dev-secret-change-in-production'
    this.jwtSecret = new TextEncoder().encode(secret)
  }

  async authenticate(request: { headers: Record<string, string | string[] | undefined> }): Promise<AuthContext> {
    // Try API Key first — 有就验证，验证失败抛错
    const apiKey = request.headers['x-api-key']
    if (apiKey && typeof apiKey === 'string') {
      return this.authenticateApiKey(apiKey)
    }

    // Try JWT Bearer token — 有就验证，验证失败抛错
    const authorization = request.headers['authorization']
    if (authorization && typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      const token = authorization.slice(7)
      return this.authenticateJWT(token)
    }

    // 未传任何凭据 → 降级为默认租户，不报错
    return { tenantId: 'default', method: 'none' }
  }

  private async authenticateApiKey(apiKey: string): Promise<AuthContext> {
    const db = getDb()
    const keyHash = createHash('sha256').update(apiKey).digest('hex')
    
    const result = await db.execute({
      sql: 'SELECT id, tenant_id FROM users WHERE api_key_hash = ?',
      args: [keyHash],
    })
    const user = result.rows[0]

    if (!user) {
      throw new Error('Invalid API key')
    }

    return {
      tenantId: user['tenant_id'] as string,
      userId: user['id'] as string,
      method: 'api-key',
    }
  }

  private async authenticateJWT(token: string): Promise<AuthContext> {
    try {
      const { jwtVerify } = await import('jose')
      const { payload } = await jwtVerify(token, this.jwtSecret)
      
      const tenantId = (payload.tenantId ?? payload.sub ?? 'default') as string
      
      return {
        tenantId,
        userId: payload.sub,
        method: 'jwt',
      }
    } catch (err) {
      throw new Error(`Invalid JWT: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }
}

// No-op auth middleware for development
export class NoopAuthMiddleware implements AuthMiddleware {
  async authenticate(): Promise<AuthContext> {
    return { tenantId: 'default', method: 'none' }
  }
}

export function createAuthMiddleware(): AuthMiddleware {
  if (process.env.AUTH_ENABLED === 'false') {
    return new NoopAuthMiddleware()
  }
  return new DefaultAuthMiddleware()
}
