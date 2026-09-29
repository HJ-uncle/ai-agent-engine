/**
 * Flow 执行路由
 *
 * 端点：
 * - POST /flows/run   提交 Flow 定义，SSE 流式返回执行事件
 * - POST /flows/:runId/stop  停止正在执行的 Flow
 *
 * 遵循引擎统一响应：HTTP 200 + JSON body，业务状态由 code 字段决定。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { success, fail } from '../../response.js'
import { logger } from '../../../../observability/index.js'
import { sseStream } from '../../../../core/stream-pipeline/index.js'
import { busToIterable } from '../../../../core/stream-pipeline/stream-bus.js'
import { FlowEventBus } from './flow-event-bus.js'
import { FlowExecutor, topologicalLevels } from './flow-executor.js'
import { getRequestToolProfile } from '../../tool-profile.js'
import type { RunFlowOptions } from './flow-types.js'

/** 活跃 Flow 运行注册表（runId → FlowEventBus + AbortController） */
const activeFlows = new Map<string, { bus: FlowEventBus; abortController: AbortController }>()

export async function flowRoutes(fastify: FastifyInstance): Promise<void> {
  // ── POST /flows/run ────────────────────────────────────────────────
  fastify.post<{ Body: RunFlowOptions }>('/flows/run', {
    schema: {
      body: {
        type: 'object',
        required: ['flowId', 'nodes', 'edges'],
        properties: {
          flowId: { type: 'string' },
          flowName: { type: 'string' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['nodeId', 'label', 'nodeType'],
              properties: {
                nodeId: { type: 'string' },
                label: { type: 'string' },
                nodeType: { type: 'string' },
                prompt: { type: 'string' },
                systemPrompt: { type: 'string' },
                activeSkillIds: { type: 'array', items: { type: 'string' } },
                activeMcpServerIds: { type: 'array', items: { type: 'string' } },
                knowledgeBases: { type: 'array', items: { type: 'string' } },
                model: { type: 'string' },
                agentId: { type: 'string' },
                upstreamNodeIds: { type: 'array', items: { type: 'string' } },
                config: { type: 'object' }
              }
            }
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'source', 'target'],
              properties: {
                id: { type: 'string' },
                source: { type: 'string' },
                target: { type: 'string' }
              }
            }
          },
          userInput: { type: 'string' },
          cwd: { type: 'string' },
          executionMode: { type: 'string' },
          securityMode: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: RunFlowOptions }>, reply: FastifyReply) => {
    const toolProfile = getRequestToolProfile(request)
    const body = request.body
    const tenantId = (request as any).tenantId ?? 'flow-tenant'

    // 校验 Flow 定义（环检测在 topologicalLevels 内抛错，这里提前做一次结构校验）
    if (!body.nodes || body.nodes.length === 0) {
      return reply.code(200).send(fail(40000, 'Flow nodes 为空'))
    }
    if (!body.edges) {
      return reply.code(200).send(fail(40000, 'Flow edges 缺失'))
    }

    // 提前做环检测，避免开流后才报错
    try {
      topologicalLevels(body.nodes, body.edges)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(200).send(fail(40000, `Flow 定义非法：${message}`))
    }

    const abortController = new AbortController()
    const bus = new FlowEventBus(body.flowId, abortController)
    activeFlows.set(bus.runId, { bus, abortController })

    logger.info({ flowId: body.flowId, runId: bus.runId, tenantId }, '[Flow] 收到执行请求，启动 SSE')

    // 异步启动执行器（不阻塞 SSE 响应）
    const executor = new FlowExecutor(bus, abortController.signal, toolProfile)
    executor.run(body).catch((err) => {
      logger.error({ err, runId: bus.runId }, '[Flow] 执行器异常')
      bus.error(err)
    })

    // SSE 流式返回
    try {
      await sseStream(busToIterable(bus.streamBus), reply)
    } finally {
      activeFlows.delete(bus.runId)
    }
  })

  // ── POST /flows/:runId/stop ────────────────────────────────────────
  fastify.post<{ Params: { runId: string } }>('/flows/:runId/stop', async (request, reply) => {
    const { runId } = request.params
    const entry = activeFlows.get(runId)
    if (!entry) {
      return reply.code(200).send(success({ runId, cancelled: false }, 'Flow 不存在或已结束'))
    }
    entry.abortController.abort()
    logger.info({ runId }, '[Flow] 收到停止请求')
    return reply.code(200).send(success({ runId, cancelled: true }, '已发送取消信号'))
  })
}
