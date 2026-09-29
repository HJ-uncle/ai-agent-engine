/**
 * 轻任务 LLM 调用路由
 * ============================================================================
 * POST /api/v1/utility/chat — 一次性非流式问答，供「提交信息生成 / 输入润色」等
 * 辅助功能使用：不走会话、不写历史、没有工具，拿结果即走。
 *
 * 模型解析与主对话/子代理同一套规则：
 *   1. body.model（前端设置里的「轻任务模型」，modelId）在 ModelsStore 里 → 复用其凭据
 *   2. ModelsStore 查不到 → 只传模型名，凭据走 system_config / env
 *   3. 未指定 model → 全默认（引擎默认模型）
 */
import type { FastifyInstance } from 'fastify'
import { success, fail } from '../response.js'
import { createLLMAdapterWithDbConfig } from '../../../core/llm-adapter/index.js'
import { ModelsStore } from '../../../storage/sqlite/models.js'
import { logger } from '../../../observability/index.js'

interface UtilityChatBody {
  model?: string
  systemPrompt?: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
}

export async function utilityRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: UtilityChatBody }>('/utility/chat', {
    schema: {
      body: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          systemPrompt: { type: 'string' },
          userPrompt: { type: 'string' },
          temperature: { type: 'number' },
          maxTokens: { type: 'integer' }
        },
        required: ['userPrompt']
      }
    }
  }, async (req, reply) => {
    const { model, systemPrompt, userPrompt, temperature = 0.3, maxTokens = 2000 } = req.body ?? {}
    if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
      return reply.code(200).send(fail(40001, 'userPrompt 必填'))
    }

    try {
      const requested = model?.trim() || undefined
      let adapter
      if (requested) {
        try {
          const info = (await new ModelsStore().getModels('default')).find(
            (m) => m.modelId === requested
          )
          if (info?.apiKey) {
            adapter = await createLLMAdapterWithDbConfig({
              model: info.modelId,
              apiKey: info.apiKey,
              baseUrl: info.baseUrl,
              provider: info.provider
            })
          } else {
            adapter = await createLLMAdapterWithDbConfig({ model: requested })
          }
        } catch (err) {
          logger.warn({ err, model: requested }, '[utility/chat] 模型解析失败，回退默认配置')
          adapter = await createLLMAdapterWithDbConfig({})
        }
      } else {
        adapter = await createLLMAdapterWithDbConfig({})
      }

      const messages: Array<{ role: string; content: string }> = []
      if (systemPrompt?.trim()) messages.push({ role: 'system', content: systemPrompt })
      messages.push({ role: 'user', content: userPrompt })

      const response = await adapter.complete(messages as any, { model: requested ?? '', temperature, maxTokens })
      const text = (response.content || '').trim()
      return reply.code(200).send(success({ text }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err }, '[utility/chat] 调用失败')
      return reply.code(200).send(fail(50001, message))
    }
  })
}
