import { OpenAIAdapter } from './openai.js'
import { AnthropicAdapter } from './anthropic.js'
import { OllamaAdapter } from './ollama.js'
import { DeepSeekAdapter, type DeepSeekAdapterOptions } from './deepseek.js'
import { QwenAdapter, type QwenAdapterOptions } from './qwen.js'
import { RetryingAdapter, FallbackAdapter } from './retry.js'
import type { LLMAdapter } from './types.js'
import { systemConfigStore } from '../../storage/sqlite/system-config.js'

export interface CreateAdapterOptions {
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  /** 显式指定模型能力，优先级最高 */
  capabilities?: {
    vision?: boolean
    thinking?: boolean
  }
  /** DeepSeek 专有选项；仅在路由到 DeepSeek 通道时生效 */
  deepseek?: DeepSeekAdapterOptions
  /** Qwen 专有选项；仅在路由到 Qwen 通道时生效 */
  qwen?: QwenAdapterOptions
}

/**
 * 自动判定是否应当走 DeepSeek 专有通道：
 *   1. provider === 'deepseek'  → 强制
 *   2. 模型名包含 deepseek      → 自动
 *   3. baseUrl 命中 deepseek    → 自动
 */
function shouldUseDeepSeek(provider: string, model: string, baseUrl?: string): boolean {
  if (provider === 'deepseek') return true
  return DeepSeekAdapter.detect(model, baseUrl)
}

/**
 * 自动判定是否应当走 Qwen 专有通道：
 *   1. provider === 'qwen'      → 强制
 *   2. 模型名包含 qwen / qwq    → 自动
 *   3. baseUrl 命中 dashscope   → 自动
 */
function shouldUseQwen(provider: string, model: string, baseUrl?: string): boolean {
  if (provider === 'qwen') return true
  return QwenAdapter.detect(model, baseUrl)
}

function createBaseAdapter(provider: string, model: string, options?: CreateAdapterOptions): LLMAdapter {
  // DeepSeek 自动路由（最高优先级，避免 qwen 误判）
  if (shouldUseDeepSeek(provider, model, options?.baseUrl)) {
    return new DeepSeekAdapter(model, options?.apiKey, options?.baseUrl, options?.deepseek)
  }

  // Qwen 自动路由
  if (shouldUseQwen(provider, model, options?.baseUrl)) {
    return new QwenAdapter(model, options?.apiKey, options?.baseUrl, options?.qwen)
  }

  switch (provider) {
    case 'openai':
      return new OpenAIAdapter(model, options?.apiKey, options?.baseUrl, options?.capabilities?.vision)
    case 'anthropic':
      return new AnthropicAdapter(model, options?.apiKey, options?.baseUrl)
    case 'ollama':
      return new OllamaAdapter(model, options?.baseUrl)
    case 'custom':
      return new OpenAIAdapter(model, options?.apiKey, options?.baseUrl, options?.capabilities?.vision)
    default:
      // 未知 provider 不直接 throw，降级为 OpenAI-compatible，避免整个请求崩溃
      // （用户可能配置了引擎尚未枚举的新 provider 名，如 "baichuan"、"mistral" 等）
      return new OpenAIAdapter(model, options?.apiKey, options?.baseUrl, options?.capabilities?.vision)
  }
}

export function createLLMAdapter(overrides?: CreateAdapterOptions): LLMAdapter {
  const provider = overrides?.provider ?? process.env.LLM_PROVIDER ?? 'openai'
  const primaryModel = overrides?.model ?? process.env.LLM_PRIMARY_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini'
  const fallbackModel = process.env.LLM_FALLBACK_MODEL

  const primary = new RetryingAdapter(createBaseAdapter(provider, primaryModel, overrides))

  if (fallbackModel) {
    // Use same provider for fallback (can be extended later)
    const fallback = createBaseAdapter(provider, fallbackModel, overrides)
    return new FallbackAdapter({ primary, fallbacks: [fallback] })
  }

  return primary
}

/**
 * 异步工厂：优先从数据库 system_config 读取 LLM 默认配置，
 * 回退到 process.env，最后使用 hardcoded 默认值。
 * overrides 优先级最高，可覆盖任意字段。
 *
 * DeepSeek 通道自动启用规则：
 *   - 模型名匹配 deepseek*
 *   - 或 baseUrl 命中 deepseek
 *   - 或 LLM_PROVIDER 显式设为 deepseek
 *
 * Qwen 通道自动启用规则：
 *   - 模型名匹配 qwen* / qwq*
 *   - 或 baseUrl 命中 dashscope / aliyuncs
 *   - 或 LLM_PROVIDER 显式设为 qwen
 * 命中后优先使用数据库中的 DASHSCOPE_API_KEY / QWEN_BASE_URL（如未提供 overrides）
 */
