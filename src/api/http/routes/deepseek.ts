/**
 * DeepSeek 专有通道接口路由
 * ============================================================================
 * - POST /api/v1/deepseek/fim       Fill-in-Middle 代码补全
 * - POST /api/v1/deepseek/json      强制 JSON 模式 chat（demo / 工具集成用途）
 * - POST /api/v1/deepseek/prefix    Chat Prefix Completion 续写
 * - GET  /api/v1/deepseek/status    返回当前是否启用 DeepSeek 通道及配置
 * - GET  /api/v1/deepseek/prices    返回当前有效价格配置（含折扣状态）
 * - PUT  /api/v1/deepseek/prices    持久化用户自定义价格配置
 * - GET  /api/v1/deepseek/balance   代理查询 DeepSeek 账户余额
 * - GET  /api/v1/deepseek/models    代理拉取 DeepSeek 可用模型列表（5 分钟缓存）
 */
import type { FastifyInstance } from 'fastify'
import { success, fail } from '../response.js'
import { systemConfigStore } from '../../../storage/sqlite/system-config.js'
import { DeepSeekAdapter } from '../../../core/llm-adapter/index.js'
import {
  loadPricesConfig,
  savePricesConfig,
  getPriceForModel,
  DEFAULT_PRICES_CONFIG,
  type DeepSeekPricesConfig,
} from '../../../core/deepseek/pricing.js'

// ── 模型列表内存缓存（5 分钟） ────────────────────────────────────────────────
const BUILT_IN_MODELS = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro']
let modelsCache: { data: string[]; expiry: number } | null = null

async function buildAdapter(): Promise<DeepSeekAdapter> {
  const [apiKey, baseUrl, model, autoThinking, defaultJson] = await Promise.all([
    systemConfigStore.get('DEEPSEEK_API_KEY'),
    systemConfigStore.get('DEEPSEEK_BASE_URL'),
    systemConfigStore.get('LLM_PRIMARY_MODEL'),
    systemConfigStore.get('DEEPSEEK_AUTO_THINKING'),
    systemConfigStore.get('DEEPSEEK_DEFAULT_JSON_MODE'),
  ])

  const finalKey = apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY
  if (!finalKey) throw new Error('DeepSeek API Key 未配置，请在设置 → DeepSeek 中填写')

  return new DeepSeekAdapter(
    model || 'deepseek-chat',
    finalKey,
    baseUrl || 'https://api.deepseek.com',
    {
      autoThinking: autoThinking !== 'false',
      defaultJsonMode: defaultJson === 'true',
    },
  )
}

