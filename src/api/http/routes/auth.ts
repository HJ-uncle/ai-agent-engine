import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../../storage/sqlite/db.js'
import { success, fail } from '../response.js'

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
          token: { type: 'string', minLength: 1 },
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

    const db = getDb()
    const authContext = (request as any).authContext as { tenantId?: string; method?: string; roles?: string[] } | undefined
    const tenantId = userId.trim()
    const localBootstrap = process.env.AUTH_ENABLED === 'false' && authContext?.method === 'none' && tenantId === 'default'
    const authenticatedAdmin = Boolean(authContext && authContext.method !== 'none' && authContext.roles?.includes('admin'))
    if (!localBootstrap && !authenticatedAdmin) {
      return reply.code(403).send(fail(40300, '仅当前租户管理员可管理认证用户'))
    }
    if (authenticatedAdmin && authContext?.tenantId !== tenantId) {
      return reply.code(403).send(fail(40300, '禁止跨租户管理认证用户'))
    }
    const tokenHash = createHash('sha256').update(token.trim()).digest('hex')
    const now = Math.floor(Date.now() / 1000)

    // 查询是否已存在
    const existing = await db.execute({
      sql: 'SELECT id FROM users WHERE tenant_id = ?',
      args: [tenantId],
    })

    let id: string
    if (existing.rows.length > 0) {
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
