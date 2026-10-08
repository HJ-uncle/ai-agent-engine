/**
 * Skill 压缩包导入路由
 *
 * 两种上传模式：
 *  - 直传（≤5MB）：POST /skills/imports（multipart file）
 *  - 分片 + 断点续传（>5MB）：
 *      POST /skills/imports/chunks          上传单个分片（幂等，可重传）
 *      GET  /skills/imports/chunks?filename&totalSize   查询已传分片（续传位图）
 *      POST /skills/imports/chunks/merge    合并分片并触发导入
 *
 * 状态查询：
 *  - GET    /skills/imports/:id     进度/结果
 *  - GET    /skills/imports         导入历史
 *  - DELETE /skills/imports/:id     取消进行中的导入
 *
 * 安全：requireRoles(admin | skill-manager)；包内容校验见 import-pipeline。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { projectDataPath } from '../../../core/project-storage.js'
import { projectSkillRoots, withProjectSkillDeletion } from '../../../skills/project-skills.js'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { success, fail } from '../response.js'
import { requireRoles, SKILL_IMPORT_ROLES } from '../../../auth/index.js'
import { skillImportStore } from '../../../storage/skill-import/index.js'
import {
  runSkillImport,
  SkillImportError,
  DIRECT_UPLOAD_LIMIT,
  resolveSkillsRoot,
} from '../../../skills/import-pipeline.js'
import type { ConflictStrategy, SkillScope } from '../../../skills/import-pipeline.js'
import { skillsRegistry } from '../../../skills/skills-registry.js'
import { getSkillContent } from '../../../skills/external-loader.js'
import { logger } from '../../../observability/index.js'

const CHUNK_SIZE = 2 * 1024 * 1024 // 分片目标大小（前端切分参考，后端不强制）

function parseScope(v: unknown): SkillScope {
  return v === 'global' ? 'global' : 'project'
}

// 手动创建技能（表单直建）的参数校验
const CreateSkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/, '技能名必须是小写字母、数字、连字符或下划线，且以字母或数字开头'),
  description: z.string().min(1, '描述不能为空').max(500, '描述过长（≤500 字符）'),
  content: z.string().min(1, 'SKILL.md 正文不能为空').max(100_000, '正文过长（≤100000 字符）'),
  scope: z.enum(['project', 'global']).optional().default('project'),
  overwrite: z.boolean().optional().default(false),
  projectRoot: z.string().max(4096).optional(),
})
const MAX_PACKAGE_SIZE = parseInt(process.env.SKILL_IMPORT_MAX_MB ?? '20', 10) * 1024 * 1024
const CONFLICT_STRATEGIES: ConflictStrategy[] = ['reject', 'overwrite', 'versioned']

// 进行中导入的取消标志（进程内）
const cancelFlags = new Map<string, boolean>()
const importProjectRoots = new Map<string, string | undefined>()

function getAuth(request: FastifyRequest): { tenantId: string; userId?: string } {
  const ctx = (request as any).authContext
  return { tenantId: ctx?.tenantId ?? 'default', userId: ctx?.userId }
}

function parseStrategy(raw: unknown): ConflictStrategy {
  return CONFLICT_STRATEGIES.includes(raw as ConflictStrategy) ? (raw as ConflictStrategy) : 'versioned'
}

function parseProjectRoot(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error('projectRoot 必须是有效的工作区路径')
  return path.resolve(raw)
}

function parseContentHash(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/i.test(raw)) throw new Error('分片上传必须提供 64 位 SHA-256 文件哈希')
  return raw.toLowerCase()
}

function workspaceSkillsRoot(projectRoot: string | undefined, scope: SkillScope): string {
  if (!projectRoot || scope === 'global') return resolveSkillsRoot(undefined, scope)
  return projectDataPath(projectRoot, 'skills')
}

function canonicalProjectRoot(projectRoot: string | undefined, scope: SkillScope): string | undefined {
  return scope === 'global' ? undefined : projectRoot
}

function workspaceQuery(request: FastifyRequest): string | undefined {
  const raw = (request.query as { path?: unknown } | undefined)?.path
  return raw === undefined ? undefined : parseProjectRoot(raw)
}

type SkillRouteScope = SkillScope | undefined

/**
 * Skill names are allowed to exist in both project and global layers.  The
 * management id disambiguates rows in the UI, but legacy name-based callers
 * still use /skills/:name.  Accept an optional scope on those routes so a
 * CRUD operation can never silently target the first layer returned by the
 * registry.
 */
