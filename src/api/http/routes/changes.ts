import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ChangeStore } from '../../../storage/changes/index.js'
import { success, fail } from '../response.js'

/**
 * 文件改动记录路由
 *
 * - GET  /changes?sessionId=&status=   会话改动列表（面板数据源）
 * - POST /changes/:id/keep             确认保留单条改动
 * - POST /changes/:id/revert           撤回单条改动（按快照写回/删除）
 * - POST /changes/keep-all             确认保留会话全部 pending 改动
 */
const store = new ChangeStore()

const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'

export async function changeRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { sessionId?: string; status?: string; createdAfter?: string } }>(
    '/changes', async (req, reply) => {
      const tenantId = getTenantId(req)
      const { sessionId, status, createdAfter } = req.query
      if (!sessionId) return reply.send(fail(40001, 'sessionId 不能为空'))
      const list = await store.list(
        tenantId,
        sessionId,
        (status as any) || undefined,
        createdAfter ? Number(createdAfter) : undefined
      )
      return reply.send(success(list))
    }
  )

  fastify.post<{ Params: { id: string } }>('/changes/:id/keep', async (req, reply) => {
    const tenantId = getTenantId(req)
    const updated = await store.markStatus(req.params.id, tenantId, 'kept')
    if (!updated) return reply.send(fail(40400, 'Change not found'))
    return reply.send(success(updated))
  })

  fastify.post<{ Params: { id: string } }>('/changes/:id/revert', async (req, reply) => {
    const tenantId = getTenantId(req)
    const change = await store.getById(req.params.id, tenantId)
    if (!change) return reply.send(fail(40400, 'Change not found'))
    if (change.status === 'reverted') return reply.send(success(change))
    if (change.truncated) {
      return reply.send(fail(40002, '该改动未保存文件内容（过大或二进制），无法自动撤回'))
    }

    try {
      if (change.kind === 'delete') {
        // 撤回删除 = 按快照重写文件
        fs.mkdirSync(path.dirname(change.path), { recursive: true })
        fs.writeFileSync(change.path, change.oldContent ?? '', 'utf-8')
      } else if (change.oldContent === null) {
        // 撤回新建 = 删除文件
        if (fs.existsSync(change.path)) fs.unlinkSync(change.path)
      } else {
        // 撤回修改 = 写回旧内容
        fs.writeFileSync(change.path, change.oldContent, 'utf-8')
      }
    } catch (err) {
      return reply.send(fail(50000, `撤回失败：${err instanceof Error ? err.message : 'unknown'}`))
    }

    const updated = await store.markStatus(change.id, tenantId, 'reverted')
    return reply.send(success(updated))
  })

  fastify.post<{ Body: { sessionId?: string } }>('/changes/keep-all', async (req, reply) => {
    const tenantId = getTenantId(req)
    const { sessionId } = req.body ?? {}
    if (!sessionId) return reply.send(fail(40001, 'sessionId 不能为空'))
    const count = await store.keepAll(tenantId, sessionId)
    return reply.send(success({ kept: count }))
  })

  // POST /changes/keep-many — 批量确认保留（「暂存」动作的配套：git add 成功后调用）
  fastify.post<{ Body: { sessionId?: string; ids?: string[] } }>('/changes/keep-many', async (req, reply) => {
    const tenantId = getTenantId(req)
    const { ids } = req.body ?? {}
    if (!Array.isArray(ids) || ids.length === 0) return reply.send(fail(40001, 'ids 不能为空'))
    const results = await Promise.all(
      ids.map((id) => store.markStatus(id, tenantId, 'kept').catch(() => null))
    )
    const kept = results.filter(Boolean).length
    return reply.send(success({ kept }))
  })
}