export async function deepseekRoutes(fastify: FastifyInstance) {
  // ── 状态探针 ─────────────────────────────────────────────────────────
  fastify.get('/deepseek/status', async (_req, reply) => {
    const [apiKey, baseUrl, model] = await Promise.all([
      systemConfigStore.get('DEEPSEEK_API_KEY'),
      systemConfigStore.get('DEEPSEEK_BASE_URL'),
      systemConfigStore.get('LLM_PRIMARY_MODEL'),
    ])
    const finalKey = apiKey || process.env.DEEPSEEK_API_KEY
    return reply.code(200).send(success({
      enabled: Boolean(finalKey),
      hasApiKey: Boolean(finalKey),
      baseUrl: baseUrl || 'https://api.deepseek.com',
      currentModel: model || 'deepseek-chat',
      isReasoner: DeepSeekAdapter.isReasoner(model || 'deepseek-chat'),
      features: {
        kvCache:        '上下文硬盘缓存 (KV Cache)',
        thinkingMode:   'R1 / V3 思考模式 (reasoning_content)',
        jsonMode:       '严格 JSON 输出 (response_format=json_object)',
        prefixCompletion: 'Chat Prefix Completion (β)',
        fimCompletion:  'Fill-in-Middle 代码补全 (β)',
        streamUsage:    '流式 usage 指标 (stream_options.include_usage)',
        toolCalls:      'Function Calling',
      },
    }))
  })

  // ── FIM Completion ─────────────────────────────────────────────────
  fastify.post<{ Body: { prompt: string; suffix: string; maxTokens?: number; model?: string } }>(
    '/deepseek/fim',
    async (req, reply) => {
      const { prompt, suffix, maxTokens, model } = req.body ?? ({} as any)
      if (!prompt || typeof prompt !== 'string') return reply.code(200).send(fail(40001, 'prompt 必填'))
      if (typeof suffix !== 'string') return reply.code(200).send(fail(40001, 'suffix 必填（可为空字符串）'))
      try {
        const adapter = await buildAdapter()
        const result = await adapter.fimComplete({ prompt, suffix, maxTokens, model })
        return reply.code(200).send(success(result))
      } catch (err) {
        return reply.code(200).send(fail(50001, err instanceof Error ? err.message : '调用失败'))
      }
    },
  )

  // ── 强制 JSON Mode 一次性问答 ──────────────────────────────────────
  fastify.post<{ Body: { prompt: string; systemPrompt?: string; model?: string } }>(
    '/deepseek/json',
    async (req, reply) => {
      const { prompt, systemPrompt, model } = req.body ?? ({} as any)
      if (!prompt) return reply.code(200).send(fail(40001, 'prompt 必填'))
      try {
        const adapter = await buildAdapter()
        const resp = await adapter.complete(
          [{ role: 'user', content: prompt, createdAt: Date.now() } as any],
          {
            model: model ?? adapter.model,
            systemPrompt: systemPrompt ?? '请严格输出 JSON，不要包含任何额外解释。',
            responseFormat: 'json',
          },
        )
        let parsed: any = null
        try { parsed = JSON.parse(resp.content) } catch { /* keep raw */ }
        return reply.code(200).send(success({
          raw: resp.content,
          parsed,
          usage: {
            promptTokens: resp.promptTokens,
            completionTokens: resp.completionTokens,
            cacheHitTokens: resp.cacheHitTokens ?? 0,
            cacheMissTokens: resp.cacheMissTokens ?? 0,
            reasoningTokens: resp.reasoningTokens ?? 0,
          },
        }))
      } catch (err) {
        return reply.code(200).send(fail(50001, err instanceof Error ? err.message : '调用失败'))
      }
    },
  )

  // ── Chat Prefix Completion ─────────────────────────────────────────
  fastify.post<{ Body: { prompt: string; prefix: string; systemPrompt?: string; model?: string } }>(
    '/deepseek/prefix',
    async (req, reply) => {
      const { prompt, prefix, systemPrompt, model } = req.body ?? ({} as any)
      if (!prompt) return reply.code(200).send(fail(40001, 'prompt 必填'))
      if (typeof prefix !== 'string') return reply.code(200).send(fail(40001, 'prefix 必填'))
      try {
        const adapter = await buildAdapter()
        const resp = await adapter.complete(
          [{ role: 'user', content: prompt, createdAt: Date.now() } as any],
          {
            model: model ?? adapter.model,
            systemPrompt,
            prefix,
          },
        )
        return reply.code(200).send(success({
          content: prefix + resp.content,
          continuation: resp.content,
          usage: {
            promptTokens: resp.promptTokens,
            completionTokens: resp.completionTokens,
            cacheHitTokens: resp.cacheHitTokens ?? 0,
            cacheMissTokens: resp.cacheMissTokens ?? 0,
          },
        }))
      } catch (err) {
        return reply.code(200).send(fail(50001, err instanceof Error ? err.message : '调用失败'))
      }
    },
  )

  // ── 价格配置读取 ────────────────────────────────────────────────────
  fastify.get('/deepseek/prices', async (_req, reply) => {
    const config = loadPricesConfig()
    const now = new Date()
    // 附加每个模型的当前有效价格
    const modelsWithEffective = config.models.map((m) => ({
      ...m,
      effectivePrice: getPriceForModel(m.modelId, config, now),
    }))
    return reply.code(200).send(success({ ...config, models: modelsWithEffective }))
  })

  // ── 价格配置持久化 ──────────────────────────────────────────────────
  fastify.put<{ Body: DeepSeekPricesConfig }>(
    '/deepseek/prices',
    async (req, reply) => {
      const body = req.body
      if (!body || !Array.isArray(body.models)) {
        return reply.code(200).send(fail(40001, '请求体格式错误，需要包含 models 数组'))
      }
      try {
        savePricesConfig(body)
        const saved = loadPricesConfig()
        return reply.code(200).send(success(saved))
      } catch (err) {
        return reply.code(200).send(fail(50001, err instanceof Error ? err.message : '保存失败'))
      }
    },
  )

  // ── 余额查询代理 ────────────────────────────────────────────────────
  fastify.get('/deepseek/balance', async (_req, reply) => {
    // Key 优先级：DEEPSEEK_API_KEY（专用） → OPENAI_API_KEY（通用，DeepSeek 兼容 OpenAI 格式）
    const apiKey =
      (await systemConfigStore.get('DEEPSEEK_API_KEY')) ||
      process.env.DEEPSEEK_API_KEY ||
      (await systemConfigStore.get('OPENAI_API_KEY')) ||
      process.env.OPENAI_API_KEY
    if (!apiKey) {
      return reply.code(200).send(fail(40003, '未配置 API Key，请在"模型"设置页填写 OpenAI API Key'))
    }
    // Base URL 优先级：DEEPSEEK_BASE_URL → OPENAI_BASE_URL → 官方默认
    const baseUrl =
      (await systemConfigStore.get('DEEPSEEK_BASE_URL')) ||
      process.env.DEEPSEEK_BASE_URL ||
      (await systemConfigStore.get('OPENAI_BASE_URL')) ||
      process.env.OPENAI_BASE_URL ||
      'https://api.deepseek.com'

    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/user/balance`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) {
        return reply.code(200).send(fail(resp.status, `DeepSeek API 返回 ${resp.status}`))
      }
      const json = (await resp.json()) as any
      // DeepSeek 余额 API 格式: { is_available: bool, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}] }
      const info = json?.balance_infos?.[0] ?? {}
      const balance = parseFloat(info.total_balance ?? '0')
      const config = loadPricesConfig()
      const threshold = config.lowBalanceThreshold ?? 10
      return reply.code(200).send(
        success({
          balance,
          currency: info.currency ?? 'CNY',
          isAvailable: json?.is_available ?? true,
          lowBalance: balance < threshold,
          lowBalanceThreshold: threshold,
          updatedAt: new Date().toISOString(),
          raw: json,
        }),
      )
    } catch (err) {
      return reply.code(200).send(fail(50001, err instanceof Error ? err.message : '查询余额失败'))
    }
  })

  // ── 模型列表代理（5 分钟缓存）───────────────────────────────────────
  fastify.get('/deepseek/models', async (_req, reply) => {
    const now = Date.now()
    if (modelsCache && now < modelsCache.expiry) {
      return reply.code(200).send(success({ models: modelsCache.data, fallback: false, cached: true }))
    }

    const apiKey =
      (await systemConfigStore.get('DEEPSEEK_API_KEY')) ||
      process.env.DEEPSEEK_API_KEY ||
      (await systemConfigStore.get('OPENAI_API_KEY')) ||
      process.env.OPENAI_API_KEY
    const baseUrl =
      (await systemConfigStore.get('DEEPSEEK_BASE_URL')) ||
      process.env.DEEPSEEK_BASE_URL ||
      (await systemConfigStore.get('OPENAI_BASE_URL')) ||
      process.env.OPENAI_BASE_URL ||
      'https://api.deepseek.com'

    if (!apiKey) {
      return reply.code(200).send(success({ models: BUILT_IN_MODELS, fallback: true, reason: 'API Key 未配置' }))
    }

    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = (await resp.json()) as any
      const ids: string[] = (json?.data ?? []).map((m: any) => m.id as string).filter(Boolean)
      if (ids.length === 0) throw new Error('空列表')
      modelsCache = { data: ids, expiry: now + 5 * 60 * 1000 }
      return reply.code(200).send(success({ models: ids, fallback: false, cached: false }))
    } catch (err) {
      // 降级：返回内置列表
      return reply.code(200).send(
        success({
          models: BUILT_IN_MODELS,
          fallback: true,
          reason: err instanceof Error ? err.message : '拉取失败',
        }),
      )
    }
  })
}
