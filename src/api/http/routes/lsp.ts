import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { success, fail } from '../response.js'
import { diagnoseFile, listLspAdapters, purgeLspCache } from '../../../lsp/index.js'
import { workspaceManager } from '../../../workspace/index.js'

export async function lspRoutes(fastify: FastifyInstance) {
  // 列出已安装的诊断 adapter 及其可用性
  fastify.get('/lsp/adapters', async (_request, reply) => {
    const list = await listLspAdapters()
    return reply.code(200).send(success(list))
  })

  // 对一个文件运行诊断
  fastify.post<{
    Body: { filePath: string; content?: string; adapters?: string[]; sessionId?: string; workspacePaths?: string[]; useCache?: boolean; timeoutMs?: number }
  }>('/lsp/diagnose', async (request, reply) => {
    const { filePath, content, adapters, sessionId, workspacePaths, useCache, timeoutMs } = request.body ?? ({} as any)
    if (!filePath) return reply.code(200).send(fail(40000, '缺少 filePath'))

    const tenantId = (request as any).authContext?.tenantId
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return reply.code(200).send(fail(40000, 'timeoutMs 必须为正数'))
    }
    // A session-bound diagnosis must resolve through the same workspace containment
    // check as file tools; raw path.resolve would permit an absolute escape.
    let abs = filePath
    if (!path.isAbsolute(filePath) && sessionId) {
      try {
        const ctx: any = { tenantId, sessionId, workspacePaths }
        workspaceManager.init(ctx)
        abs = workspaceManager.resolveSafePath(ctx, filePath)
      } catch {
        return reply.code(200).send(fail(40300, '文件路径不在当前工作区内'))
      }
    } else if (!path.isAbsolute(filePath)) {
      if (sessionId) return reply.code(200).send(fail(40300, '文件路径不在当前工作区内'))
      abs = path.resolve(filePath)
    } else if (sessionId) {
      try { abs = workspaceManager.resolveSafePath({ tenantId, sessionId, workspacePaths } as any, filePath) }
      catch { return reply.code(403).send(fail(40300, '文件路径不在当前工作区内')) }
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    const onClose = () => { if (!reply.raw.writableEnded) abort() }
    request.raw.once('aborted', abort)
    reply.raw.once('close', onClose)
    try {
      const result = await diagnoseFile(abs, {
        content, adapters, useCache,
        tenantId, sessionId, signal: controller.signal,
        timeoutMs: timeoutMs === undefined ? undefined : Math.min(Math.floor(timeoutMs), 120_000),
      })
      return reply.code(200).send(success(result))
    } finally {
      request.raw.removeListener('aborted', abort)
      reply.raw.removeListener('close', onClose)
    }
  })

  // 清理过期缓存
  fastify.delete<{ Querystring: { days?: number } }>('/lsp/cache', async (request, reply) => {
    const parsedDays = Number(request.query.days ?? 7)
    if (!Number.isFinite(parsedDays) || !Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 3650) {
      return reply.code(200).send(fail(40000, 'days 必须是 1 到 3650 的整数'))
    }
    const days = parsedDays
    const tenantId = (request as any).authContext?.tenantId
    const removed = await purgeLspCache(days, tenantId)
    return reply.code(200).send(success({ removed, days }))
  })
}
