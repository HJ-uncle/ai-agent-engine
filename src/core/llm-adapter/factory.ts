import { OpenAIAdapter } from './openai.js'
import { AnthropicAdapter } from './anthropic.js'
import { OllamaAdapter } from './ollama.js'
import { RetryingAdapter, FallbackAdapter } from './retry.js'
import type { LLMAdapter } from './types.js'

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
  console.log('>>> createLLMAdapter env:', { 
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, 
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'SET' : 'UNSET',
    provider,
    primaryModel
  })

  const primary = new RetryingAdapter(createBaseAdapter(provider, primaryModel, overrides))

  if (fallbackModel) {
    // Use same provider for fallback (can be extended later)
    const fallback = createBaseAdapter(provider, fallbackModel, overrides)
    return new FallbackAdapter({ primary, fallbacks: [fallback] })
  }

  return primary
}
