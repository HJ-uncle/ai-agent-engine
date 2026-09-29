import { OpenAIAdapter } from './openai.js'
import { AnthropicAdapter } from './anthropic.js'
import { OllamaAdapter } from './ollama.js'
import { DeepSeekAdapter, type DeepSeekAdapterOptions } from './deepseek.js'
import { QwenAdapter, type QwenAdapterOptions } from './qwen.js'
import { RetryingAdapter, FallbackAdapter } from './retry.js'
import type { LLMAdapter } from './types.js'
import { systemConfigStore } from '../../storage/sqlite/system-config.js'
import { declaresAnthropicProtocol, usesNativeOllama } from './protocol.js'
import { resolveCapabilities } from '../model-capabilities/index.js'

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
  /** 透传给上游 LLM 请求的自定义 HTTP 头，adapter 通过 SDK defaultHeaders 携带 */
  extraHeaders?: Record<string, string>
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

/**
 * 端点是否显式声明了 Anthropic 协议（如 DeepSeek / 阿里百炼等提供的
 * `…/anthropic` 兼容端点）。显式声明优先于模型名推断 ——
 * 「DeepSeek 模型 + Anthropic 网关」不应被模型名劫持到 DeepSeek 适配器。
 */
function createBaseAdapter(provider: string, model: string, options?: CreateAdapterOptions): LLMAdapter {
  const eh = options?.extraHeaders
  // Anthropic 协议端点显式声明优先：模型名不参与判断，避免被劫持到 DeepSeek/Qwen 适配器
  if (provider === 'anthropic' || declaresAnthropicProtocol(options?.baseUrl)) {
    return new AnthropicAdapter(model, options?.apiKey, options?.baseUrl, eh)
  }

  // A local qwen/deepseek model still uses Ollama's native /api/chat protocol.
  if (usesNativeOllama(provider, options?.baseUrl)) {
    return new OllamaAdapter(model, options?.baseUrl)
  }

  // DeepSeek 自动路由（最高优先级，避免 qwen 误判）
  if (shouldUseDeepSeek(provider, model, options?.baseUrl)) {
    return new DeepSeekAdapter(model, options?.apiKey, options?.baseUrl, options?.deepseek, eh)
  }

  // Qwen 自动路由
  if (shouldUseQwen(provider, model, options?.baseUrl)) {
    return new QwenAdapter(model, options?.apiKey, options?.baseUrl, options?.qwen, eh)
  }

  switch (provider) {
    case 'openai':
      return new OpenAIAdapter(model, options?.apiKey, options?.baseUrl, options?.capabilities?.vision, eh)
    case 'anthropic':
      return new AnthropicAdapter(model, options?.apiKey, options?.baseUrl, eh)
    case 'ollama':
      return new OllamaAdapter(model, options?.baseUrl)
    case 'custom':
      return new OpenAIAdapter(model, options?.apiKey, options?.baseUrl, options?.capabilities?.vision, eh)
    default:
      return new OpenAIAdapter(model, options?.apiKey, options?.baseUrl, options?.capabilities?.vision, eh)
  }
}

export function createLLMAdapter(overrides?: CreateAdapterOptions): LLMAdapter {
  const provider = (overrides?.provider ?? process.env.LLM_PROVIDER ?? 'openai').toLowerCase()
  const primaryModel = overrides?.model ?? process.env.LLM_PRIMARY_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini'
  const fallbackModel = process.env.LLM_FALLBACK_MODEL

  const primary = new RetryingAdapter(createBaseAdapter(provider, primaryModel, overrides))

  if (fallbackModel?.trim() && fallbackModel.trim() !== primaryModel) {
    // Use same provider for fallback (can be extended later)
    const model = fallbackModel.trim()
    const fallback = createBaseAdapter(provider, model, overrides)
    const contextWindow = resolveCapabilities({ model, provider, baseUrl: overrides?.baseUrl }).contextWindow
    return new FallbackAdapter({ primary, fallbacks: [fallback],
      modelContextWindows: contextWindow ? { [model]: contextWindow } : undefined })
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
export async function resolveAdapterOptionsWithDbConfig(overrides?: CreateAdapterOptions): Promise<CreateAdapterOptions> {
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

  const provider = (overrides?.provider ?? dbProvider ?? process.env.LLM_PROVIDER ?? 'openai').toLowerCase()
  const model    = overrides?.model    ?? dbModel    ?? process.env.LLM_PRIMARY_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini'

  // ── Anthropic 协议端点（baseUrl 显式声明）优先：凭证与路由都按 Anthropic 走 ──
  const effectiveBaseUrl = overrides?.baseUrl ?? dbBaseUrl ?? process.env.OPENAI_BASE_URL
  const isAnthropicEndpoint = provider === 'anthropic' || declaresAnthropicProtocol(effectiveBaseUrl)
  const isOllama = usesNativeOllama(provider, effectiveBaseUrl)
  // ── DeepSeek 通道自动检测 + 专有凭据优先 ─────────────────────────────────
  const isDs = !isAnthropicEndpoint && !isOllama && shouldUseDeepSeek(provider, model, effectiveBaseUrl)
  // ── Qwen 通道自动检测 ─────────────────────────────────────────────────────
  const isQwen = !isAnthropicEndpoint && !isOllama && !isDs && shouldUseQwen(provider, model, effectiveBaseUrl)
  // ── Anthropic 通道检测 ────────────────────────────────────────────────────
  const isAnthropic = isAnthropicEndpoint || (!isOllama && !isDs && !isQwen && /claude/i.test(model))

  const apiKey = overrides?.apiKey
    ?? (isDs   ? (dsApiKey   ?? process.env.DEEPSEEK_API_KEY)  : null)
    ?? (isQwen ? (qwenApiKey ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY) : null)
    ?? (isAnthropic ? (anthropicApiKey ?? process.env.ANTHROPIC_API_KEY) : null)
    ?? dbApiKey
    ?? process.env.OPENAI_API_KEY
  const baseUrl = overrides?.baseUrl
    ?? (isOllama ? (dbBaseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434') : null)
    ?? (isDs   ? (dsBaseUrl   ?? process.env.DEEPSEEK_BASE_URL) : null)
    ?? (isQwen ? (qwenBaseUrl ?? process.env.QWEN_BASE_URL)     : null)
    ?? (isAnthropic ? (anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL) : null)
    ?? dbBaseUrl
    ?? process.env.OPENAI_BASE_URL

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

  return { provider, model, apiKey, baseUrl, capabilities: overrides?.capabilities, deepseek: deepseekOptions, qwen: qwenOptions, extraHeaders: overrides?.extraHeaders }
}

export async function createLLMAdapterWithDbConfig(overrides?: CreateAdapterOptions): Promise<LLMAdapter> {
  return createLLMAdapter(await resolveAdapterOptionsWithDbConfig(overrides))
}
