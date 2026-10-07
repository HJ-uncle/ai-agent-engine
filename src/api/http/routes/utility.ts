/**
 * 轻任务 LLM 调用路由
 * ============================================================================
 * POST /api/v1/utility/chat — 一次性非流式问答，供「提交信息生成 / 输入润色」等
 * 辅助功能使用：不走会话、不写历史、没有工具，拿结果即走。
 *
 * 模型解析与主对话/子代理同一套规则：按请求 tenant 查启用模型，
 * 未指定 model 时使用该租户的默认配置，凭据再回退到 system_config / env。
 */
import type { FastifyInstance } from 'fastify'
import { success, fail } from '../response.js'
import { createAdapterFromResolved, resolveModelConfig } from '../../../core/llm-adapter/resolve-model.js'
import { logger } from '../../../observability/index.js'

interface UtilityChatBody {
  model?: string
  systemPrompt?: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
}

function getTenantId(req: unknown): string {
  return (req as { authContext?: { tenantId?: string } }).authContext?.tenantId ?? 'default'
}

/**
 * V4 Flash/Pro and reasoner models spend part of the completion budget on
 * hidden reasoning. Utility actions need a short visible answer; with the
 * old 200-token request the provider could consume the entire budget before
 * emitting `content`, which looked like a successful but empty response.
 */
function isDeepSeekReasoningModel(model: string, provider: string): boolean {
  if (!/deepseek/i.test(provider) && !/deepseek/i.test(model)) return false
  return /deepseek-(?:reasoner|r1)|deepseek-v\d+(?:\.\d+)?-(?:flash|pro)/i.test(model)
}

/**
 * AIGW-compatible switches for one-shot utility calls.  Omitting these fields
 * is not equivalent to disabling thinking: the gateway defaults some V4/Qwen
 * models to thinking mode and may spend the entire completion budget in
 * `reasoning_content`, leaving `message.content` empty.  Keep the fields out
 * for ordinary OpenAI-compatible models because unknown parameters can cause
 * a 400 response there.
 */
function utilityThinkingConfig(model: string, provider: string, baseUrl?: string): Record<string, unknown> | null {
  // Anthropic-compatible endpoints have their own thinking schema.  Do not
  // send OpenAI/AIGW-only fields there even when the model id contains
  // "deepseek" or "qwen".
  if (/\/anthropic(?:\/|$)/i.test(baseUrl ?? '')) return null
  const isQwen = /qwen/i.test(provider) || /(?:^|[/:])qwen(?:\d|[-/]|$)/i.test(model.trim())
  if (!isDeepSeekReasoningModel(model, provider) && !isQwen) return null
  return {
    enable_thinking: false,
    reasoning_effort: isQwen ? 'none' : 'low'
  }
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
      const tenantId = getTenantId(req)
      let resolvedModel
      try {
        // Keep utility calls on the same tenant-aware model/capability resolution path
        // as the main chat. This also avoids passing an empty model override below.
        resolvedModel = await resolveModelConfig({ tenantId, model: requested })
      } catch (err) {
        logger.warn({ err, model: requested, tenantId }, '[utility/chat] 模型解析失败，回退默认配置')
        resolvedModel = await resolveModelConfig({ tenantId })
      }
      const adapter = createAdapterFromResolved(resolvedModel)
      const utilityThinking = utilityThinkingConfig(resolvedModel.model, resolvedModel.provider, resolvedModel.baseUrl)
      const isReasoningModel = Boolean(resolvedModel.capabilities?.thinking)
        || isDeepSeekReasoningModel(resolvedModel.model, resolvedModel.provider)
        || /(?:^|[/:])qwen(?:3|[-/])|qwq/i.test(resolvedModel.model)
      // Thinking tokens count toward max_tokens on the gateway even at low effort.
      // Keep enough reserve for a short visible result instead of returning a
      // successful envelope with an empty text field.
      // Wuzu uses a 10k ceiling for this exact class of request; retaining that
      // reserve matters when an Anthropic-compatible gateway hides the model's
      // reasoning behind content blocks and does not accept OpenAI switches.
      const effectiveMaxTokens = isReasoningModel ? Math.max(maxTokens, 10000) : maxTokens

      // Keep the system instruction in adapter options. Anthropic-compatible
      // adapters cannot represent a system role inside `messages`; putting it
      // there would downgrade it to historical user text and change the
      // provider request semantics.
      const messages: Array<{ role: string; content: string }> = [{ role: 'user', content: userPrompt }]

      const response = await adapter.complete(messages as any, {
        model: resolvedModel.model,
        ...(systemPrompt?.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
        temperature,
        maxTokens: effectiveMaxTokens,
        // Utility responses are shown directly in an editor field.  Explicitly
        // disable hidden reasoning for AIGW/DeepSeek/Qwen families so a small
        // output budget is reserved for visible text.  Keep the response field
        // disabled: reasoning text must never be shown as the generated value.
        ...(utilityThinking ? { thinkingConfig: utilityThinking, responseThinkingField: null } : {}),
      })
      const text = (response.content || '').trim()
      if (!text) {
        logger.warn({
          model: resolvedModel.model,
          provider: resolvedModel.provider,
          finishReason: response.finishReason,
          completionTokens: response.completionTokens,
          reasoningTokens: response.reasoningTokens,
          hasReasoningContent: Boolean(response.reasoningContent?.trim()),
        }, '[utility/chat] 上游返回空可见内容')
        return reply.code(200).send(fail(50201, '模型返回内容为空'))
      }
      return reply.code(200).send(success({ text }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err }, '[utility/chat] 调用失败')
      return reply.code(200).send(fail(50001, message))
    }
  })
}
