import { authenticateAccountSession } from './accounts.js'
import { getDb } from '../storage/sqlite/db.js'
import type { AuthContext, AuthMiddleware } from './types.js'
import { createHash } from 'node:crypto'

export class DefaultAuthMiddleware implements AuthMiddleware {
  private jwtSecret: Uint8Array | null
  private readonly authEnabled: boolean

  constructor() {
    const secret = process.env.JWT_SECRET
    this.jwtSecret = secret ? new TextEncoder().encode(secret) : null
    // Capture the startup decision.  Reading AUTH_ENABLED for every request made
    // a later settings write able to change the trust boundary of a live server.
    this.authEnabled = process.env.AUTH_ENABLED !== 'false'
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
      return token.startsWith('aether_session_') ? authenticateAccountSession(token) : this.authenticateJWT(token)
    }

    // 开启认证时不得把匿名请求降级成 default 租户。默认租户仅用于显式关闭
    // 认证的本地单机模式，否则任何资源都会变成可猜 ID 的共享入口。
    if (this.authEnabled) {
      throw new Error('Authentication required')
    }
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
      // 当前用户模型为一租户一用户：持有有效 api-key 即视为管理员
      roles: ['admin'],
    }
  }

  private async authenticateJWT(token: string): Promise<AuthContext> {
    if (!this.jwtSecret) throw new Error('JWT authentication is not configured')
    try {
      const { jwtVerify } = await import('jose')
      const { payload } = await jwtVerify(token, this.jwtSecret)
      
      const tenantId = (payload.tenantId ?? payload.sub ?? 'default') as string
      
      return {
        tenantId,
        userId: payload.sub,
        method: 'jwt',
        // JWT 未声明角色时按普通用户处理；管理员权限必须由签发方明确授予。
        roles: Array.isArray(payload.roles) && payload.roles.length > 0
          ? (payload.roles as string[])
          : [],
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
  return new DefaultAuthMiddleware()
}
