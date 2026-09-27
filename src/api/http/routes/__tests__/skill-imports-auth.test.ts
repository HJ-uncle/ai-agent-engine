/**
 * Skill 导入权限守卫测试（独立进程：AUTH_ENABLED=true 模式）
 *
 * authMiddleware 为模块级单例，故本文件与 skill-imports.test.ts 分离，
 * 在模块加载前固定 AUTH_ENABLED=true，验证：
 *  - 无凭据 → 41015
 *  - 有效 JWT → 认证用户默认 admin 角色 → 放行
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-auth-'))
process.env.DATA_DIR = path.join(TMP, 'data')
process.env.SKILLS_ROOT = path.join(TMP, 'skills')
fs.mkdirSync(process.env.SKILLS_ROOT, { recursive: true })
process.env.AUTH_ENABLED = 'true' // 必须在 import server 之前设置（单例固化时机）

const { buildServer } = await import('../../server.js')
const { initDb } = await import('../../../../storage/sqlite/db.js')

describe('Skill Import 权限守卫（AUTH_ENABLED=true）', () => {
  let app: any

  beforeAll(async () => {
    await initDb()
    app = await buildServer()
  })

  it('无凭据 → 41015 拒绝', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills/imports' })
    expect(res.json().code).toBe(41015)
  })

  it('有效 JWT → 默认 admin 角色 → 放行', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-change-in-production')
    const token = await new SignJWT({ tenantId: 'default' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('test-user')
      .sign(secret)

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/imports',
      headers: { authorization: `Bearer ${token}` },
    })
    const json = res.json()
    expect(json.code).toBe(200)
    expect(Array.isArray(json.data)).toBe(true)
  })
})
