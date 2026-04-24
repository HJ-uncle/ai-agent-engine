import { OpenAIAdapter } from './openai.js'
import { AnthropicAdapter } from './anthropic.js'
import { OllamaAdapter } from './ollama.js'
import { RetryingAdapter, FallbackAdapter } from './retry.js'
import type { LLMAdapter } from './types.js'

function createBaseAdapter(provider: string, model: string): LLMAdapter {
  switch (provider) {
    case 'openai':
      return new OpenAIAdapter(model)
    case 'anthropic':
      return new AnthropicAdapter(model)
    case 'ollama':
      return new OllamaAdapter(model)
    default:
      throw new Error(`Unknown LLM provider: ${provider}`)
  }
}

export function createLLMAdapter(overrides?: { provider?: string; model?: string }): LLMAdapter {
  const provider = overrides?.provider ?? process.env.LLM_PROVIDER ?? 'openai'
  const primaryModel = overrides?.model ?? process.env.LLM_PRIMARY_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini'
  const fallbackModel = process.env.LLM_FALLBACK_MODEL

  const primary = new RetryingAdapter(createBaseAdapter(provider, primaryModel))

  if (fallbackModel) {
    // Use same provider for fallback (can be extended later)
    const fallback = createBaseAdapter(provider, fallbackModel)
    return new FallbackAdapter({ primary, fallbacks: [fallback] })
  }

  return primary
}