export async function createLLMAdapterWithDbConfig(overrides?: CreateAdapterOptions): Promise<LLMAdapter> {
  const [
    dbProvider, dbModel, dbApiKey, dbBaseUrl,
    dsApiKey, dsBaseUrl,
    dsAutoThinking, dsThinkingEffort, dsDefaultJson, dsIncludeUsage, dsLogCache,
    anthropicApiKey, anthropicBaseUrl,
    qwenApiKey, qwenBaseUrl,
    qwenAutoThinking, qwenEnableSearch, qwenIncludeUsage, qwenLogUsage,
  ] = await Promise.all([
    systemConfigStore.get('LLM_PROVIDER'),
    systemConfigStore.get('LLM_PRIMARY_MODEL'),
    systemConfigStore.get('OPENAI_API_KEY'),
    systemConfigStore.get('OPENAI_BASE_URL'),
    systemConfigStore.get('DEEPSEEK_API_KEY'),
    systemConfigStore.get('DEEPSEEK_BASE_URL'),
    systemConfigStore.get('DEEPSEEK_AUTO_THINKING'),
    systemConfigStore.get('DEEPSEEK_THINKING_EFFORT'),
    systemConfigStore.get('DEEPSEEK_DEFAULT_JSON_MODE'),
    systemConfigStore.get('DEEPSEEK_INCLUDE_STREAM_USAGE'),
    systemConfigStore.get('DEEPSEEK_LOG_CACHE_HITS'),
    systemConfigStore.get('ANTHROPIC_API_KEY'),
    systemConfigStore.get('ANTHROPIC_BASE_URL'),
    systemConfigStore.get('DASHSCOPE_API_KEY'),
    systemConfigStore.get('QWEN_BASE_URL'),
    systemConfigStore.get('QWEN_AUTO_THINKING'),
    systemConfigStore.get('QWEN_ENABLE_SEARCH'),
    systemConfigStore.get('QWEN_INCLUDE_STREAM_USAGE'),
    systemConfigStore.get('QWEN_LOG_USAGE'),
  ])

  const provider = overrides?.provider ?? dbProvider ?? process.env.LLM_PROVIDER ?? 'openai'
  const model    = overrides?.model    ?? dbModel    ?? process.env.LLM_PRIMARY_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini'

  // ── DeepSeek 通道自动检测 + 专有凭据优先 ─────────────────────────────────
  const isDs = shouldUseDeepSeek(provider, model, overrides?.baseUrl ?? dbBaseUrl ?? process.env.OPENAI_BASE_URL)
  // ── Qwen 通道自动检测 ─────────────────────────────────────────────────────
  const isQwen = !isDs && shouldUseQwen(provider, model, overrides?.baseUrl ?? dbBaseUrl ?? process.env.OPENAI_BASE_URL)
  // ── Anthropic 通道检测 ────────────────────────────────────────────────────
  const isAnthropic = !isDs && !isQwen && (provider === 'anthropic' || /claude/i.test(model))

  const apiKey = overrides?.apiKey
    ?? (isDs   ? (dsApiKey   ?? process.env.DEEPSEEK_API_KEY)  : null)
    ?? (isQwen ? (qwenApiKey ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY) : null)
    ?? (isAnthropic ? (anthropicApiKey ?? process.env.ANTHROPIC_API_KEY) : null)
    ?? dbApiKey
    ?? process.env.OPENAI_API_KEY
  const baseUrl = overrides?.baseUrl
    ?? (isDs   ? (dsBaseUrl   ?? process.env.DEEPSEEK_BASE_URL) : null)
    ?? (isQwen ? (qwenBaseUrl ?? process.env.QWEN_BASE_URL)     : null)
    ?? (isAnthropic ? (anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL) : null)
    ?? dbBaseUrl
    ?? process.env.OPENAI_BASE_URL

  const fallbackModel = process.env.LLM_FALLBACK_MODEL

  const deepseekOptions: DeepSeekAdapterOptions = {
    autoThinking:        dsAutoThinking == null ? true  : dsAutoThinking !== 'false',
    thinkingEffort:     (dsThinkingEffort as any) ?? 'medium',
    defaultJsonMode:     dsDefaultJson === 'true',
    includeStreamUsage:  dsIncludeUsage == null ? true  : dsIncludeUsage !== 'false',
    logCacheHits:        dsLogCache == null     ? true  : dsLogCache !== 'false',
    ...(overrides?.deepseek ?? {}),
  }

  const qwenOptions: QwenAdapterOptions = {
    autoThinking:       qwenAutoThinking == null ? true  : qwenAutoThinking !== 'false',
    enableSearch:       qwenEnableSearch === 'true',
    includeStreamUsage: qwenIncludeUsage == null ? true  : qwenIncludeUsage !== 'false',
    logUsage:           qwenLogUsage === 'true',
    ...(overrides?.qwen ?? {}),
  }

  const effectiveOptions: CreateAdapterOptions = { provider, model, apiKey, baseUrl, deepseek: deepseekOptions, qwen: qwenOptions }
  const primary = new RetryingAdapter(createBaseAdapter(provider, model, effectiveOptions))

  if (fallbackModel) {
    const fallback = createBaseAdapter(provider, fallbackModel, effectiveOptions)
    return new FallbackAdapter({ primary, fallbacks: [fallback] })
  }

  return primary
}
