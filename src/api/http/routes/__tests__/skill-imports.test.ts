/**
 * Skill 导入 API 集成测试（fastify inject，不监听端口）
 *
 * 覆盖：直传导入全流程（上传→轮询→落盘）、非法包异步失败回写、
 * 无文件/超限同步拒绝、权限守卫（AUTH_ENABLED=true 无凭据 → 41015）。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'

// Skill import tests must not leave a scheduler that can reopen storage after teardown.
vi.mock('../../../../scheduler/cron-scheduler.js', () => ({ cronScheduler: { start: vi.fn(), stop: vi.fn() } }))

// 独立的临时数据目录与技能目录（避免污染开发库/真实技能）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-api-'))
const ORIGINAL_GLOBAL_DIR = process.env.AETHER_GLOBAL_DIR
const ORIGINAL_DATA_DIR = process.env.DATA_DIR ?? path.join(TMP, 'data')
process.env.DATA_DIR = path.join(TMP, 'data')
process.env.SKILLS_ROOT = path.join(TMP, 'skills')
process.env.AETHER_GLOBAL_DIR = path.join(TMP, 'global')
fs.mkdirSync(process.env.SKILLS_ROOT, { recursive: true })
fs.mkdirSync(process.env.AETHER_GLOBAL_DIR, { recursive: true })
process.env.AUTH_ENABLED = 'false'

const { buildServer } = await import('../../server.js')
const { initDb, closeDb } = await import('../../../../storage/sqlite/db.js')

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
    await initDb()
    app = await buildServer()
  })

  afterAll(async () => {
    await app?.close()
    closeDb()
    // Windows 下 Temp 目录可能被杀软/索引服务长期锁定（EPERM）：
    // 清理只是卫生操作，失败不应让全绿的套件标红；目录在 %TEMP% 下
    // 会随系统磁盘清理回收
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch { /* ignore */ }
    process.env.DATA_DIR = ORIGINAL_DATA_DIR
    delete process.env.SKILLS_ROOT
    if (ORIGINAL_GLOBAL_DIR === undefined) delete process.env.AETHER_GLOBAL_DIR
    else process.env.AETHER_GLOBAL_DIR = ORIGINAL_GLOBAL_DIR
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

  it('直传单个 SKILL.md → 轮询至 imported → 按文件名落盘', async () => {
    const standalone = Buffer.from(`---\nname: standalone\ndescription: test\n---\n\n# standalone\n`)
    const body = multipart({ filename: 'standalone.md', skillName: 'standalone' }, { data: standalone, filename: 'standalone.md' })
    const res = await app.inject({ method: 'POST', url: '/api/v1/skills/imports', payload: body.payload, headers: body.headers })
    const json = res.json()
    expect(json.code).toBe(200)
    const final = await waitTerminal(app, json.data.importId)
    expect(final.status).toBe('imported')
    expect(final.skillNames).toEqual(['standalone'])
    expect(fs.existsSync(path.join(process.env.SKILLS_ROOT!, 'standalone', 'SKILL.md'))).toBe(true)
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

  it('分片请求拒绝路径穿越会话标识与错误分片尺寸', async () => {
    const traversal = multipart({ filename: 'x.zip', totalSize: '2', totalChunks: '1', chunkIndex: '0', importId: '../escape' }, { data: Buffer.from('x!'), filename: 'x.part' })
    const traversalResponse = await app.inject({ method: 'POST', url: '/api/v1/skills/imports/chunks', payload: traversal.payload, headers: traversal.headers })
    expect(traversalResponse.json().code).toBe(41010)

    const wrongSize = multipart({ filename: 'x.zip', totalSize: String(2 * 1024 * 1024), totalChunks: '1', chunkIndex: '0' }, { data: Buffer.from('x'), filename: 'x.part' })
    const wrongSizeResponse = await app.inject({ method: 'POST', url: '/api/v1/skills/imports/chunks', payload: wrongSize.payload, headers: wrongSize.headers })
    expect(wrongSizeResponse.json().code).toBe(41010)
  })

  it('分片续传按内容哈希、scope 与 workspace 隔离', async () => {
    const totalSize = 2 * 1024 * 1024 + 1
    const contentHash = createHash('sha256').update(Buffer.alloc(totalSize, 7)).digest('hex')
    const workspace = path.join(TMP, 'resume-workspace')
    const first = multipart({ filename: 'resume.zip', totalSize: String(totalSize), totalChunks: '2', chunkIndex: '0', fileSha256: contentHash, scope: 'project', projectRoot: workspace }, { data: Buffer.alloc(2 * 1024 * 1024, 7), filename: 'resume.part' })
    const firstResponse = await app.inject({ method: 'POST', url: '/api/v1/skills/imports/chunks', payload: first.payload, headers: first.headers })
    expect(firstResponse.json(), JSON.stringify(firstResponse.json())).toMatchObject({ code: 200 })
    const firstId = firstResponse.json().data.importId
    const second = multipart({ filename: 'resume.zip', totalSize: String(totalSize), totalChunks: '2', chunkIndex: '1', fileSha256: contentHash, scope: 'project', projectRoot: workspace }, { data: Buffer.alloc(1, 7), filename: 'resume.part' })
    const secondResponse = await app.inject({ method: 'POST', url: '/api/v1/skills/imports/chunks', payload: second.payload, headers: second.headers })
    expect(secondResponse.json().data.importId).toBe(firstId)
    const otherWorkspace = multipart({ filename: 'resume.zip', totalSize: String(totalSize), totalChunks: '2', chunkIndex: '0', fileSha256: contentHash, scope: 'project', projectRoot: path.join(TMP, 'other-workspace') }, { data: Buffer.alloc(2 * 1024 * 1024, 7), filename: 'resume.part' })
    const otherResponse = await app.inject({ method: 'POST', url: '/api/v1/skills/imports/chunks', payload: otherWorkspace.payload, headers: otherWorkspace.headers })
    expect(otherResponse.json().data.importId).not.toBe(firstId)
  })

  it('导入历史接口返回记录', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills/imports?limit=10' })
    const json = res.json()
    expect(json.code).toBe(200)
    expect(Array.isArray(json.data)).toBe(true)
    expect(json.data.length).toBeGreaterThanOrEqual(2) // 上面两次直传
  })

  it('projectRoot 隔离项目层，并支持停用后重新启用', async () => {
    const projectRoot = path.join(TMP, 'workspace-a')
    const standalone = Buffer.from(`---\nname: project-only\ndescription: workspace\n---\n\n# project\n`)
    const body = multipart({ filename: 'project-only.md', projectRoot }, { data: standalone, filename: 'project-only.md' })
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/skills/imports', payload: body.payload, headers: body.headers })
    const final = await waitTerminal(app, accepted.json().data.importId)
    expect(final.status).toBe('imported')
    const listed = await app.inject({ method: 'GET', url: `/api/v1/skills?path=${encodeURIComponent(projectRoot)}` })
    expect(listed.json().data.list.some((skill: any) => skill.name === 'project-only' && skill.enabled === true)).toBe(true)

    const disabled = await app.inject({ method: 'PATCH', url: `/api/v1/skills/project-only?path=${encodeURIComponent(projectRoot)}`, payload: { enabled: false } })
    expect(disabled.json().code).toBe(200)
    const afterDisable = await app.inject({ method: 'GET', url: `/api/v1/skills?path=${encodeURIComponent(projectRoot)}` })
    expect(afterDisable.json().data.list.find((skill: any) => skill.name === 'project-only')?.enabled).toBe(false)

    const enabled = await app.inject({ method: 'PATCH', url: `/api/v1/skills/project-only?path=${encodeURIComponent(projectRoot)}`, payload: { enabled: true } })
    expect(enabled.json().code).toBe(200)
    const afterEnable = await app.inject({ method: 'GET', url: `/api/v1/skills?path=${encodeURIComponent(projectRoot)}` })
    expect(afterEnable.json().data.list.find((skill: any) => skill.name === 'project-only')?.enabled).toBe(true)
  })

  it('同名项目/全局技能按 scope 精确详情、停用和删除', async () => {
    const projectRoot = path.join(TMP, 'duplicate-workspace')
    const projectContent = Buffer.from('---\nname: duplicate-scope\ndescription: project\n---\n\nPROJECT_SCOPE_MARKER\n')
    const globalContent = Buffer.from('---\nname: duplicate-scope\ndescription: global\n---\n\nGLOBAL_SCOPE_MARKER\n')
    const projectUpload = multipart({ filename: 'duplicate-project.md', projectRoot, scope: 'project' }, { data: projectContent, filename: 'duplicate-project.md' })
    const globalUpload = multipart({ filename: 'duplicate-global.md', scope: 'global' }, { data: globalContent, filename: 'duplicate-global.md' })
    const projectAccepted = await app.inject({ method: 'POST', url: '/api/v1/skills/imports', payload: projectUpload.payload, headers: projectUpload.headers })
    const globalAccepted = await app.inject({ method: 'POST', url: '/api/v1/skills/imports', payload: globalUpload.payload, headers: globalUpload.headers })
    expect((await waitTerminal(app, projectAccepted.json().data.importId)).status).toBe('imported')
    expect((await waitTerminal(app, globalAccepted.json().data.importId)).status).toBe('imported')

    const list = await app.inject({ method: 'GET', url: `/api/v1/skills?path=${encodeURIComponent(projectRoot)}&all=1` })
    const rows = list.json().data.list.filter((skill: any) => skill.name === 'duplicate-scope')
    expect(rows.map((skill: any) => skill.scope).sort()).toEqual(['global', 'project'])

    const projectDetail = await app.inject({ method: 'GET', url: `/api/v1/skills/duplicate-scope?path=${encodeURIComponent(projectRoot)}&scope=project` })
    const globalDetail = await app.inject({ method: 'GET', url: `/api/v1/skills/duplicate-scope?path=${encodeURIComponent(projectRoot)}&scope=global` })
    expect(projectDetail.json().data.content).toContain('PROJECT_SCOPE_MARKER')
    expect(globalDetail.json().data.content).toContain('GLOBAL_SCOPE_MARKER')

    const disabled = await app.inject({ method: 'PATCH', url: `/api/v1/skills/duplicate-scope?path=${encodeURIComponent(projectRoot)}&scope=global`, payload: { enabled: false } })
    expect(disabled.json().code).toBe(200)
    const afterDisable = await app.inject({ method: 'GET', url: `/api/v1/skills?path=${encodeURIComponent(projectRoot)}&all=1` })
    const afterRows = afterDisable.json().data.list.filter((skill: any) => skill.name === 'duplicate-scope')
    expect(afterRows.find((skill: any) => skill.scope === 'project')?.enabled).toBe(true)
    expect(afterRows.find((skill: any) => skill.scope === 'global')?.enabled).toBe(false)

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/skills/duplicate-scope?path=${encodeURIComponent(projectRoot)}&scope=global` })
    expect(deleted.json().code).toBe(200)
    const afterDelete = await app.inject({ method: 'GET', url: `/api/v1/skills?path=${encodeURIComponent(projectRoot)}&all=1` })
    const remaining = afterDelete.json().data.list.filter((skill: any) => skill.name === 'duplicate-scope')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].scope).toBe('project')

    const projectDeleted = await app.inject({ method: 'DELETE', url: `/api/v1/skills/duplicate-scope?path=${encodeURIComponent(projectRoot)}&scope=project` })
    expect(projectDeleted.json().code).toBe(200)
  })

  it('legacy project skills remain manageable while all newly created files use .ae', async () => {
    const projectRoot = path.join(TMP, 'legacy-managed-workspace')
    const oldRoot = path.join(projectRoot, '.aether', 'skills')
    const oldestRoot = path.join(projectRoot, 'SKILLs')
    for (const [root, name] of [[oldRoot, 'legacy-managed'], [oldestRoot, 'oldest-managed']]) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
      fs.writeFileSync(path.join(root, name, 'SKILL.md'), SKILL_MD(name))
    }
    fs.writeFileSync(path.join(oldRoot, 'unrelated-project-file.txt'), 'keep me')
    const query = '?path=' + encodeURIComponent(projectRoot) + '&scope=project'
    const created = await app.inject({ method: 'POST', url: '/api/v1/skills', payload: { projectRoot, name: 'new-created', description: 'new', content: '# new' } })
    expect(created.json().code).toBe(200)
    expect(fs.readFileSync(path.join(projectRoot, '.ae/skills/new-created/SKILL.md'), 'utf8')).toContain('# new')
    const upload = multipart({ projectRoot, filename: 'new-imported.md' }, { data: Buffer.from(SKILL_MD('new-imported')), filename: 'new-imported.md' })
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/skills/imports', ...upload })
    expect((await waitTerminal(app, accepted.json().data.importId)).status).toBe('imported')
    expect(fs.existsSync(path.join(projectRoot, '.ae/skills/new-imported/SKILL.md'))).toBe(true)
    for (const name of ['legacy-managed', 'oldest-managed']) {
      const disabled = await app.inject({ method: 'PATCH', url: '/api/v1/skills/' + name + query, payload: { enabled: false } })
      expect(disabled.json().code).toBe(200)
      const detail = await app.inject({ method: 'GET', url: '/api/v1/skills/' + name + query })
      expect(detail.json().data.enabled).toBe(false)
      const enabled = await app.inject({ method: 'PATCH', url: '/api/v1/skills/' + name + query, payload: { enabled: true } })
      expect(enabled.json().code).toBe(200)
      const enabledDetail = await app.inject({ method: 'GET', url: '/api/v1/skills/' + name + query })
      expect(enabledDetail.json().data.enabled).toBe(true)
      const removed = await app.inject({ method: 'DELETE', url: '/api/v1/skills/' + name + query })
      expect(removed.json().code).toBe(200)
    }
    expect(fs.existsSync(path.join(oldRoot, 'legacy-managed'))).toBe(false)
    expect(fs.existsSync(path.join(oldestRoot, 'oldest-managed'))).toBe(false)
    expect(fs.existsSync(path.join(oldRoot, 'skills.config.json'))).toBe(false)
    expect(fs.existsSync(path.join(oldestRoot, 'skills.config.json'))).toBe(false)
    expect(fs.existsSync(path.join(projectRoot, '.ae/skills/skills.config.json'))).toBe(true)
    expect(fs.readFileSync(path.join(oldRoot, 'unrelated-project-file.txt'), 'utf8')).toBe('keep me')
  })

  it('deleting a modern skill suppresses older copies without removing them; reimport restores it', async () => {
    const projectRoot = path.join(TMP, 'shadow-delete-workspace')
    const name = 'shadow-delete'
    for (const folder of ['.aether/skills', 'SKILLs']) {
      const directory = path.join(projectRoot, folder, name)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'SKILL.md'), SKILL_MD(name))
    }
    const query = '?path=' + encodeURIComponent(projectRoot) + '&scope=project'
    const created = await app.inject({ method: 'POST', url: '/api/v1/skills', payload: { projectRoot, name, description: 'canonical', content: '# new' } })
    expect(created.json().code).toBe(200)
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/skills/' + name + query })
    expect(removed.json().code).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/v1/skills' + query })
    expect(list.json().data.list.map((entry: { name: string }) => entry.name)).not.toContain(name)
    const detail = await app.inject({ method: 'GET', url: '/api/v1/skills/' + name + query })
    expect(detail.json().code).toBe(40400)
    expect(fs.existsSync(path.join(projectRoot, '.ae/skills', name))).toBe(false)
    for (const folder of ['.aether/skills', 'SKILLs']) {
      expect(fs.readFileSync(path.join(projectRoot, folder, name, 'SKILL.md'))).toEqual(Buffer.from(SKILL_MD(name)))
    }
    const upload = multipart({ projectRoot, filename: name + '.md' }, { data: Buffer.from(SKILL_MD(name)), filename: name + '.md' })
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/skills/imports', ...upload })
    expect((await waitTerminal(app, accepted.json().data.importId)).status).toBe('imported')
    const restored = await app.inject({ method: 'GET', url: '/api/v1/skills/' + name + query })
    expect(restored.json().code).toBe(200)
    expect(restored.json().data.dir).toBe(path.join(projectRoot, '.ae/skills', name))
    expect(restored.json().data.enabled).toBe(true)
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

