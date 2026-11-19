import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../../storage/sqlite/db.js'
import { success, fail } from '../response.js'
import { isOwnedDesktopRequest } from '../middleware.js'
import { ADMIN_KEY_PREFIX } from '../../../auth/admin-key-format.js'
import { canAdministerTenant } from '../../../auth/guards.js'
import type { AuthContext } from '../../../auth/types.js'

/**
 * POST /auth/user
 *
 * 外部平台登录后同步用户信息到 agent-engine。
 * 传入 token + userId（必填），name / email 可选。
 *
 * 逻辑：
 *  - token 以 SHA-256 哈希存储为 api_key_hash，后续请求带 X-API-Key: <token> 即可鉴权
 *  - userId 作为 tenant_id（数据隔离单元）和 external_id
 *  - 已存在则 UPDATE，不存在则 INSERT
 *
 * Request body:
 *  {
 *    token:      string          // 外部平台颁发的 token（必填）
 *    userId:     string          // 外部平台的用户 ID（必填）
 *    name?:      string          // 显示名称（可选）
 *    email?:     string          // 邮箱（可选）
 *  }
 *
 * Response:
 *  {
 *    code: 0,
 *    data: { id, tenantId, name, email, externalId, createdAt }
 *  }
 */
export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/user', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'userId'],
        properties: {
          token: { type: 'string' },
          userId: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          email: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { token, userId, name, email } = request.body as {
      token: string
      userId: string
      name?: string
      email?: string
    }

    const authContext = (request as typeof request & { authContext?: AuthContext }).authContext
    const tenantId = userId.trim()
    const localBootstrap = authContext?.method === 'none' && tenantId === 'default' && isOwnedDesktopRequest(request)
    const authenticatedAdmin = canAdministerTenant(authContext, tenantId)
    if (!localBootstrap && !authenticatedAdmin) {
      const crossTenant = authContext?.roles?.includes('admin') && authContext.tenantId !== tenantId
      return reply.code(403).send(fail(40300, crossTenant ? '禁止跨租户管理认证用户' : '仅当前租户管理员可管理认证用户'))
    }
    // Register only keys that the desktop and admin page can send unchanged as X-API-Key.
    // This limit also permits using an existing key in the account recovery flow.
    if (!token || token.length > 4096 || /[^\x21-\x7e]/.test(token)) {
      return reply.code(400).send(fail(40000, 'API Key 须为 1 至 4096 个可见 ASCII 字符，不能包含空白。'))
    }
    if (token.startsWith(ADMIN_KEY_PREFIX)) return reply.code(400).send(fail(40000, '后台密钥前缀不能用于业务 API Key。'))
    const db = getDb()
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const now = Math.floor(Date.now() / 1000)

    // 查询是否已存在
    const existing = await db.execute({
      sql: 'SELECT id FROM users WHERE tenant_id = ?',
      args: [tenantId],
    })

    let id: string
    if (existing.rows.length > 0) {
      if (!authenticatedAdmin) return reply.code(403).send(fail(40300, '更新密钥需要已验证的管理员身份'))
      // UPDATE — 刷新 token hash，可选更新 name / email
      id = existing.rows[0]['id'] as string
      await db.execute({
        sql: `UPDATE users
              SET api_key_hash = ?,
                  external_id  = ?,
                  name         = COALESCE(?, name),
                  email        = COALESCE(?, email)
              WHERE tenant_id = ?`,
        args: [tokenHash, tenantId, name ?? null, email ?? null, tenantId],
      })
    } else {
      // INSERT
      id = uuidv4()
      await db.execute({
        sql: `INSERT INTO users (id, tenant_id, api_key_hash, external_id, name, email, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, tenantId, tokenHash, tenantId, name ?? null, email ?? null, now],
      })
    }

    // 返回最新用户信息
    const row = (
      await db.execute({
        sql: 'SELECT id, tenant_id, name, email, external_id, created_at FROM users WHERE id = ?',
        args: [id],
      })
    ).rows[0]

    return reply.code(200).send(
      success({
        id:         row['id'],
        tenantId:   row['tenant_id'],
        name:       row['name'] ?? null,
        email:      row['email'] ?? null,
        externalId: row['external_id'] ?? null,
        createdAt:  row['created_at'],
      }),
    )
  })
}
