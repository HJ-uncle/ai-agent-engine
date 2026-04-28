import { getDb } from '../storage/sqlite/db.js'
import type { AuthContext, AuthMiddleware } from './types.js'
import { createHash, createSecretKey } from 'node:crypto'
import { jwtVerify, importJWK, decodeJwt } from 'jose'

// JWKS缓存
let jwksCache: { keys: any[] } | null = null
let jwksCacheTime = 0
const JWKS_CACHE_TTL = 360000000000 // 100000小时

export class DefaultAuthMiddleware implements AuthMiddleware {
  private jwtSecret: Uint8Array

  constructor() {
    const secret = process.env.JWT_SECRET ?? 'dev-secret-change-in-production'
    this.jwtSecret = new TextEncoder().encode(secret)
  }

  async authenticate(request: { headers: Record<string, string | string[] | undefined> }): Promise<AuthContext> {
    const authEnabled = process.env.AUTH_ENABLED !== 'false'
    
    if (!authEnabled) {
      return { tenantId: 'default', method: 'none' }
    }

    // Try API Key first
    const apiKey = request.headers['x-api-key']
    if (apiKey && typeof apiKey === 'string') {
      return this.authenticateApiKey(apiKey)
    }

    // Try JWT Bearer token
    const authorization = request.headers['authorization']
    if (authorization && typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      const token = authorization.slice(7)
      return this.authenticateJWT(token)
    }

    throw new Error('Authentication required: provide X-API-Key or Bearer token')
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
      // 获取 token 的 kid 来选择正确的公钥
      const decoded = decodeJwt(token) as { header: { kid?: string } }
      const kid = decoded.header?.kid

      // 从 OIDC JWKS 获取公钥
      const publicKey = await this.getPublicKeyFromJWKS(kid)
      
      const { payload } = await jwtVerify(token, publicKey)
      
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

  private async getPublicKeyFromJWKS(kid?: string): Promise<CryptoKey | Uint8Array> {
    const oidcIssuerUrl = process.env.OIDC_ISSUER_URL
    if (!oidcIssuerUrl) {
      // 如果没有配置 OIDC，使用对称密钥验证（向后兼容）
      return this.jwtSecret
    }

    // 检查缓存
    const now = Date.now()
    if (!jwksCache || now - jwksCacheTime > JWKS_CACHE_TTL) {
      try {
        const response = await fetch(`${oidcIssuerUrl}/jwks.json`)
        if (!response.ok) {
          throw new Error(`Failed to fetch JWKS: ${response.status}`)
        }
        jwksCache = await response.json()
        jwksCacheTime = now
      } catch (err) {
        throw new Error(`Failed to fetch JWKS: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
    }

    if (!jwksCache) {
      throw new Error('JWKS cache not available')
    }

    // 找到匹配的密钥
    let keyData = jwksCache.keys[0] // 默认使用第一个密钥
    if (kid) {
      keyData = jwksCache.keys.find((k: any) => k.kid === kid)
      if (!keyData) {
        throw new Error(`Public key with kid ${kid} not found`)
      }
    }

    return importJWK(keyData as any, keyData.alg) as Promise<CryptoKey>
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
