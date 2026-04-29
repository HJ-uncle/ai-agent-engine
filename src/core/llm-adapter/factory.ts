import { OpenAIAdapter } from './openai.js'
import { AnthropicAdapter } from './anthropic.js'
import { OllamaAdapter } from './ollama.js'
import { RetryingAdapter, FallbackAdapter } from './retry.js'
import type { LLMAdapter } from './types.js'
import { systemConfigStore } from '../../storage/sqlite/system-config.js'

export interface CreateAdapterOptions {
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
}

function createBaseAdapter(provider: string, model: string, options?: CreateAdapterOptions): LLMAdapter {
  switch (provider) {
    case 'openai':
      return new OpenAIAdapter(model, options?.apiKey, options?.baseUrl)
    case 'anthropic':
      return new AnthropicAdapter(model, options?.apiKey, options?.baseUrl)
    case 'ollama':
      return new OllamaAdapter(model, options?.baseUrl)
    case 'custom':
      // 'custom' maps to OpenAI-compatible
      return new OpenAIAdapter(model, options?.apiKey, options?.baseUrl)
    default:
      throw new Error(`Unknown LLM provider: ${provider}`)
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
 */
export async function createLLMAdapterWithDbConfig(overrides?: CreateAdapterOptions): Promise<LLMAdapter> {
  const [dbProvider, dbModel, dbApiKey, dbBaseUrl] = await Promise.all([
    systemConfigStore.get('LLM_PROVIDER'),
    systemConfigStore.get('LLM_PRIMARY_MODEL'),
    systemConfigStore.get('OPENAI_API_KEY'),
    systemConfigStore.get('OPENAI_BASE_URL'),
  ])

  const provider = overrides?.provider ?? dbProvider ?? process.env.LLM_PROVIDER ?? 'openai'
  const model    = overrides?.model    ?? dbModel    ?? process.env.LLM_PRIMARY_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini'
  const apiKey   = overrides?.apiKey   ?? dbApiKey   ?? process.env.OPENAI_API_KEY
  const baseUrl  = overrides?.baseUrl  ?? dbBaseUrl  ?? process.env.OPENAI_BASE_URL

  const fallbackModel = process.env.LLM_FALLBACK_MODEL

  const effectiveOptions: CreateAdapterOptions = { provider, model, apiKey, baseUrl }
  const primary = new RetryingAdapter(createBaseAdapter(provider, model, effectiveOptions))

  if (fallbackModel) {
    const fallback = createBaseAdapter(provider, fallbackModel, effectiveOptions)
    return new FallbackAdapter({ primary, fallbacks: [fallback] })
  }

  return primary
}
