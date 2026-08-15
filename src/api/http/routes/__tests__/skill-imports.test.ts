/**
 * Skill 导入 API 集成测试（fastify inject，不监听端口）
 *
 * 覆盖：直传导入全流程（上传→轮询→落盘）、非法包异步失败回写、
 * 无文件/超限同步拒绝、权限守卫（AUTH_ENABLED=true 无凭据 → 41015）。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { zipSync, strToU8 } from 'fflate'

// 独立的临时数据目录与技能目录（避免污染开发库/真实技能）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-api-'))
process.env.DATA_DIR = path.join(TMP, 'data')
process.env.SKILLS_ROOT = path.join(TMP, 'skills')
fs.mkdirSync(process.env.SKILLS_ROOT, { recursive: true })
process.env.AUTH_ENABLED = 'false'

const { buildServer } = await import('../../server.js')

const SKILL_MD = (name: string) =>
  strToU8(`---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n`)

function makeZip(entries: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync(entries))
}

/** 手工拼 multipart body（inject 不支持 FormData） */
function multipart(fields: Record<string, string>, file: { data: Buffer; filename: string }) {
  const boundary = `----vitest${Date.now()}${Math.random().toString(16).slice(2)}`
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/zip\r\n\r\n`))
  parts.push(file.data)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

/** 轮询直到终态 */
async function waitTerminal(app: any, importId: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/skills/imports/${importId}` })
    const json = res.json()
    if (json.data?.status === 'imported' || json.data?.status === 'failed' || json.data?.status === 'cancelled') {
      return json.data
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('import did not reach terminal state in time')
}

describe('Skill Import API', () => {
  let app: any

  beforeAll(async () => {
    // buildServer 不执行迁移，先在临时库上建表
    const { initDb } = await import('../../../../storage/sqlite/db.js')
    await initDb()
    app = await buildServer()
  })

  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true })
    delete process.env.DATA_DIR
    delete process.env.SKILLS_ROOT
    process.env.AUTH_ENABLED = 'false'
  })

  it('直传合法 zip → 轮询至 imported → 技能落盘', async () => {
    const zip = makeZip({ 'demo-skill/SKILL.md': SKILL_MD('demo-skill') })
    const body = multipart({ filename: 'demo.zip', conflictStrategy: 'versioned' }, { data: zip, filename: 'demo.zip' })

    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/imports', payload: body.payload, headers: body.headers })
    const json = res.json()
    expect(json.code).toBe(200)
    expect(json.data.importId).toBeTruthy()

    const final = await waitTerminal(app, json.data.importId)
    expect(final.status).toBe('imported')
    expect(final.skillNames).toEqual(['demo-skill'])
    expect(fs.existsSync(path.join(process.env.SKILLS_ROOT!, 'demo-skill', 'SKILL.md'))).toBe(true)
  })

  it('直传非法 zip → 异步失败回写 errorCode=41010', async () => {
    const body = multipart({ filename: 'bad.zip' }, { data: Buffer.from('not a zip at all'), filename: 'bad.zip' })
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/imports', payload: body.payload, headers: body.headers })
    const json = res.json()
    expect(json.code).toBe(200)

    const final = await waitTerminal(app, json.data.importId)
    expect(final.status).toBe('failed')
    expect(final.errorCode).toBe('41010')
  })

  it('缺少文件字段 → 同步拒绝 41010', async () => {
    // 空 multipart（无 file 字段）→ request.file() 返回 null
    const boundary = '----nope'
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/imports',
      payload: Buffer.from(`--${boundary}--\r\n`),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
    expect(res.json().code).toBe(41010)
  })

  it('直传超过 5MB → 引导走分片（41011）', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0)
    const body = multipart({}, { data: big, filename: 'big.zip' })
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/imports', payload: body.payload, headers: body.headers })
    const json = res.json()
    expect(json.code).toBe(41011)
    expect(json.message).toContain('分片')
  })

  it('导入历史接口返回记录', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills/imports?limit=10' })
    const json = res.json()
    expect(json.code).toBe(200)
    expect(Array.isArray(json.data)).toBe(true)
    expect(json.data.length).toBeGreaterThanOrEqual(2) // 上面两次直传
  })

  it('GET /skills 返回技能列表（含根目录）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills' })
    const json = res.json()
    expect(json.code).toBe(200)
    expect(typeof json.data.root).toBe('string')
    expect(Array.isArray(json.data.list)).toBe(true)
  })
})

// 权限守卫场景见 skill-imports-auth.test.ts
// （authMiddleware 为模块级单例，AUTH_ENABLED 模式必须独立进程验证）