function skillScopeQuery(request: FastifyRequest): SkillRouteScope {
  const raw = (request.query as { scope?: unknown } | undefined)?.scope
  if (raw === undefined || raw === '') return undefined
  if (raw !== 'project' && raw !== 'global') throw new Error('scope 必须是 project 或 global')
  return raw
}

function managementSkills(projectRoot: string | undefined, scope: SkillRouteScope): ReturnType<typeof skillsRegistry.getAllSkills> {
  return scope ? skillsRegistry.getAllSkillsByScope(projectRoot, scope) : skillsRegistry.getAllSkills(projectRoot)
}

function matchesSkill(skill: { name: string; id?: string; skillMdPath: string }, key: string): boolean {
  const needle = key.toLowerCase()
  return managementSkillId(skill) === key || skill.name.toLowerCase() === needle || skill.id?.toLowerCase() === needle || path.basename(path.dirname(skill.skillMdPath)).toLowerCase() === needle
}

function managementSkillId(skill: { skillMdPath: string }): string {
  const identity = process.platform === 'win32' ? skill.skillMdPath.toLowerCase() : skill.skillMdPath
  return `skill-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

/** 分片暂存目录 */
function chunkDir(importId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(importId)) throw new Error('非法的导入会话标识')
  const configured = path.resolve(process.env.DATA_DIR ?? './data')
  const dataRoot = (fs.existsSync(configured) && fs.statSync(configured).isFile()) || path.extname(configured)
    ? path.dirname(configured)
    : configured
  const base = path.resolve(dataRoot, 'skill-imports', importId)
  fs.mkdirSync(base, { recursive: true })
  return base
}

function skillImportsRoot(): string {
  const configured = path.resolve(process.env.DATA_DIR ?? './data')
  return ((fs.existsSync(configured) && fs.statSync(configured).isFile()) || path.extname(configured))
    ? path.join(path.dirname(configured), 'skill-imports')
    : path.join(configured, 'skill-imports')
}

/**
 * 异步执行导入管线并回写状态。
 * 返回值：立即（不等待管线完成）。
 */
function executeImport(
  importId: string,
  zipBuffer: Buffer,
  filename: string,
  strategy: ConflictStrategy,
  scope: SkillScope = 'project',
  skillName?: string,
  projectRoot?: string,
) {
  const sha256 = createHash('sha256').update(zipBuffer).digest('hex')
  void skillImportStore
    .update(importId, { status: 'validating', stage: '校验压缩包格式', progress: 5, fileSha256: sha256 })
    .then(() => {
      const summary = runSkillImport({
        importId,
        zipBuffer,
        filename,
        skillName,
        skillsRoot: workspaceSkillsRoot(projectRoot, scope),
        conflictStrategy: strategy,
        scope,
        isCancelled: () => cancelFlags.get(importId) === true,
        onProgress: (p) => {
          const status = p.progress >= 55 ? 'extracting' : 'validating'
          void skillImportStore.update(importId, { progress: p.progress, stage: p.stage, status })
        },
      })
      // 落盘成功后立即重扫：全局层目录首次创建时可能尚无 watcher，
      // 依赖 fs.watch 不会触发；ensureGlobalLayer 会动态采纳新目录
      try {
        if (!projectRoot) {
          skillsRegistry.ensureGlobalLayer()
          skillsRegistry.reload()
        }
      } catch (err) {
        logger.warn({ importId, err }, 'skill-import: registry reload after import failed')
      }
      return skillImportStore.update(importId, {
        status: 'imported',
        progress: 100,
        stage: '导入完成',
        skillNames: summary.skillNames,
        importedCount: summary.importedCount,
        skippedCount: summary.skippedCount,
      })
    })
    .catch((err: unknown) => {
      const cancelled = cancelFlags.get(importId) === true
      cancelFlags.delete(importId)
      const isKnown = err instanceof SkillImportError
      const status: 'cancelled' | 'failed' = cancelled ? 'cancelled' : 'failed'
      const rec = {
        status,
        stage: cancelled ? '已取消' : '导入失败',
        errorCode: cancelled ? null : String(isKnown ? err.code : 50010),
        errorMessage: (err as Error)?.message ?? 'unknown error',
      }
      logger.warn({ importId, ...rec }, 'skill-import: import failed')
      void skillImportStore.update(importId, rec)
    })
    .finally(() => {
      cancelFlags.delete(importId)
      importProjectRoots.delete(importId)
    })
}

function toDto(rec: Awaited<ReturnType<typeof skillImportStore.get>>) {
  return rec
    ? {
        importId: rec.id,
        filename: rec.filename,
        fileSize: rec.fileSize,
        status: rec.status,
        progress: rec.progress,
        stage: rec.stage,
        skillNames: rec.skillNames,
        conflictStrategy: rec.conflictStrategy,
        scope: rec.scope,
        projectRoot: rec.projectRoot || undefined,
        importedCount: rec.importedCount,
        errorCode: rec.errorCode,
        errorMessage: rec.errorMessage,
        uploadedChunks: rec.uploadedChunks,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
      }
    : null
}

export async function skillImportRoutes(fastify: FastifyInstance) {
  // 全部路由要求 admin / skill-manager 角色（AUTH_ENABLED=false 时守卫自动放行）
  fastify.addHook('preHandler', requireRoles(...SKILL_IMPORT_ROLES))

  // ── 技能列表 ────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { reload?: string; path?: string; scope?: SkillScope; all?: string } }>('/skills', async (request, reply) => {
    // 全局层目录可能在启动后才创建（首次全局导入）：动态探测采纳
    skillsRegistry.ensureGlobalLayer()
    // ?reload=1：强制重扫磁盘（NFS 等共享卷上 fs.watch 可能不触发时的兜底）
    if (request.query.reload === '1') skillsRegistry.reload()
    let projectRoot: string | undefined
    let scope: SkillRouteScope
    try { projectRoot = workspaceQuery(request); scope = skillScopeQuery(request) } catch (error) { return reply.code(200).send(fail(40001, (error as Error).message)) }
    const list = request.query.all === '1'
      ? [...skillsRegistry.getAllSkillsByScope(projectRoot, 'global'), ...skillsRegistry.getAllSkillsByScope(projectRoot, 'project')]
        .filter((skill, index, all) => all.findIndex((candidate) => managementSkillId(candidate) === managementSkillId(skill)) === index)
      : managementSkills(projectRoot, scope)
    return reply.code(200).send(success({
      root: workspaceSkillsRoot(projectRoot, 'project'),
      // 如实上报：registry 实际启用的全局层路径（未启用为 null）
      globalRoot: skillsRegistry.globalRootPath,
      list: list.map((s) => ({
        id: managementSkillId(s),
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        order: s.order,
        scope: s.scope ?? 'project',
      })),
    }))
  })

  // ── 技能详情（SKILL.md 全文 + 目录内附件清单）──────────────────────────────
  fastify.get<{ Params: { name: string }; Querystring: { path?: string; scope?: SkillScope } }>('/skills/:name', async (request, reply) => {
    const name = request.params.name
    let projectRoot: string | undefined
    let scope: SkillRouteScope
    try { projectRoot = workspaceQuery(request); scope = skillScopeQuery(request) } catch (error) { return reply.code(200).send(fail(40001, (error as Error).message)) }
    const skill = managementSkills(projectRoot, scope).find((s) => matchesSkill(s, name))
    if (!skill) {
      return reply.code(200).send(fail(40400, `技能 "${name}" 不存在`))
    }

    // SKILL.md 全文（inlineContent 优先，否则读盘）
    const content = getSkillContent([skill], skill.name)

    // 附件清单：只统计技能目录内的相对路径，过滤系统垃圾文件
    const dir = path.dirname(skill.skillMdPath)
    const files: { path: string; size: number }[] = []
    try {
      const walk = (cur: string, depth: number) => {
        if (files.length >= 200 || depth > 4) return // 上限保护
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
          if (ent.name === '.DS_Store' || ent.name.startsWith('._')) continue
          const full = path.join(cur, ent.name)
          if (ent.isDirectory()) {
            walk(full, depth + 1)
          } else {
            files.push({
              path: path.relative(dir, full),
              size: fs.statSync(full).size,
            })
          }
        }
      }
      walk(dir, 0)
      files.sort((a, b) => a.path.localeCompare(b.path))
    } catch (err) {
      logger.warn({ err, dir }, 'skill-detail: failed to list files')
    }

    return reply.code(200).send(success({
      id: managementSkillId(skill),
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      order: skill.order,
      scope: skill.scope ?? 'project',
      dir,
      content,
      files,
    }))
  })

  // ── 删除技能（按定义层删除目录 + 版本备份）────────────────────────────────
  fastify.delete<{ Params: { name: string }; Querystring: { path?: string; scope?: SkillScope } }>('/skills/:name', async (request, reply) => {
    const name = request.params.name
    let projectRoot: string | undefined
    let scope: SkillRouteScope
    try { projectRoot = workspaceQuery(request); scope = skillScopeQuery(request) } catch (error) { return reply.code(200).send(fail(40001, (error as Error).message)) }
    skillsRegistry.ensureGlobalLayer()
    const skill = managementSkills(projectRoot, scope).find((s) => matchesSkill(s, name))
    if (!skill) {
      return reply.code(200).send(fail(40400, `技能 "${name}" 不存在`))
    }

    const skillDir = path.dirname(skill.skillMdPath)

    // 路径安全：目录必须位于项目层或全局层 skills root 之内，防止任意目录删除
    const allowedRoots = [...projectSkillRoots(projectRoot ?? process.cwd()), workspaceSkillsRoot(projectRoot, 'project'), skillsRegistry.globalRootPath, skillsRegistry.builtinRootPath].filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    )
    const isUnderAllowedRoot = allowedRoots.some((root) => {
      const rel = path.relative(root, skillDir)
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
    })
    if (!isUnderAllowedRoot) {
      logger.warn({ skillDir, allowedRoots }, 'skill-delete: directory outside allowed roots, rejected')
      return reply.code(200).send(fail(40001, '非法的技能目录，拒绝删除'))
    }

    try {
      const remove = (): void => {
        // Delete only the selected physical copy; older same-name project
        // copies remain intact and are excluded by the canonical marker.
        fs.rmSync(skillDir, { recursive: true, force: true })
        const versionsDir = path.join(path.dirname(skillDir), '.versions', path.basename(skillDir))
        fs.rmSync(versionsDir, { recursive: true, force: true })
      }
      if (projectSkillRoots(projectRoot ?? process.cwd()).includes(path.dirname(skillDir))) {
        withProjectSkillDeletion(projectRoot ?? process.cwd(), skill.name, remove)
      } else remove()
    } catch (err: any) {
      logger.error({ err, skillDir }, 'skill-delete: failed to remove directory')
      return reply.code(200).send(fail(50000, `删除失败：${err instanceof Error ? err.message : String(err)}`))
    }

    skillsRegistry.reload()
    logger.info({ name: skill.name, dir: skillDir, scope: skill.scope }, 'skill deleted')
    return reply.code(200).send(success(true, `技能 "${skill.name}" 已删除`))
  })

  fastify.patch<{ Params: { name: string }; Querystring: { path?: string; scope?: SkillScope }; Body: { enabled?: boolean } }>('/skills/:name', async (request, reply) => {
    if (typeof request.body?.enabled !== 'boolean') return reply.code(200).send(fail(40001, 'enabled 必须为布尔值'))
    let projectRoot: string | undefined
    let scope: SkillRouteScope
    try { projectRoot = workspaceQuery(request); scope = skillScopeQuery(request) } catch (error) { return reply.code(200).send(fail(40001, (error as Error).message)) }
    skillsRegistry.ensureGlobalLayer()
    const skill = managementSkills(projectRoot, scope).find((entry) => matchesSkill(entry, request.params.name))
    if (!skill) return reply.code(200).send(fail(40400, `技能 "${request.params.name}" 不存在`))
    const skillDir = path.dirname(skill.skillMdPath)
    const projectRoots = projectSkillRoots(projectRoot ?? process.cwd())
    const sourceRoot = [...projectRoots, workspaceSkillsRoot(projectRoot, 'project'), skillsRegistry.globalRootPath, skillsRegistry.builtinRootPath].find((candidate) => candidate && path.dirname(skillDir) === path.resolve(candidate))
    const root = sourceRoot && projectRoots.includes(sourceRoot) ? projectDataPath(projectRoot ?? process.cwd(), 'skills') : sourceRoot
    if (!root) return reply.code(200).send(fail(40001, '非法的技能目录，拒绝更新'))
    const configPath = path.join(root, 'skills.config.json')
    try {
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('skills.config.json 必须为 JSON 对象')
      const defaults = config.defaults ?? {}
      if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('skills.config.json defaults 必须为 JSON 对象')
      const dirName = path.basename(skillDir)
      config.defaults = { ...defaults, [dirName]: { ...defaults[dirName], enabled: request.body.enabled } }
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      const temporary = `${configPath}.${randomUUID()}.tmp`
      try {
        fs.writeFileSync(temporary, JSON.stringify(config, null, 2), 'utf8')
        fs.renameSync(temporary, configPath)
      } finally {
        fs.rmSync(temporary, { force: true })
      }
      skillsRegistry.reload()
      return reply.code(200).send(success({ name: skill.name, enabled: request.body.enabled }))
    } catch (error) {
      return reply.code(200).send(fail(50000, `更新失败：${error instanceof Error ? error.message : String(error)}`))
    }
  })

  // ── 手动创建技能（表单直建，无需压缩包）────────────────────────────────────
  fastify.post<{ Body: Record<string, unknown> }>('/skills', async (request, reply) => {
    const result = CreateSkillSchema.safeParse(request.body)
    if (!result.success) {
      const firstError = result.error.errors[0]
      return reply.code(200).send(fail(40001, `参数验证失败：${firstError.message}`))
    }
    const { name, description, content, scope, overwrite, projectRoot: requestedRoot } = result.data

    let projectRoot: string | undefined
    try { projectRoot = parseProjectRoot(requestedRoot) } catch (error) { return reply.code(200).send(fail(40001, (error as Error).message)) }
    const root = workspaceSkillsRoot(projectRoot, scope)
    const skillDir = path.join(root, name)

    try {
      if (fs.existsSync(skillDir)) {
        if (!overwrite) {
          return reply.code(200).send(fail(40900, `技能 "${name}" 已存在于${scope === 'global' ? '全局层' : '项目层'}，可选择覆盖`))
        }
        // 覆盖前备份现有目录（与导入管线的版本化策略一致：<root>/.versions/<name>/<ts>）
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const backupDir = path.join(root, '.versions', name, ts)
        fs.mkdirSync(path.dirname(backupDir), { recursive: true })
        fs.renameSync(skillDir, backupDir)
      }

      fs.mkdirSync(skillDir, { recursive: true })
      // description 单行化，防止 frontmatter 注入
      const desc = description.replace(/\r?\n/g, ' ').trim()
      const md = `---\nname: ${name}\ndescription: ${desc}\n---\n\n${content.trim()}\n`
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), md, 'utf-8')
    } catch (err: any) {
      logger.error({ err, skillDir }, 'skill-create: failed to write')
      return reply.code(200).send(fail(50000, `创建失败：${err instanceof Error ? err.message : String(err)}`))
    }

    skillsRegistry.ensureGlobalLayer()
    skillsRegistry.reload()
    logger.info({ name, scope, dir: skillDir }, 'skill created manually')
    return reply.code(200).send(success({ name, scope, dir: skillDir }, `技能 "${name}" 创建成功`))
  })

  // ── 直传导入（≤5MB）────────────────────────────────────────────────────────
  fastify.post<{ Body: Record<string, unknown> }>('/skills/imports', async (request, reply) => {
    const file = await (request as any).file()
    if (!file) return reply.code(200).send(fail(41010, '缺少上传文件（multipart 字段名 file）'))

    const { tenantId, userId } = getAuth(request)
    const strategy = parseStrategy(file.fields?.conflictStrategy?.value)
    const scope = parseScope(file.fields?.scope?.value)
    let projectRoot: string | undefined
    try { projectRoot = parseProjectRoot(file.fields?.projectRoot?.value) } catch (error) { return reply.code(200).send(fail(40001, (error as Error).message)) }
    projectRoot = canonicalProjectRoot(projectRoot, scope)
    const buffer = await file.toBuffer()

    if (buffer.length === 0) return reply.code(200).send(fail(41010, '上传文件为空'))
    if (buffer.length > MAX_PACKAGE_SIZE) {
      return reply.code(200).send(fail(41011, `上传文件超过大小限制（${Math.round(MAX_PACKAGE_SIZE / 1024 / 1024)}MB）`))
    }
    if (buffer.length > DIRECT_UPLOAD_LIMIT) {
      return reply.code(200).send(
        fail(41011, `文件超过直传上限（5MB），请使用分片上传接口 /skills/imports/chunks`),
      )
    }

    const filename = String(file.fields?.filename?.value ?? file.filename ?? 'skill.zip')
    const skillName = file.fields?.skillName?.value ? String(file.fields.skillName.value) : undefined
    const importId = randomUUID()
    await skillImportStore.create({ id: importId, tenantId, userId, filename, fileSize: buffer.length, conflictStrategy: strategy, scope, projectRoot, fileSha256: createHash('sha256').update(buffer).digest('hex') })

    importProjectRoots.set(importId, projectRoot)
    executeImport(importId, buffer, filename, strategy, scope, skillName, projectRoot)
    logger.info({ importId, filename, size: buffer.length, tenantId, scope }, 'skill-import: direct upload accepted')
    return reply.code(200).send(success({ importId, mode: 'direct', chunkSize: CHUNK_SIZE, maxPackageSize: MAX_PACKAGE_SIZE }, '上传成功，导入处理中'))
  })

  // ── 分片上传（幂等，可重传/续传）────────────────────────────────────────────
  fastify.post('/skills/imports/chunks', async (request, reply) => {
    const file = await (request as any).file()
    if (!file) return reply.code(200).send(fail(41010, '缺少分片数据（multipart 字段名 file）'))

    const fields = file.fields ?? {}
    const filename = String(fields.filename?.value ?? 'skill.zip')
    const totalSize = Number(fields.totalSize?.value ?? 0)
    const totalChunks = Number(fields.totalChunks?.value ?? 0)
    const chunkIndex = Number(fields.chunkIndex?.value ?? -1)
    const importIdRaw = fields.importId?.value ? String(fields.importId.value) : ''
    let projectRoot: string | undefined
    try { projectRoot = parseProjectRoot(fields.projectRoot?.value) } catch (error) { return reply.code(200).send(fail(40001, (error as Error).message)) }
    const scope = parseScope(fields.scope?.value)
    projectRoot = canonicalProjectRoot(projectRoot, scope)
    let fileSha256: string
    try { fileSha256 = parseContentHash(fields.fileSha256?.value) } catch (error) { return reply.code(200).send(fail(41010, (error as Error).message)) }

    if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || !Number.isSafeInteger(totalChunks) || totalChunks <= 0 || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      return reply.code(200).send(fail(41010, '缺少 totalSize/totalChunks/chunkIndex 字段'))
    }
    if (totalChunks !== Math.ceil(totalSize / CHUNK_SIZE)) {
      return reply.code(200).send(fail(41010, `totalChunks 不匹配（应为 ${Math.ceil(totalSize / CHUNK_SIZE)}）`))
    }
    if (importIdRaw && !/^[A-Za-z0-9_-]{1,128}$/.test(importIdRaw)) {
      return reply.code(200).send(fail(41010, '非法的导入会话标识'))
    }
    if (totalSize > MAX_PACKAGE_SIZE) {
      return reply.code(200).send(fail(41011, `压缩包超过大小限制（${Math.round(MAX_PACKAGE_SIZE / 1024 / 1024)}MB）`))
    }
    if (chunkIndex >= totalChunks) {
      return reply.code(200).send(fail(41010, `chunkIndex 越界（${chunkIndex} >= totalChunks ${totalChunks}）`))
    }

    // 续传：优先显式 importId；否则按（租户+文件名+大小）找回未完成会话
    const { tenantId, userId } = getAuth(request)
    let importId = importIdRaw
    let rec = importId ? await skillImportStore.get(importId) : null
    if (!rec) {
      const resumable = await skillImportStore.findResumable(tenantId, filename, totalSize, { fileSha256, scope, projectRoot })
      if (resumable) {
        importId = resumable.id
        rec = resumable
      }
    }
    if (!rec) {
      if (!importId) importId = randomUUID()
      rec = await skillImportStore.create({
        id: importId, tenantId, userId, filename, fileSize: totalSize,
        conflictStrategy: parseStrategy(fields.conflictStrategy?.value),
        scope,
        projectRoot,
        fileSha256,
      })
    }
    if (rec.tenantId !== tenantId) return reply.code(200).send(fail(41015, '无权访问该导入会话'))
    if (rec.status !== 'pending' && rec.status !== 'uploading') {
      return reply.code(200).send(fail(41014, `导入会话已处于终态（${rec.status}），请重新发起上传`))
    }

    const buffer = await file.toBuffer()
    const expectedChunkSize = Math.min(CHUNK_SIZE, totalSize - chunkIndex * CHUNK_SIZE)
    if (expectedChunkSize <= 0 || buffer.length !== expectedChunkSize) {
      return reply.code(200).send(fail(41010, `分片大小不匹配（应为 ${expectedChunkSize} 字节，实际 ${buffer.length} 字节）`))
    }
    // 分片落盘（幂等：重传直接覆盖）
    let dir: string
    try { dir = chunkDir(importId) } catch (error) { return reply.code(200).send(fail(41010, (error as Error).message)) }
    fs.writeFileSync(path.join(dir, `chunk-${String(chunkIndex).padStart(6, '0')}`), buffer)

    const uploadedChunks = await skillImportStore.appendChunk(importId, chunkIndex)
    if (rec.status === 'pending') {
      await skillImportStore.update(importId, { status: 'uploading', stage: '分片上传中' })
    }
    importProjectRoots.set(importId, projectRoot ?? importProjectRoots.get(importId))
    return reply.code(200).send(success({
      importId, chunkIndex, uploadedChunks, totalChunks,
      completed: uploadedChunks.length === totalChunks,
    }))
  })

  // ── 分片位图查询（断点续传）────────────────────────────────────────────────
  fastify.get<{ Querystring: { filename?: string; totalSize?: string; importId?: string; fileSha256?: string; scope?: string; projectRoot?: string } }>(
    '/skills/imports/chunks',
    async (request, reply) => {
      const { tenantId } = getAuth(request)
      const { filename, totalSize, importId } = request.query
      let rec = null as Awaited<ReturnType<typeof skillImportStore.get>>
      if (importId) rec = await skillImportStore.get(importId)
      else if (filename && totalSize && request.query.fileSha256) {
        try {
          rec = await skillImportStore.findResumable(tenantId, filename, Number(totalSize), {
            fileSha256: parseContentHash(request.query.fileSha256),
            scope: parseScope(request.query.scope),
            projectRoot: parseProjectRoot(request.query.projectRoot),
          })
        } catch (error) {
          return reply.code(200).send(fail(41010, (error as Error).message))
        }
      }
      if (!rec || rec.tenantId !== tenantId) {
        return reply.code(200).send(success({ importId: null, uploadedChunks: [], totalChunks: 0 }))
      }
      return reply.code(200).send(success({
        importId: rec.id,
        uploadedChunks: rec.uploadedChunks,
        totalChunks: Math.ceil(rec.fileSize / CHUNK_SIZE),
        status: rec.status,
      }))
    },
  )

  // ── 分片合并 → 触发导入 ────────────────────────────────────────────────────
  fastify.post<{ Body: { importId?: string; projectRoot?: string } }>('/skills/imports/chunks/merge', async (request, reply) => {
    const { importId } = request.body ?? {}
    if (!importId) return reply.code(200).send(fail(41010, '缺少 importId'))

    const { tenantId } = getAuth(request)
    const rec = await skillImportStore.get(importId)
    if (!rec || rec.tenantId !== tenantId) return reply.code(200).send(fail(41014, '导入会话不存在'))
    if (rec.status !== 'pending' && rec.status !== 'uploading') {
      return reply.code(200).send(fail(41014, `导入会话状态异常（${rec.status}）`))
    }

    const totalChunks = Math.ceil(rec.fileSize / CHUNK_SIZE)
    if (rec.uploadedChunks.length !== totalChunks) {
      return reply.code(200).send(fail(41014, `分片不完整（${rec.uploadedChunks.length}/${totalChunks}），请补传缺失分片`))
    }

    await skillImportStore.update(importId, { status: 'merging', stage: '合并分片' })
    let dir: string
    try { dir = chunkDir(importId) } catch (error) {
      await skillImportStore.update(importId, { status: 'failed', stage: '合并失败', errorCode: '41010', errorMessage: (error as Error).message })
      return reply.code(200).send(fail(41010, (error as Error).message))
    }
    const parts: Buffer[] = []
    for (let i = 0; i < totalChunks; i++) {
      const p = path.join(dir, `chunk-${String(i).padStart(6, '0')}`)
      if (!fs.existsSync(p)) {
        await skillImportStore.update(importId, { status: 'uploading', stage: '等待缺失分片' })
        return reply.code(200).send(fail(41014, `分片文件缺失（chunk ${i}），请重传该分片`))
      }
      parts.push(fs.readFileSync(p))
    }
    const zipBuffer = Buffer.concat(parts)
    if (zipBuffer.length !== rec.fileSize || zipBuffer.length > MAX_PACKAGE_SIZE) {
      await skillImportStore.update(importId, { status: 'failed', stage: '合并失败', errorCode: String(41011), errorMessage: '合并文件大小不符合声明' })
      fs.rmSync(dir, { recursive: true, force: true })
      return reply.code(200).send(fail(41011, '合并文件大小不符合声明'))
    }
    const mergedHash = createHash('sha256').update(zipBuffer).digest('hex')
    if (rec.fileSha256 && rec.fileSha256 !== mergedHash) {
      await skillImportStore.update(importId, { status: 'failed', stage: '合并失败', errorCode: String(41010), errorMessage: '合并文件哈希校验失败' })
      fs.rmSync(dir, { recursive: true, force: true })
      return reply.code(200).send(fail(41010, '合并文件哈希校验失败'))
    }

    // 合并完成即清理分片暂存（管线失败也不重用分片，重新上传即可）
    fs.rmSync(dir, { recursive: true, force: true })

    let projectRoot: string | undefined
    try { projectRoot = parseProjectRoot(request.body?.projectRoot) ?? (rec.projectRoot || undefined) ?? importProjectRoots.get(importId) } catch (error) {
      await skillImportStore.update(importId, { status: 'failed', stage: '合并失败', errorCode: '40001', errorMessage: (error as Error).message })
      return reply.code(200).send(fail(40001, (error as Error).message))
    }
    executeImport(importId, zipBuffer, rec.filename, rec.conflictStrategy, rec.scope, undefined, projectRoot)
    logger.info({ importId, filename: rec.filename, size: zipBuffer.length }, 'skill-import: chunks merged, import started')
    importProjectRoots.delete(importId)
    return reply.code(200).send(success({ importId, mode: 'chunked' }, '分片合并完成，导入处理中'))
  })

  // ── 状态查询 ────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/skills/imports/:id', async (request, reply) => {
    const { tenantId } = getAuth(request)
    const rec = await skillImportStore.get(request.params.id)
    if (!rec || rec.tenantId !== tenantId) return reply.code(200).send(fail(41014, '导入记录不存在'))
    return reply.code(200).send(success(toDto(rec)))
  })

  // ── 导入历史 ────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { limit?: string; scope?: string; projectRoot?: string } }>('/skills/imports', async (request, reply) => {
    const { tenantId } = getAuth(request)
    const limit = Math.min(Number(request.query.limit ?? 20) || 20, 100)
    let projectRoot: string | undefined
    try { projectRoot = parseProjectRoot(request.query.projectRoot) } catch (error) { return reply.code(200).send(fail(40001, (error as Error).message)) }
    const scope = request.query.scope === 'global' ? 'global' : request.query.scope === 'project' ? 'project' : undefined
    const list = await skillImportStore.list(tenantId, limit, { scope, projectRoot: projectRoot ?? (scope ? '' : undefined) })
    return reply.code(200).send(success(list.map(toDto)))
  })

  // ── 取消导入 ────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/skills/imports/:id', async (request, reply) => {
    const { tenantId } = getAuth(request)
    const rec = await skillImportStore.get(request.params.id)
    if (!rec || rec.tenantId !== tenantId) return reply.code(200).send(fail(41014, '导入记录不存在'))
    if (skillImportStore.isTerminal(rec.status)) {
      return reply.code(200).send(success({ importId: rec.id, status: rec.status }, '导入已处于终态，无需取消'))
    }
    cancelFlags.set(rec.id, true)
    await skillImportStore.update(rec.id, { status: 'cancelled', stage: '已取消' })
    // 清理分片暂存
    fs.rmSync(path.join(skillImportsRoot(), rec.id), { recursive: true, force: true })
    logger.info({ importId: rec.id }, 'skill-import: cancelled')
    return reply.code(200).send(success({ importId: rec.id, status: 'cancelled' }, '导入已取消'))
  })
}
