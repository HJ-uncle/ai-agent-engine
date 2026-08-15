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
import { createHash, randomUUID } from 'node:crypto'
import { success, fail } from '../response.js'
import { requireRoles, SKILL_IMPORT_ROLES } from '../../../auth/index.js'
import { skillImportStore } from '../../../storage/skill-import/index.js'
import {
  runSkillImport,
  SkillImportError,
  DIRECT_UPLOAD_LIMIT,
  resolveSkillsRoot,
} from '../../../skills/import-pipeline.js'
import type { ConflictStrategy } from '../../../skills/import-pipeline.js'
import { skillsRegistry } from '../../../skills/skills-registry.js'
import { logger } from '../../../observability/index.js'

const CHUNK_SIZE = 2 * 1024 * 1024 // 分片目标大小（前端切分参考，后端不强制）
const MAX_PACKAGE_SIZE = parseInt(process.env.SKILL_IMPORT_MAX_MB ?? '20', 10) * 1024 * 1024
const CONFLICT_STRATEGIES: ConflictStrategy[] = ['reject', 'overwrite', 'versioned']

// 进行中导入的取消标志（进程内）
const cancelFlags = new Map<string, boolean>()

function getAuth(request: FastifyRequest): { tenantId: string; userId?: string } {
  const ctx = (request as any).authContext
  return { tenantId: ctx?.tenantId ?? 'default', userId: ctx?.userId }
}

function parseStrategy(raw: unknown): ConflictStrategy {
  return CONFLICT_STRATEGIES.includes(raw as ConflictStrategy) ? (raw as ConflictStrategy) : 'versioned'
}

/** 分片暂存目录 */
function chunkDir(importId: string): string {
  const base = path.resolve(process.env.DATA_DIR ?? './data', 'skill-imports', importId)
  fs.mkdirSync(base, { recursive: true })
  return base
}

/**
 * 异步执行导入管线并回写状态。
 * 返回值：立即（不等待管线完成）。
 */
