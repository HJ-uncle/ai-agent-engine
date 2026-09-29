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
    Body: { filePath: string; content?: string; adapters?: string[]; sessionId?: string; useCache?: boolean }
  }>('/lsp/diagnose', async (request, reply) => {
    const { filePath, content, adapters, sessionId, useCache } = request.body ?? ({} as any)
    if (!filePath) return reply.code(200).send(fail(40000, '缺少 filePath'))

    const tenantId = (request as any).authContext?.tenantId
    // 若给了 sessionId，用 workspace 目录做相对路径解析
    let abs = filePath
    if (!path.isAbsolute(filePath) && sessionId) {
      try {
        const ctx: any = { tenantId, sessionId }
        const cwd = workspaceManager.init(ctx)
        abs = path.resolve(cwd, filePath)
      } catch {
        abs = path.resolve(filePath)
      }
    } else if (!path.isAbsolute(filePath)) {
      abs = path.resolve(filePath)
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
      })
      return reply.code(200).send(success(result))
    } finally {
      request.raw.removeListener('aborted', abort)
      reply.raw.removeListener('close', onClose)
    }
  })

  // 清理过期缓存
  fastify.delete<{ Querystring: { days?: number } }>('/lsp/cache', async (request, reply) => {
    const days = Math.max(1, parseInt(String(request.query.days ?? 7), 10))
    const removed = await purgeLspCache(days)
    return reply.code(200).send(success({ removed, days }))
  })
}
