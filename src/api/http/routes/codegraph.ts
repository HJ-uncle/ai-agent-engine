import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { success, fail } from '../response.js'
import { workspaceManager } from '../../../workspace/index.js'
import {
  startIndexing,
  getIndexRunState,
  isIndexRunning,
} from '../../../tools/codegraph/index.js'
import { loadCodeGraph } from '../../../tools/codegraph/codegraph-module.js'

/**
 * 代码图路由：产品化「自带 codegraph」的引擎入口。
 * IDE 的「创建代码图索引」按钮与 Agent 工具共用同一条链路
 * （tools/codegraph/index-runner），终端用户无需接触 CLI。
 *
 * 目录解析：workspacePaths 是 chat 请求级参数、引擎不持久化，
 * 因此 IDE 必须把当前项目根（workspace.root）作为 path 传入；
 * 未传时退回会话绑定的默认工作区。
 */

/** 解析目标目录：优先客户端传入的项目根，退回会话默认工作区；校验存在且为目录 */
function resolveTarget(rawPath: string | undefined, sessionId: string | undefined, tenantId: string | undefined): { root?: string; error?: string } {
  let root: string | undefined
  if (rawPath && rawPath.trim()) {
    root = path.resolve(rawPath.trim())
  } else {
    try {
      root = workspaceManager.init({ tenantId, sessionId } as any)
    } catch (e: any) {
      return { error: `无法确定工作区: ${e?.message ?? e}` }
    }
  }
  if (!root) return { error: '无法确定目标目录' }
  try {
    if (!fs.statSync(root).isDirectory()) return { error: `不是目录: ${root}` }
  } catch {
    return { error: `目录不存在: ${root}` }
  }
  return { root }
}

export async function codegraphRoutes(fastify: FastifyInstance) {
  // 索引状态：是否已初始化 + 当前进度/最近一次任务结果 + 统计
  fastify.get<{ Querystring: { sessionId?: string; path?: string } }>('/codegraph/status', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId
    const t = resolveTarget(request.query.path, request.query.sessionId, tenantId)
    if (t.error) return reply.code(200).send(fail(40000, t.error))
    const root = t.root!

    let CodeGraph
    try {
      CodeGraph = await loadCodeGraph()
    } catch (e: any) {
      return reply.code(200).send(success({ root, initialized: false, run: getIndexRunState(), error: e?.message }))
    }

    const initialized = CodeGraph.isInitialized(root)
    let stats: unknown
    if (initialized && !isIndexRunning()) {
      try {
        const cg = CodeGraph.openSync(root)
        try {
          stats = cg.getStats()
        } finally {
          cg.close()
        }
      } catch { /* 统计失败不影响状态返回 */ }
    }
    return reply.code(200).send(success({
      root,
      initialized,
      indexing: isIndexRunning(),
      run: getIndexRunState(),
      stats,
    }))
  })

  // 触发建索引（异步执行，进度用 GET /codegraph/status 轮询）。
  // force=true 时删库重建（recreate 后重新索引），用于设置页的「重建索引」
  fastify.post<{ Body: { sessionId?: string; path?: string; force?: boolean } }>('/codegraph/index', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId
    const { path: rawPath, sessionId, force } = request.body ?? ({} as any)
    const t = resolveTarget(rawPath, sessionId, tenantId)
    if (t.error) return reply.code(200).send(fail(40000, t.error))
    const root = t.root!

    const r = await startIndexing(root, { rebuild: force === true })
    if (!r.started) {
      if (r.alreadyRunning) {
        return reply.code(200).send(success({ started: false, alreadyRunning: true, run: getIndexRunState() }))
      }
      if (r.alreadyInitialized) {
        return reply.code(200).send(success({ started: false, alreadyInitialized: true, root }))
      }
      return reply.code(200).send(fail(50000, r.error ?? '无法创建索引'))
    }
    return reply.code(200).send(success({ started: true, root, rebuild: force === true }))
  })
}