function executeImport(importId: string, zipBuffer: Buffer, filename: string, strategy: ConflictStrategy) {
  const sha256 = createHash('sha256').update(zipBuffer).digest('hex')
  void skillImportStore
    .update(importId, { status: 'validating', stage: '校验压缩包格式', progress: 5, fileSha256: sha256 })
    .then(() => {
      const summary = runSkillImport({
        importId,
        zipBuffer,
        filename,
        conflictStrategy: strategy,
        isCancelled: () => cancelFlags.get(importId) === true,
        onProgress: (p) => {
          const status = p.progress >= 55 ? 'extracting' : 'validating'
          void skillImportStore.update(importId, { progress: p.progress, stage: p.stage, status })
        },
      })
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
    .finally(() => cancelFlags.delete(importId))
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
  fastify.get('/skills', async (_request, reply) => {
    const list = skillsRegistry.getSkills()
    return reply.code(200).send(success({
      root: resolveSkillsRoot(),
      list: list.map((s) => ({
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        order: s.order,
      })),
    }))
  })

  // ── 直传导入（≤5MB）────────────────────────────────────────────────────────
  fastify.post<{ Body: Record<string, unknown> }>('/skills/imports', async (request, reply) => {
    const file = await (request as any).file()
    if (!file) return reply.code(200).send(fail(41010, '缺少上传文件（multipart 字段名 file）'))

    const { tenantId, userId } = getAuth(request)
    const strategy = parseStrategy(file.fields?.conflictStrategy?.value)
    const buffer = await file.toBuffer()

    if (buffer.length === 0) return reply.code(200).send(fail(41010, '上传文件为空'))
    if (buffer.length > MAX_PACKAGE_SIZE) {
      return reply.code(200).send(fail(41011, `压缩包超过大小限制（${Math.round(MAX_PACKAGE_SIZE / 1024 / 1024)}MB）`))
    }
    if (buffer.length > DIRECT_UPLOAD_LIMIT) {
      return reply.code(200).send(
        fail(41011, `文件超过直传上限（5MB），请使用分片上传接口 /skills/imports/chunks`),
      )
    }

    const filename = String(file.fields?.filename?.value ?? file.filename ?? 'skill.zip')
    const importId = randomUUID()
    await skillImportStore.create({ id: importId, tenantId, userId, filename, fileSize: buffer.length, conflictStrategy: strategy })

    executeImport(importId, buffer, filename, strategy)
    logger.info({ importId, filename, size: buffer.length, tenantId }, 'skill-import: direct upload accepted')
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

    if (!totalSize || !totalChunks || chunkIndex < 0) {
      return reply.code(200).send(fail(41010, '缺少 totalSize/totalChunks/chunkIndex 字段'))
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
      const resumable = await skillImportStore.findResumable(tenantId, filename, totalSize)
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
      })
    }
    if (rec.tenantId !== tenantId) return reply.code(200).send(fail(41015, '无权访问该导入会话'))
    if (rec.status !== 'pending' && rec.status !== 'uploading') {
      return reply.code(200).send(fail(41014, `导入会话已处于终态（${rec.status}），请重新发起上传`))
    }

    const buffer = await file.toBuffer()
    // 分片落盘（幂等：重传直接覆盖）
    const dir = chunkDir(importId)
    fs.writeFileSync(path.join(dir, `chunk-${String(chunkIndex).padStart(6, '0')}`), buffer)

    const uploadedChunks = await skillImportStore.appendChunk(importId, chunkIndex)
    if (rec.status === 'pending') {
      await skillImportStore.update(importId, { status: 'uploading', stage: '分片上传中' })
    }
    return reply.code(200).send(success({
      importId, chunkIndex, uploadedChunks, totalChunks,
      completed: uploadedChunks.length === totalChunks,
    }))
  })

  // ── 分片位图查询（断点续传）────────────────────────────────────────────────
  fastify.get<{ Querystring: { filename?: string; totalSize?: string; importId?: string } }>(
    '/skills/imports/chunks',
    async (request, reply) => {
      const { tenantId } = getAuth(request)
      const { filename, totalSize, importId } = request.query
      let rec = null as Awaited<ReturnType<typeof skillImportStore.get>>
      if (importId) rec = await skillImportStore.get(importId)
      else if (filename && totalSize) rec = await skillImportStore.findResumable(tenantId, filename, Number(totalSize))
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
  fastify.post<{ Body: { importId?: string } }>('/skills/imports/chunks/merge', async (request, reply) => {
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
    const dir = chunkDir(importId)
    const parts: Buffer[] = []
    for (let i = 0; i < totalChunks; i++) {
      const p = path.join(dir, `chunk-${String(i).padStart(6, '0')}`)
      if (!fs.existsSync(p)) {
        return reply.code(200).send(fail(41014, `分片文件缺失（chunk ${i}），请重传该分片`))
      }
      parts.push(fs.readFileSync(p))
    }
    const zipBuffer = Buffer.concat(parts)

    // 合并完成即清理分片暂存（管线失败也不重用分片，重新上传即可）
    fs.rmSync(dir, { recursive: true, force: true })

    executeImport(importId, zipBuffer, rec.filename, rec.conflictStrategy)
    logger.info({ importId, filename: rec.filename, size: zipBuffer.length }, 'skill-import: chunks merged, import started')
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
  fastify.get<{ Querystring: { limit?: string } }>('/skills/imports', async (request, reply) => {
    const { tenantId } = getAuth(request)
    const limit = Math.min(Number(request.query.limit ?? 20) || 20, 100)
    const list = await skillImportStore.list(tenantId, limit)
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
    fs.rmSync(path.resolve(process.env.DATA_DIR ?? './data', 'skill-imports', rec.id), { recursive: true, force: true })
    logger.info({ importId: rec.id }, 'skill-import: cancelled')
    return reply.code(200).send(success({ importId: rec.id, status: 'cancelled' }, '导入已取消'))
  })
}
